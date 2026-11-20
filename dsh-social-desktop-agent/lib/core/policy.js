/**
 * Pure policy core for dsh-social-desktop-agent.
 *
 * Every browser / desktop action funnels through this module:
 *
 *   policy.check(action)    -> { ok: true } | { ok: false, code, message }
 *   policy.require(action)  -> true, or throws PolicyError (the enforcing call)
 *
 * `action` is `{ scope, kind, target }`. Scopes are granted exactly (no
 * implicit escalation), hosts/apps must be allowlisted by exact match or an
 * explicit `*.example.com` wildcard, write-type social kinds are permanently
 * denied, rate limiting is a per-scope token bucket, `os.power` additionally
 * requires a one-time confirmation token, and the kill switch overrides
 * everything.
 *
 * `check()` is a dry run: it never consumes a rate token or a confirmation
 * token. `require()` consumes both and is the only call that authorises an
 * effect. Both record one append-only audit line per evaluation.
 *
 * Time is injected (`now`) so the whole core is deterministic under test. This
 * module performs no network or OS access — it only reads the kill-switch file
 * and writes the audit file.
 *
 * Custom wiring beyond the shared contract (all additive):
 *   - `confirm`: an injected confirm gate with `request`/`consume`, or `false`
 *     to force `CONFIRM_REQUIRED` for every `os.power` action. When omitted a
 *     gate is created automatically and exposed as `policy.confirm`, so the
 *     caller can issue tokens without extra plumbing.
 *   - `scopes` may be a function (or a live array/Set) so a human can promote
 *     the grant at runtime; `policy.check()` re-resolves it every call.
 *
 * @module dsh-social-desktop-agent/lib/core/policy
 */

import { domainToASCII } from 'node:url'

import { PolicyError, POLICY_CODES } from './errors.js'
import { SCOPE_ORDER, normalizeScope, resolveScopes } from './scopes.js'
import { createKillSwitch } from './killswitch.js'
import { createConfirmGate } from './confirm.js'

/** Scopes that address a host and therefore need the domain allowlist. */
export const BROWSE_SCOPES = Object.freeze(['browse.read', 'browse.interact'])

/** Default token bucket: 30 requests per minute, counted per scope. */
export const DEFAULT_RATE_LIMIT = Object.freeze({ limit: 30, windowMs: 60_000 })

/** Power operations the plugin may ever perform. Config can narrow, never widen. */
export const DEFAULT_POWER_TARGETS = Object.freeze(['restart', 'shutdown'])

/**
 * Write-type social actions are refused permanently, for every scope, even if
 * a caller misunderstands the scope model. Reading, scrolling and ordinary
 * navigation are not in this list.
 */
export const FORBIDDEN_KINDS = Object.freeze([
  'like',
  'unlike',
  'favorite',
  'favourite',
  'follow',
  'unfollow',
  'dm',
  'direct_message',
  'send_dm',
  'send_message',
  'message',
  'post',
  'create_post',
  'publish',
  'repost',
  'quote',
  'comment',
  'reply',
  'respond',
  'share',
  'retweet',
  'subscribe',
  'unsubscribe',
  'upload',
  'delete',
  'remove',
  'edit_profile',
  'update_profile',
  'change_settings',
  'block',
  'mute',
  'report',
  'purchase',
  'checkout',
])

const FORBIDDEN_KIND_SET = new Set(FORBIDDEN_KINDS)
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

function makeClock(now) {
  const source = typeof now === 'function' ? now : () => Date.now()
  return () => {
    let value
    try {
      value = source()
    } catch {
      return Date.now()
    }
    if (value instanceof Date) return value.getTime()
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string') {
      const parsed = Date.parse(value)
      if (Number.isFinite(parsed)) return parsed
    }
    return Date.now()
  }
}

// ---------------------------------------------------------------------------
// Host and app matching
// ---------------------------------------------------------------------------

/**
 * Lower-case a hostname, strip a trailing dot / IPv6 brackets and normalise
 * IDN via punycode. Anything containing path, credentials or a wildcard is
 * rejected here — wildcards are handled by parseAllowHost().
 */
export function normalizeHostname(value) {
  if (typeof value !== 'string') return null
  let host = value.trim().toLowerCase()
  if (!host) return null
  if (host.endsWith('.')) host = host.slice(0, -1)
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1)
  if (!host || /[\s/?#@*]/.test(host)) return null
  try {
    const ascii = domainToASCII(host)
    if (typeof ascii === 'string' && ascii.length > 0) host = ascii.toLowerCase()
  } catch {
    // Keep the raw host when IDNA is unavailable for it.
  }
  // Hostnames, IPv4 and bracketed IPv6 only; junk ("javascript:alert(1)") is
  // never treated as a host, so it can never match an allowlist entry.
  if (!host || !/^[a-z0-9._:-]+$/.test(host)) return null
  return host
}

/**
 * Extract the host from a browse target: full URL, `//host/path`, or bare host
 * with optional port. Returns null for non-http(s) schemes and junk.
 */
export function extractHost(target) {
  if (typeof target !== 'string') return null
  let value = target.trim()
  if (!value) return null
  if (/^https?:\/\//i.test(value)) {
    try {
      return normalizeHostname(new URL(value).hostname)
    } catch {
      return null
    }
  }
  if (value.startsWith('//')) {
    try {
      return normalizeHostname(new URL(`https:${value}`).hostname)
    } catch {
      return null
    }
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return null
  value = value.split('#')[0].split('?')[0].split('/')[0]
  const at = value.lastIndexOf('@')
  if (at >= 0) value = value.slice(at + 1)
  if (value.startsWith('[')) {
    const end = value.indexOf(']')
    if (end > 0) value = value.slice(1, end)
  } else {
    value = value.replace(/:\d+$/, '')
  }
  return normalizeHostname(value)
}

/**
 * Exact host match, or an explicit `*.example.com` wildcard that must cover at
 * least one full label. `endsWith('example.com')`-style prefix matching is
 * never used: `evilexample.com` and `example.com.evil.net` do not match.
 */
export function hostMatches(pattern, host) {
  const rawPattern = typeof pattern === 'string' ? pattern.trim().toLowerCase() : ''
  const normalizedHost = normalizeHostname(host)
  if (!rawPattern || !normalizedHost) return false
  if (rawPattern.startsWith('*.')) {
    const base = normalizeHostname(rawPattern.slice(2))
    if (!base) return false
    if (!normalizedHost.endsWith(`.${base}`)) return false
    const prefix = normalizedHost.slice(0, normalizedHost.length - base.length - 1)
    if (prefix.length === 0) return false
    return prefix.split('.').every((label) => HOST_LABEL.test(label))
  }
  if (rawPattern.includes('*')) return false
  return normalizeHostname(rawPattern) === normalizedHost
}

function parseAllowHost(entry) {
  if (typeof entry !== 'string') return null
  const text = entry.trim().toLowerCase()
  if (!text) return null
  if (text.startsWith('*.')) {
    const base = normalizeHostname(text.slice(2))
    return base ? `*.${base}` : null
  }
  if (text.includes('*')) return null
  if (text.includes('://')) return extractHost(text)
  return normalizeHostname(text)
}

function parseAllowApp(entry) {
  if (typeof entry !== 'string') return null
  const text = entry.trim().replace(/\\/g, '/').toLowerCase()
  if (!text || text.includes('*') || /\s/.test(text)) return null
  return text
}

function normalizeKind(value) {
  if (typeof value !== 'string') return ''
  return value.trim().toLowerCase().replace(/[\s-]+/g, '_')
}

function asList(value) {
  if (value === undefined || value === null) return []
  return Array.isArray(value) ? value : [value]
}

function buildAllowlist(input) {
  const hosts = []
  const apps = []
  const invalid = []
  let powerTargets = [...DEFAULT_POWER_TARGETS]

  const addHost = (entry) => {
    const pattern = parseAllowHost(entry)
    if (!pattern) {
      const text = entry === undefined || entry === null ? '' : String(entry).trim()
      if (text.length > 0) invalid.push(text)
      return
    }
    if (!hosts.includes(pattern)) hosts.push(pattern)
  }
  const addApp = (entry) => {
    const app = parseAllowApp(entry)
    if (!app) {
      const text = entry === undefined || entry === null ? '' : String(entry).trim()
      if (text.length > 0) invalid.push(text)
      return
    }
    if (!apps.includes(app)) apps.push(app)
  }

  if (typeof input === 'string' || Array.isArray(input)) {
    for (const entry of asList(input)) addHost(entry)
  } else if (input && typeof input === 'object') {
    for (const entry of asList(input.hosts ?? input.domains ?? input.allowHosts)) addHost(entry)
    for (const entry of asList(input.apps ?? input.applications ?? input.allowApps)) addApp(entry)
    const configuredPower = input.powerTargets ?? input.power
    if (configuredPower !== undefined) {
      const requested = asList(configuredPower)
        .map((item) => String(item).trim().toLowerCase())
        .filter((item) => item.length > 0)
      // Narrowing is allowed; widening (e.g. "format-disk") is not.
      powerTargets = DEFAULT_POWER_TARGETS.filter((op) => requested.includes(op))
      for (const item of requested) {
        if (!DEFAULT_POWER_TARGETS.includes(item)) invalid.push(`power:${item}`)
      }
    }
  }

  return { hosts, apps, powerTargets, invalid }
}

function checkTarget(scope, target, allow) {
  if (BROWSE_SCOPES.includes(scope)) {
    const host = extractHost(target)
    if (!host) return { ok: false, message: 'browse target is not a resolvable http(s) host' }
    if (allow.hosts.length === 0) return { ok: false, message: 'browse allowlist is empty' }
    if (!allow.hosts.some((pattern) => hostMatches(pattern, host))) {
      return { ok: false, message: `host "${host}" is not in the browse allowlist` }
    }
    return { ok: true }
  }

  if (scope === 'app.launch') {
    const raw = typeof target === 'string' ? target.trim() : ''
    if (!raw) return { ok: false, message: 'app.launch requires an application target' }
    if (allow.apps.length === 0) return { ok: false, message: 'application allowlist is empty' }
    const normalized = raw.replace(/\\/g, '/').toLowerCase()
    const base = normalized.split('/').filter((part) => part.length > 0).pop() ?? normalized
    if (!allow.apps.includes(normalized) && !allow.apps.includes(base)) {
      return { ok: false, message: `application "${raw}" is not in the allowlist` }
    }
    return { ok: true }
  }

  if (scope === 'os.power') {
    const op = typeof target === 'string' ? target.trim().toLowerCase() : ''
    if (!op) return { ok: false, message: 'os.power requires a power target (restart|shutdown)' }
    if (!allow.powerTargets.includes(op)) {
      return { ok: false, message: `power target "${op}" is not allowed (allowed: ${allow.powerTargets.join(', ') || 'none'})` }
    }
    return { ok: true }
  }

  return { ok: false, message: `unsupported scope "${scope}"` }
}

// ---------------------------------------------------------------------------
// Rate limit (per-scope token bucket)
// ---------------------------------------------------------------------------

function positive(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

function normalizeRateLimit(input) {
  if (input === false || input === null) return null
  const base = DEFAULT_RATE_LIMIT
  if (typeof input === 'number') {
    return { limit: Math.max(1, Math.floor(positive(input) ?? base.limit)), windowMs: base.windowMs }
  }
  if (input && typeof input === 'object') {
    const perMin = positive(input.perMin)
    const limit = Math.max(
      1,
      Math.floor(positive(input.limit ?? input.capacity ?? input.max ?? input.requests ?? perMin) ?? base.limit),
    )
    const windowMs = Math.max(
      1,
      Math.floor(positive(input.windowMs ?? input.perMs ?? input.periodMs ?? input.intervalMs) ?? base.windowMs),
    )
    return { limit, windowMs }
  }
  return { limit: base.limit, windowMs: base.windowMs }
}

function createRateLimiter(config, clock) {
  const limit = config.limit
  const windowMs = config.windowMs
  const refillPerMs = limit / windowMs
  const buckets = new Map()

  function bucketState(scope) {
    const timestamp = clock()
    let bucket = buckets.get(scope)
    if (!bucket) {
      bucket = { tokens: limit, updatedAt: timestamp }
      buckets.set(scope, bucket)
      return bucket
    }
    const elapsed = timestamp - bucket.updatedAt
    if (elapsed > 0) {
      bucket.tokens = Math.min(limit, bucket.tokens + elapsed * refillPerMs)
      bucket.updatedAt = timestamp
    } else if (elapsed < 0) {
      // The injected clock moved backwards: never invent tokens.
      bucket.updatedAt = timestamp
    }
    return bucket
  }

  return {
    limit,
    windowMs,
    peek(scope) {
      return bucketState(scope).tokens + 1e-9 >= 1
    },
    take(scope) {
      const bucket = bucketState(scope)
      if (bucket.tokens + 1e-9 < 1) return false
      bucket.tokens = Math.max(0, bucket.tokens - 1)
      return true
    },
    snapshot() {
      return [...buckets.entries()].map(([scope, bucket]) => ({
        scope,
        tokens: Math.round(bucket.tokens * 1000) / 1000,
        updatedAt: bucket.updatedAt,
      }))
    },
  }
}

// ---------------------------------------------------------------------------
// Kill switch and confirmation wiring
// ---------------------------------------------------------------------------

function normalizeKillSwitch(input) {
  if (typeof input === 'string') {
    const gate = createKillSwitch({ file: input })
    return () => gate.reason()
  }
  if (typeof input === 'function') {
    return () => (input() ? 'custom-kill-switch' : null)
  }
  if (input && typeof input === 'object') {
    const activeFn =
      typeof input.active === 'function'
        ? input.active
        : typeof input.isActive === 'function'
          ? input.isActive
          : typeof input.trip === 'function'
            ? input.trip
            : null
    if (activeFn) {
      return () => {
        const hit = activeFn.call(input)
        if (!hit) return null
        if (typeof input.reason === 'function') {
          try {
            const reason = input.reason.call(input)
            if (typeof reason === 'string' && reason.length > 0) return reason
          } catch {
            // fall through to the generic reason
          }
        }
        return 'custom-kill-switch'
      }
    }
    if (typeof input.active === 'boolean') return () => (input.active ? 'static-kill-switch' : null)
    if ('file' in input || 'env' in input) {
      const gate = createKillSwitch(input)
      return () => gate.reason()
    }
  }
  // Including `false`: the kill switch cannot be disabled, only re-pointed.
  const gate = createKillSwitch()
  return () => gate.reason()
}

function resolveConfirmGate(input, clock, ttlMs) {
  if (input === false || input === null) return null
  if (input && typeof input === 'object' && typeof input.request === 'function' && typeof input.consume === 'function') {
    return input
  }
  return createConfirmGate({ now: clock, ttlMs })
}

function readConfirmToken(action) {
  if (!action || typeof action !== 'object') return null
  for (const key of ['confirmToken', 'confirmationToken', 'token', 'confirmation', 'confirm']) {
    const value = action[key]
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
    if (value && typeof value === 'object' && typeof value.token === 'string' && value.token.trim().length > 0) {
      return value.token.trim()
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

/**
 * @param {{
 *   scopes?: string|string[]|Set<string>|(() => unknown),
 *   allowlist?: string|string[]|{ hosts?: string|string[], domains?: string|string[], apps?: string|string[], powerTargets?: string|string[] },
 *   rateLimit?: number|{ limit?: number, perMin?: number, windowMs?: number }|false|null,
 *   killSwitch?: false|string|(() => unknown)|{ file?: string|null, env?: Record<string,string|undefined> },
 *   audit?: { append(entry: object): unknown, readAll(): object[] },
 *   now?: () => (Date|number|string),
 *   confirm?: false|{ request(action: object): string, consume(token: string, action: object): boolean },
 *   confirmTtlMs?: number,
 * }} [options]
 */
export function createPolicy({ scopes, allowlist, rateLimit, killSwitch, audit, now, confirm, confirmTtlMs } = {}) {
  const clock = makeClock(now)
  const scopeSource = scopes
  const allow = buildAllowlist(allowlist)
  const rateConfig = normalizeRateLimit(rateLimit)
  const limiter = rateConfig ? createRateLimiter(rateConfig, clock) : null
  const confirmGate = resolveConfirmGate(confirm, clock, confirmTtlMs)
  const killSwitchReason = normalizeKillSwitch(killSwitch)
  const sink = audit && typeof audit.append === 'function' ? audit : null
  let lastAuditError = null

  function currentScopes() {
    try {
      return resolveScopes(scopeSource)
    } catch {
      return []
    }
  }

  function readKillReason() {
    try {
      const reason = killSwitchReason()
      return typeof reason === 'string' && reason.length > 0 ? reason : null
    } catch (error) {
      // A broken kill switch fails closed.
      return `kill-switch-error: ${error?.message ?? String(error)}`
    }
  }

  function record(decision) {
    if (!sink) return
    try {
      sink.append({
        scope: decision.scope ?? null,
        kind: decision.kind ?? null,
        target: decision.target ?? null,
        result: decision.ok ? 'allow' : 'deny',
        reason: decision.ok ? 'allowed' : `${decision.code}: ${decision.message}`,
      })
      lastAuditError = null
    } catch (error) {
      lastAuditError = error?.message ?? String(error)
    }
  }

  /**
   * @param {unknown} action
   * @param {{ enforce: boolean }} options
   */
  function evaluate(action, { enforce }) {
    const source = action && typeof action === 'object' && !Array.isArray(action) ? action : {}
    const rawScope = typeof source.scope === 'string' ? source.scope.trim().toLowerCase() : null
    const scope = normalizeScope(rawScope)
    const kind = normalizeKind(source.kind)
    const target = source.target ?? null
    const coords = { scope: scope ?? rawScope, kind: kind || null, target }

    const killReason = readKillReason()
    if (killReason) {
      return { ok: false, code: POLICY_CODES.KILL_SWITCH, message: `kill switch is active (${killReason})`, ...coords }
    }

    if (!scope) {
      return {
        ok: false,
        code: POLICY_CODES.SCOPE_DENIED,
        message: rawScope ? `unknown scope "${rawScope}"` : 'action has no recognised scope',
        ...coords,
      }
    }

    if (!currentScopes().includes(scope)) {
      return {
        ok: false,
        code: POLICY_CODES.SCOPE_DENIED,
        message: `scope "${scope}" is not enabled (enabled: ${currentScopes().join(', ') || 'none'})`,
        ...coords,
      }
    }

    if (FORBIDDEN_KIND_SET.has(kind)) {
      return {
        ok: false,
        code: POLICY_CODES.TARGET_DENIED,
        message: `kind "${kind}" is permanently denied (write-type social action)`,
        ...coords,
      }
    }

    const targetVerdict = checkTarget(scope, target, allow)
    if (!targetVerdict.ok) {
      return { ok: false, code: POLICY_CODES.TARGET_DENIED, message: targetVerdict.message, ...coords }
    }

    if (limiter) {
      // Dry runs peek; only require() consumes a token.
      const withinLimit = enforce ? limiter.take(scope) : limiter.peek(scope)
      if (!withinLimit) {
        return {
          ok: false,
          code: POLICY_CODES.RATE_LIMITED,
          message: `rate limit for "${scope}" exceeded (${limiter.limit} requests / ${limiter.windowMs} ms)`,
          ...coords,
        }
      }
    }

    if (scope === 'os.power') {
      const token = readConfirmToken(source)
      if (!token) {
        return {
          ok: false,
          code: POLICY_CODES.CONFIRM_REQUIRED,
          message: 'os.power requires a one-time confirmation token',
          ...coords,
        }
      }
      if (!confirmGate) {
        return {
          ok: false,
          code: POLICY_CODES.CONFIRM_REQUIRED,
          message: 'no confirmation gate is configured for this policy',
          ...coords,
        }
      }
      let passed = false
      try {
        passed = enforce ? confirmGate.consume(token, source) : confirmGate.peek(token, source)
      } catch {
        passed = false
      }
      if (!passed) {
        return {
          ok: false,
          code: POLICY_CODES.CONFIRM_REQUIRED,
          message: 'confirmation token is invalid, expired, reused, or was issued for a different action',
          ...coords,
        }
      }
    }

    return { ok: true, scope, kind: kind || null, target }
  }

  function check(action) {
    const decision = evaluate(action, { enforce: false })
    record(decision)
    if (decision.ok) return { ok: true }
    return { ok: false, code: decision.code, message: decision.message }
  }

  function requireAction(action) {
    const decision = evaluate(action, { enforce: true })
    record(decision)
    if (!decision.ok) {
      throw new PolicyError(decision.code, decision.message, {
        scope: decision.scope ?? null,
        kind: decision.kind ?? null,
        target: decision.target ?? null,
      })
    }
    return true
  }

  function snapshot() {
    const enabled = currentScopes()
    const killReason = readKillReason()
    return {
      scopes: enabled,
      knownScopes: [...SCOPE_ORDER],
      disabledScopes: SCOPE_ORDER.filter((scope) => !enabled.includes(scope)),
      allowlist: {
        hosts: [...allow.hosts],
        apps: [...allow.apps],
        powerTargets: [...allow.powerTargets],
      },
      invalidAllowlistEntries: [...allow.invalid],
      forbiddenKinds: [...FORBIDDEN_KINDS],
      rateLimit: limiter
        ? { limit: limiter.limit, windowMs: limiter.windowMs, buckets: limiter.snapshot() }
        : { enabled: false },
      confirm: {
        requiredFor: ['os.power'],
        gate: confirmGate ? 'configured' : 'missing',
        ttlMs: typeof confirmGate?.ttlMs === 'number' ? confirmGate.ttlMs : null,
      },
      killSwitch: { active: killReason !== null, reason: killReason },
      audit: { attached: Boolean(sink), lastError: lastAuditError },
    }
  }

  return { check, require: requireAction, snapshot, confirm: confirmGate }
}

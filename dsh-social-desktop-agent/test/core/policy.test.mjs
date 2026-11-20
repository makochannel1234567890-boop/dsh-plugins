import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createPolicy, FORBIDDEN_KINDS } from '../../lib/core/policy.js'
import { createAuditLog } from '../../lib/core/audit.js'
import { PolicyError, isPolicyError } from '../../lib/core/errors.js'

// The default kill switch reads the process environment; keep this file isolated.
const savedKillSwitch = process.env.DSH_KILL_SWITCH
const savedKillFile = process.env.DSH_KILL_SWITCH_FILE
delete process.env.DSH_KILL_SWITCH
delete process.env.DSH_KILL_SWITCH_FILE

const dir = mkdtempSync(join(tmpdir(), 'dsd-policy-'))
after(() => {
  rmSync(dir, { recursive: true, force: true })
  if (savedKillSwitch === undefined) delete process.env.DSH_KILL_SWITCH
  else process.env.DSH_KILL_SWITCH = savedKillSwitch
  if (savedKillFile === undefined) delete process.env.DSH_KILL_SWITCH_FILE
  else process.env.DSH_KILL_SWITCH_FILE = savedKillFile
})

const START = Date.parse('2026-01-01T00:00:00.000Z')

function makeClock(start = START) {
  let current = start
  return {
    now: () => current,
    advance: (ms) => {
      current += ms
    },
  }
}

/** Policy under test: browse.read on example.com, 5 req/min, kill switch live. */
function build(options = {}) {
  const clock = options.clock ?? makeClock()
  const audit = options.audit ?? createAuditLog({ now: clock.now })
  const policy = createPolicy({
    scopes: ['browse.read'],
    allowlist: { hosts: ['example.com', '*.example.org'] },
    rateLimit: { limit: 5, windowMs: 60_000 },
    killSwitch: false,
    now: clock.now,
    ...options.policy,
    audit,
  })
  return { policy, clock, audit }
}

const READ = { scope: 'browse.read', kind: 'navigate', target: 'https://example.com/home' }
const LAUNCH = { scope: 'app.launch', kind: 'launch', target: 'notepad.exe' }
const INTERACT = { scope: 'browse.interact', kind: 'click', target: 'https://example.com/post/1' }
const POWER = { scope: 'os.power', kind: 'power', target: 'restart' }

// ---------------------------------------------------------------------------
// Scope grant
// ---------------------------------------------------------------------------

test('the default grant denies everything except browse.read', () => {
  const { policy } = build()

  assert.deepEqual(policy.check(READ), { ok: true })
  assert.deepEqual(policy.check(INTERACT), {
    ok: false,
    code: 'SCOPE_DENIED',
    message: 'scope "browse.interact" is not enabled (enabled: browse.read)',
  })
  assert.equal(policy.check(LAUNCH).code, 'SCOPE_DENIED')
  assert.equal(policy.check(POWER).code, 'SCOPE_DENIED')
})

test('require throws a PolicyError carrying code, scope and target', () => {
  const { policy } = build()
  let captured = null
  assert.throws(
    () => policy.require(LAUNCH),
    (error) => {
      captured = error
      return true
    },
  )
  assert.ok(captured instanceof PolicyError)
  assert.equal(captured.name, 'PolicyError')
  assert.equal(captured.code, 'SCOPE_DENIED')
  assert.equal(captured.scope, 'app.launch')
  assert.equal(captured.kind, 'launch')
  assert.equal(captured.target, 'notepad.exe')
  assert.equal(isPolicyError(captured), true)
  assert.equal(isPolicyError(new Error('other')), false)
})

test('a scope promoted at runtime is allowed on the next call (live array)', () => {
  const granted = ['browse.read']
  const { policy } = build({ policy: { scopes: granted } })

  assert.equal(policy.check(INTERACT).code, 'SCOPE_DENIED')
  granted.push('browse.interact')
  assert.deepEqual(policy.check(INTERACT), { ok: true })
})

test('a scope promoted at runtime is allowed on the next call (thunk)', () => {
  let granted = ['browse.read']
  const { policy } = build({ policy: { scopes: () => granted } })

  assert.equal(policy.check(INTERACT).code, 'SCOPE_DENIED')
  granted = ['browse.read', 'browse.interact']
  assert.deepEqual(policy.check(INTERACT), { ok: true })
})

test('an unknown scope is denied instead of inferred', () => {
  const { policy } = build()
  const result = policy.check({ scope: 'root.everything', kind: 'read', target: 'https://example.com/' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'SCOPE_DENIED')
  assert.match(result.message, /unknown scope/)
})

test('a missing scope or a non-object action is denied, never thrown', () => {
  const { policy } = build()
  for (const action of [null, undefined, 42, 'browse.read', {}, { kind: 'navigate', target: 'https://example.com/' }]) {
    const result = policy.check(action)
    assert.equal(result.ok, false)
    assert.equal(result.code, 'SCOPE_DENIED')
  }
})

// ---------------------------------------------------------------------------
// Host allowlist
// ---------------------------------------------------------------------------

test('hosts must be allowlisted, and exact matching is not a suffix match', () => {
  const { policy } = build()

  assert.deepEqual(policy.check(READ), { ok: true })
  assert.equal(policy.check({ scope: 'browse.read', kind: 'navigate', target: 'https://sub.example.com/' }).code, 'TARGET_DENIED')
  assert.equal(policy.check({ scope: 'browse.read', kind: 'navigate', target: 'https://example.com.evil.net/' }).code, 'TARGET_DENIED')
  assert.equal(policy.check({ scope: 'browse.read', kind: 'navigate', target: 'https://evilexample.com/' }).code, 'TARGET_DENIED')
})

test('bare hosts, ports, userinfo and case are normalised before matching', () => {
  const { policy } = build()
  for (const target of [
    'example.com',
    'EXAMPLE.COM',
    'example.com/path?q=1#frag',
    'http://example.com:8080/x',
    'https://user:pass@example.com/x',
  ]) {
    assert.deepEqual(policy.check({ scope: 'browse.read', kind: 'navigate', target }), { ok: true }, target)
  }
})

test('non-http(s) schemes and unparseable targets are denied', () => {
  const { policy } = build()
  for (const target of ['ftp://example.com/x', 'file:///C:/Windows/win.ini', 'javascript:alert(1)', '', null]) {
    const result = policy.check({ scope: 'browse.read', kind: 'navigate', target })
    assert.equal(result.ok, false, String(target))
    assert.equal(result.code, 'TARGET_DENIED')
  }
})

test('the wildcard matches subdomains only, never the apex or a look-alike', () => {
  const { policy } = build({ policy: { allowlist: { hosts: ['*.example.org'] } } })

  assert.deepEqual(policy.check({ scope: 'browse.read', kind: 'navigate', target: 'https://a.example.org/x' }), { ok: true })
  assert.deepEqual(policy.check({ scope: 'browse.read', kind: 'navigate', target: 'https://a.b.example.org/x' }), { ok: true })
  for (const target of [
    'https://example.org/x',
    'https://evilexample.org/x',
    'https://example.org.evil.net/x',
    'https://aexample.org/x',
  ]) {
    assert.equal(policy.check({ scope: 'browse.read', kind: 'navigate', target }).code, 'TARGET_DENIED', target)
  }
})

test('only an explicit leading "*." wildcard is honoured; other forms are invalid', () => {
  const { policy } = build({ policy: { allowlist: { hosts: ['*example.com', 'example.*', '**'] } } })

  assert.equal(policy.check({ scope: 'browse.read', kind: 'navigate', target: 'https://example.com/' }).code, 'TARGET_DENIED')
  assert.equal(policy.check({ scope: 'browse.read', kind: 'navigate', target: 'https://example.net/' }).code, 'TARGET_DENIED')

  const snapshot = policy.snapshot()
  assert.deepEqual(snapshot.allowlist.hosts, [])
  assert.deepEqual(snapshot.invalidAllowlistEntries, ['*example.com', 'example.*', '**'])
})

test('an empty allowlist denies every browse target', () => {
  const { policy } = build({ policy: { allowlist: [] } })
  const result = policy.check(READ)
  assert.equal(result.code, 'TARGET_DENIED')
  assert.match(result.message, /allowlist is empty/)
})

test('an allowlist entry given as a URL is reduced to its host', () => {
  const { policy } = build({ policy: { allowlist: { hosts: ['https://example.com/feed'] } } })
  assert.deepEqual(policy.check(READ), { ok: true })
  assert.deepEqual(policy.snapshot().allowlist.hosts, ['example.com'])
})

// ---------------------------------------------------------------------------
// App allowlist
// ---------------------------------------------------------------------------

test('app.launch accepts allowlisted executables by path or basename', () => {
  const { policy } = build({
    policy: {
      scopes: ['app.launch'],
      allowlist: { apps: ['notepad.exe', 'C:\\Windows\\System32\\calc.exe'] },
      rateLimit: false,
    },
  })

  assert.deepEqual(policy.check({ scope: 'app.launch', kind: 'launch', target: 'notepad.exe' }), { ok: true })
  assert.deepEqual(policy.check({ scope: 'app.launch', kind: 'launch', target: 'C:\\Windows\\System32\\notepad.exe' }), { ok: true })
  assert.deepEqual(policy.check({ scope: 'app.launch', kind: 'launch', target: 'c:\\windows\\system32\\calc.exe' }), { ok: true })
})

test('app.launch denies non-allowlisted, empty and wildcarded targets', () => {
  const { policy } = build({
    policy: { scopes: ['app.launch'], allowlist: { apps: ['notepad.exe'] }, rateLimit: false },
  })

  for (const target of ['evil.exe', 'notepad.exe.bat', 'C:\\tmp\\evil.exe', '', null]) {
    const result = policy.check({ scope: 'app.launch', kind: 'launch', target })
    assert.equal(result.ok, false, String(target))
    assert.equal(result.code, 'TARGET_DENIED')
  }
  assert.deepEqual(policy.snapshot().invalidAllowlistEntries, [])
})

// ---------------------------------------------------------------------------
// Permanent denial of write-type social actions
// ---------------------------------------------------------------------------

test('write-type social kinds are permanently denied in every scope', () => {
  const { policy } = build({
    policy: { scopes: ['browse.read', 'browse.interact', 'app.launch'], rateLimit: false },
  })

  for (const kind of ['like', 'follow', 'dm', 'post', 'comment', 'send-DM', 'Repost']) {
    const result = policy.check({ scope: 'browse.interact', kind, target: 'https://example.com/post/1' })
    assert.equal(result.ok, false, kind)
    assert.equal(result.code, 'TARGET_DENIED')
    assert.match(result.message, /permanently denied/)
  }
  assert.ok(FORBIDDEN_KINDS.includes('like'))
  assert.ok(FORBIDDEN_KINDS.includes('send_dm'))
})

test('read and ordinary interaction kinds are not caught by the permanent ban', () => {
  const { policy } = build({ policy: { scopes: ['browse.read', 'browse.interact'], rateLimit: false } })
  for (const kind of ['navigate', 'read', 'scroll', 'click', 'type', 'hover']) {
    assert.deepEqual(policy.check({ scope: 'browse.interact', kind, target: 'https://example.com/p' }), { ok: true }, kind)
  }
})

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

test('the default rate limit is 30 requests per minute per scope', () => {
  const { policy } = build({ policy: { rateLimit: undefined } })
  assert.equal(policy.snapshot().rateLimit.limit, 30)
  assert.equal(policy.snapshot().rateLimit.windowMs, 60_000)

  for (let index = 0; index < 30; index += 1) assert.equal(policy.require(READ), true)
  assert.throws(() => policy.require(READ), (error) => error.code === 'RATE_LIMITED')
})

test('the token bucket denies once a scope is exhausted', () => {
  const { policy } = build({ policy: { rateLimit: { limit: 2, windowMs: 60_000 } } })

  assert.equal(policy.require(READ), true)
  assert.equal(policy.require(READ), true)
  assert.throws(() => policy.require(READ), (error) => error.code === 'RATE_LIMITED')
})

test('rate limits are counted per scope', () => {
  const { policy } = build({
    policy: { scopes: ['browse.read', 'browse.interact'], rateLimit: { limit: 1, windowMs: 60_000 } },
  })

  assert.equal(policy.require(READ), true)
  assert.equal(policy.require(INTERACT), true)
  assert.throws(() => policy.require(READ), (error) => error.code === 'RATE_LIMITED')
  assert.throws(() => policy.require(INTERACT), (error) => error.code === 'RATE_LIMITED')
})

test('the bucket refills with time', () => {
  const clock = makeClock()
  const { policy } = build({ clock, policy: { rateLimit: { limit: 2, windowMs: 60_000 } } })

  assert.equal(policy.require(READ), true)
  assert.equal(policy.require(READ), true)
  assert.throws(() => policy.require(READ), (error) => error.code === 'RATE_LIMITED')

  clock.advance(60_000)
  assert.equal(policy.require(READ), true)
})

test('check() is a dry run and never consumes rate tokens', () => {
  const { policy } = build({ policy: { rateLimit: { limit: 1, windowMs: 60_000 } } })

  for (let index = 0; index < 20; index += 1) assert.deepEqual(policy.check(READ), { ok: true })
  assert.equal(policy.require(READ), true)
  assert.throws(() => policy.require(READ), (error) => error.code === 'RATE_LIMITED')
})

test('rate limiting can be disabled with rateLimit: false', () => {
  const { policy } = build({ policy: { rateLimit: false } })
  for (let index = 0; index < 100; index += 1) assert.equal(policy.require(READ), true)
})

test('snapshot reports bucket usage', () => {
  const { policy } = build({ policy: { rateLimit: { limit: 5, windowMs: 60_000 } } })
  policy.require(READ)
  policy.require(READ)
  const [bucket] = policy.snapshot().rateLimit.buckets
  assert.equal(bucket.scope, 'browse.read')
  assert.equal(bucket.tokens, 3)
})

// ---------------------------------------------------------------------------
// Kill switch
// ---------------------------------------------------------------------------

test('an active environment kill switch denies every scope with KILL_SWITCH', () => {
  const { policy } = build({ policy: { killSwitch: { env: { DSH_KILL_SWITCH: '1' } } } })

  for (const action of [READ, INTERACT, LAUNCH, POWER]) {
    const result = policy.check(action)
    assert.equal(result.code, 'KILL_SWITCH', action.scope)
  }
  assert.throws(() => policy.require(READ), (error) => error.code === 'KILL_SWITCH')
})

test('a kill-switch file created mid-run stops the next action', () => {
  const file = join(dir, 'KILL')
  const { policy } = build({ policy: { killSwitch: { file, env: {} } } })

  assert.deepEqual(policy.check(READ), { ok: true })
  writeFileSync(file, '', 'utf8')
  assert.equal(policy.check(READ).code, 'KILL_SWITCH')
  assert.throws(() => policy.require(READ), (error) => error.code === 'KILL_SWITCH')
})

test('snapshot reports the kill switch state', () => {
  const { policy } = build()
  assert.deepEqual(policy.snapshot().killSwitch, { active: false, reason: null })
  assert.equal(policy.snapshot().confirm.gate, 'configured')
})

// ---------------------------------------------------------------------------
// os.power confirmation
// ---------------------------------------------------------------------------

test('os.power without a confirmation token is CONFIRM_REQUIRED', () => {
  const { policy } = build({ policy: { scopes: ['os.power'], rateLimit: false } })

  const result = policy.check(POWER)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'CONFIRM_REQUIRED')
  assert.throws(() => policy.require(POWER), (error) => error.code === 'CONFIRM_REQUIRED')
})

test('os.power succeeds with a one-time token and refuses its reuse', () => {
  const { policy } = build({ policy: { scopes: ['os.power'], rateLimit: false } })

  const token = policy.confirm.request(POWER)
  assert.equal(typeof token, 'string')
  assert.equal(policy.require({ ...POWER, confirmToken: token }), true)
  assert.throws(
    () => policy.require({ ...POWER, confirmToken: token }),
    (error) => error.code === 'CONFIRM_REQUIRED',
  )
})

test('a token issued for restart does not authorise shutdown', () => {
  const { policy } = build({ policy: { scopes: ['os.power'], rateLimit: false } })
  const token = policy.confirm.request(POWER)
  assert.throws(
    () => policy.require({ scope: 'os.power', kind: 'power', target: 'shutdown', confirmToken: token }),
    (error) => error.code === 'CONFIRM_REQUIRED',
  )
})

test('os.power still requires an allowed target and never accepts a widened one', () => {
  const { policy } = build({
    policy: {
      scopes: ['os.power'],
      allowlist: { powerTargets: ['restart', 'format-disk'] },
      rateLimit: false,
    },
  })

  const snapshot = policy.snapshot()
  assert.deepEqual(snapshot.allowlist.powerTargets, ['restart'])
  assert.ok(snapshot.invalidAllowlistEntries.includes('power:format-disk'))
  assert.equal(policy.check({ scope: 'os.power', kind: 'power', target: 'format-disk' }).code, 'TARGET_DENIED')
  assert.equal(policy.check({ scope: 'os.power', kind: 'power', target: 'shutdown' }).code, 'TARGET_DENIED')
  assert.equal(policy.check(POWER).code, 'CONFIRM_REQUIRED')
})

test('an expired token is refused by the policy', () => {
  const clock = makeClock()
  const { policy } = build({ clock, policy: { scopes: ['os.power'], rateLimit: false, confirmTtlMs: 1000 } })

  const token = policy.confirm.request(POWER)
  clock.advance(1000)
  assert.throws(
    () => policy.require({ ...POWER, confirmToken: token }),
    (error) => error.code === 'CONFIRM_REQUIRED',
  )
})

test('confirm: false keeps os.power permanently CONFIRM_REQUIRED', () => {
  const { policy } = build({ policy: { scopes: ['os.power'], confirm: false, rateLimit: false } })
  assert.equal(policy.snapshot().confirm.gate, 'missing')
  assert.equal(policy.check({ ...POWER, confirmToken: 'anything' }).code, 'CONFIRM_REQUIRED')
})

// ---------------------------------------------------------------------------
// Audit integration
// ---------------------------------------------------------------------------

test('a denied require leaves a deny row in the JSONL audit log', () => {
  const file = join(dir, 'deny-audit.jsonl')
  const clock = makeClock()
  const audit = createAuditLog({ file, now: clock.now })
  const { policy } = build({ clock, audit })

  assert.throws(() => policy.require(LAUNCH))
  const rows = audit.readAll()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].result, 'deny')
  assert.equal(rows[0].scope, 'app.launch')
  assert.equal(rows[0].kind, 'launch')
  assert.equal(rows[0].target, 'notepad.exe')
  assert.match(rows[0].reason, /^SCOPE_DENIED: /)
  assert.equal(rows[0].ts, new Date(START).toISOString())
})

test('an allowed require leaves an allow row', () => {
  const { policy, audit } = build()
  assert.equal(policy.require(READ), true)
  const rows = audit.readAll()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].result, 'allow')
  assert.equal(rows[0].reason, 'allowed')
})

test('an audit failure never changes the decision and is reported in snapshot', () => {
  const audit = {
    append() {
      throw new Error('disk full')
    },
    readAll: () => [],
  }
  const { policy } = build({ audit })

  assert.deepEqual(policy.check(READ), { ok: true })
  assert.match(policy.snapshot().audit.lastError, /disk full/)
})

// ---------------------------------------------------------------------------
// Snapshot / contract shape
// ---------------------------------------------------------------------------

test('check returns exactly { ok } or { ok, code, message }', () => {
  const { policy } = build()
  assert.deepEqual(policy.check(READ), { ok: true })
  const denied = policy.check(LAUNCH)
  assert.deepEqual(Object.keys(denied).sort(), ['code', 'message', 'ok'])
})

test('snapshot is JSON-serialisable and describes the active policy', () => {
  const { policy } = build()
  const snapshot = policy.snapshot()

  assert.deepEqual(snapshot.scopes, ['browse.read'])
  assert.deepEqual(snapshot.disabledScopes, ['browse.interact', 'social.write', 'app.launch', 'os.power'])
  assert.deepEqual(snapshot.allowlist.hosts, ['example.com', '*.example.org'])
  assert.deepEqual(snapshot.allowlist.apps, [])
  assert.deepEqual(snapshot.allowlist.powerTargets, ['restart', 'shutdown'])
  assert.equal(snapshot.rateLimit.limit, 5)
  assert.equal(snapshot.rateLimit.windowMs, 60_000)
  assert.deepEqual(snapshot.confirm, { requiredFor: ['os.power'], gate: 'configured', ttlMs: 300_000 })
  assert.equal(snapshot.audit.attached, true)
  assert.doesNotThrow(() => JSON.stringify(snapshot))
})

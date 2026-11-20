/**
 * dsh-social-desktop-agent — plugin entry point.
 *
 * Two capabilities, one deliberately narrow safety envelope:
 *
 *   browse_*  read and operate allowlisted social web pages (browser layer)
 *   desktop_* observe and operate the local Windows desktop (desktop layer)
 *   app_launch / power_action  explicit, separately-gated escalation
 *
 * Everything is deny-by-default:
 *   - `scopes` defaults to `['browse.read']` only;
 *   - hosts and applications come from an explicit allowlist;
 *   - write-type social actions (like/follow/DM/post/comment/...) are refused
 *     permanently by lib/core/policy.js and lib/browser/tools.js, whatever the
 *     configuration says;
 *   - `power_action` needs the `os.power` scope, a confirmation token, the
 *     `DSH_ALLOW_POWER=1` environment variable and `powerEnabled: true`, and is
 *     a dry run unless all of them hold;
 *   - the kill switch, audit log and human-intervention latch stop the plugin.
 *
 * Failure containment
 * -------------------
 * `lib/core`, `lib/browser` and `lib/desktop` are imported dynamically at
 * registration time. A missing or broken module disables its category and logs
 * a warning; it never takes the host down. Without lib/core nothing at all is
 * registered, because every tool call must pass through the policy.
 *
 * This module performs no I/O by itself. It only wires modules together.
 *
 * @module dsh-social-desktop-agent
 */

import os from 'node:os'
import path from 'node:path'

export const name = 'social-desktop-agent'

/** Hard dependency: the tool registry. Everything else is resolved lazily. */
export const inject = ['tools']

/** Human-readable summary (also used by verify / docs tooling). */
export const description =
  'Read and operate allowlisted social web pages and the local Windows desktop under an explicit scope grant, host/app allowlists, a permanent ban on write-type social actions, confirmation-gated power operations, an append-only audit log and a kill switch.'

// ---------------------------------------------------------------------------
// Scope / tool catalogue
// ---------------------------------------------------------------------------

/** Least → most invasive. Mirrors lib/core/scopes.js. */
export const KNOWN_SCOPES = Object.freeze([
  'browse.read',
  'browse.interact',
  'social.write',
  'app.launch',
  'os.power',
])

/** Scopes enabled when the caller says nothing. Least privilege. */
export const DEFAULT_SCOPES = Object.freeze(['browse.read'])

export const BROWSER_TOOL_NAMES = Object.freeze([
  'browse_open',
  'browse_snapshot',
  'browse_click',
  'browse_type',
  'browse_scroll',
  'browse_screenshot',
  'browse_close',
])

export const DESKTOP_TOOL_NAMES = Object.freeze([
  'desktop_observe',
  'desktop_focus',
  'desktop_move',
  'desktop_click',
  'desktop_type',
  'desktop_key',
  'app_launch',
  'power_action',
])

/** Every tool this plugin may register, in registration order. */
export const TOOL_NAMES = Object.freeze([...BROWSER_TOOL_NAMES, ...DESKTOP_TOOL_NAMES])

/** Domains allowed by default. Keep in sync with lib/browser/policies.js. */
export const DEFAULT_ALLOWED_HOSTS = Object.freeze([
  'instagram.com',
  'www.instagram.com',
  'i.instagram.com',
  '*.cdninstagram.com',
  '*.fbcdn.net',
])

/** Applications allowed by default. Keep in sync with lib/desktop/apps.js. */
export const DEFAULT_ALLOWED_APPS = Object.freeze([
  'notepad',
  'calc',
  'explorer',
  'mspaint',
  'chrome',
  'msedge',
  'code',
])

/**
 * Internal, guaranteed non-resolvable host used to pass desktop actions through
 * the shared policy (the policy's browse scopes validate a host target). Browser
 * tools never use it: they have their own domain allowlist.
 */
export const DESKTOP_SENTINEL_HOST = 'desktop.invalid'

/** Default data directory for the audit log and the kill-switch file. */
function defaultDataDir() {
  const base =
    typeof process.env.LOCALAPPDATA === 'string' && process.env.LOCALAPPDATA.trim().length > 0
      ? process.env.LOCALAPPDATA
      : path.join(os.homedir(), '.local', 'share')
  return path.join(base, 'dsh-social-desktop-agent')
}

/** Default audit file. Override with `auditPath` (null = in-memory, tests only). */
export function defaultAuditPath() {
  return path.join(defaultDataDir(), 'audit.jsonl')
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Documented configuration schema (JSON Schema subset). This is the contract
 * for `cordis.patch.yml` config, exported for docs and verification; the
 * runtime normalises the same keys in resolveConfig().
 */
export const CONFIG_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    enabled: { type: 'boolean', default: true, description: 'Enable the whole plugin.' },
    scopes: {
      type: 'array',
      items: { type: 'string', enum: [...KNOWN_SCOPES] },
      default: [...DEFAULT_SCOPES],
      description:
        'Exactly granted scopes. Omitted = browse.read only. An explicit [] grants nothing.',
    },
    allowlist: {
      type: 'object',
      properties: {
        hosts: {
          type: 'array',
          items: { type: 'string' },
          default: [...DEFAULT_ALLOWED_HOSTS],
          description: 'Browser host allowlist. `*.example.com` wildcards allowed. Replaces the default.',
        },
        apps: {
          type: 'array',
          items: { type: 'string' },
          default: [...DEFAULT_ALLOWED_APPS],
          description: 'Application allowlist for app_launch. Replaces the default.',
        },
        powerTargets: {
          type: 'array',
          items: { type: 'string', enum: ['restart', 'shutdown'] },
          description:
            'Optional narrowing of power actions (never widening). Omitted = both restart and shutdown.',
        },
      },
      description: 'Replaces the built-in allowlists when present.',
    },
    killSwitch: {
      type: ['boolean', 'string'],
      default: true,
      description:
        'true: watch <audit dir>/KILL_SWITCH. String: watch that path instead. The DSH_KILL_SWITCH env var is always honoured and cannot be disabled.',
    },
    auditPath: {
      type: ['string', 'null'],
      default: '<LOCALAPPDATA>\\dsh-social-desktop-agent\\audit.jsonl',
      description:
        'JSONL audit file. Omitted: <LOCALAPPDATA>/dsh-social-desktop-agent/audit.jsonl. Pass null explicitly only in tests (memory only).',
    },
    powerEnabled: {
      type: 'boolean',
      default: false,
      description:
        'Extra operator gate for power_action. Even when true, the os.power scope, confirmation token and DSH_ALLOW_POWER=1 are still required.',
    },
    browserDriver: {
      type: 'string',
      enum: ['stub', 'cdp'],
      default: 'stub',
      description: 'stub: offline fake page driver. cdp: real browser via CDP (no network until a tool is called).',
    },
    cdpPort: {
      type: 'integer',
      default: 9222,
      description: 'CDP port used when browserDriver is "cdp".',
    },
    cdpAllowPageTargets: {
      type: 'boolean',
      default: false,
      description:
        'Allow type:"page" CDP targets, not just type:"webview". Only turn this on for a dedicated port that hosts your own Chrome/Edge (for example an external browser started with --remote-debugging-port=9222). Never point it at the DSH debugging port: the DSH shell is a page target too.',
    },
  },
})

/** Alias used by some tooling; same object as CONFIG_SCHEMA. */
export const settingsSchema = CONFIG_SCHEMA

/** Default settings actually used by the runtime. */
export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  scopes: DEFAULT_SCOPES,
  allowlist: Object.freeze({
    hosts: DEFAULT_ALLOWED_HOSTS,
    apps: DEFAULT_ALLOWED_APPS,
  }),
  killSwitch: true,
  auditPath: defaultAuditPath(),
  powerEnabled: false,
  browserDriver: 'stub',
  cdpPort: 9222,
  cdpAllowPageTargets: false,
})

function asStringArray(value) {
  if (typeof value === 'string') return [value]
  if (!Array.isArray(value)) return []
  return value.filter((entry) => typeof entry === 'string' && entry.trim().length > 0).map((entry) => entry.trim())
}

function normalizeScopes(raw) {
  if (raw === undefined || raw === null) return [...DEFAULT_SCOPES]
  if (typeof raw === 'function') {
    try {
      return normalizeScopes(raw())
    } catch {
      return []
    }
  }
  if (typeof raw === 'string') return KNOWN_SCOPES.filter((scope) => scope === raw.trim().toLowerCase())
  if (raw instanceof Set) raw = [...raw]
  if (!Array.isArray(raw)) return []
  const accepted = new Set(
    raw.map((entry) => (typeof entry === 'string' ? entry.trim().toLowerCase() : '')),
  )
  return KNOWN_SCOPES.filter((scope) => accepted.has(scope))
}

function normalizeAllowlist(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const hosts = asStringArray(source.hosts ?? source.domains ?? source.allowHosts)
  const apps = asStringArray(source.apps ?? source.applications ?? source.allowApps)
  const powerTargets = asStringArray(source.powerTargets ?? source.power).map((entry) => entry.toLowerCase())
  return {
    hosts: hosts.length > 0 ? hosts : [...DEFAULT_ALLOWED_HOSTS],
    apps: apps.length > 0 ? apps : [...DEFAULT_ALLOWED_APPS],
    // Optional narrowing (never widening): the core policy keeps only
    // 'restart'/'shutdown'. Omitted = both targets.
    ...(powerTargets.length > 0 ? { powerTargets } : {}),
  }
}

/**
 * Normalise the raw `config` object into the settings used by the runtime.
 * Unknown keys and unknown scopes are dropped; nothing throws.
 *
 * @param {Record<string, unknown>} [raw]
 */
export function resolveConfig(raw = {}) {
  const config = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}

  const auditPath =
    config.auditPath === null
      ? null
      : typeof config.auditPath === 'string' && config.auditPath.trim().length > 0
        ? path.resolve(config.auditPath.trim())
        : defaultAuditPath()

  let killSwitchFile = null
  if (typeof config.killSwitch === 'string' && config.killSwitch.trim().length > 0) {
    killSwitchFile = path.resolve(config.killSwitch.trim())
  } else if (config.killSwitch !== false) {
    const fromEnv =
      typeof process.env.DSH_KILL_SWITCH_FILE === 'string' && process.env.DSH_KILL_SWITCH_FILE.trim().length > 0
        ? process.env.DSH_KILL_SWITCH_FILE.trim()
        : ''
    killSwitchFile = fromEnv
      ? path.resolve(fromEnv)
      : path.join(auditPath ? path.dirname(auditPath) : defaultDataDir(), 'KILL_SWITCH')
  }

  const cdpPort = Number(config.cdpPort)

  return {
    enabled: config.enabled !== false,
    scopes: normalizeScopes(config.scopes),
    allowlist: normalizeAllowlist(config.allowlist),
    killSwitchFile,
    auditPath,
    powerEnabled: config.powerEnabled === true,
    browserDriver: config.browserDriver === 'cdp' ? 'cdp' : 'stub',
    cdpPort: Number.isInteger(cdpPort) && cdpPort >= 1 && cdpPort <= 65535 ? cdpPort : 9222,
    cdpAllowPageTargets: config.cdpAllowPageTargets === true,
  }
}

// ---------------------------------------------------------------------------
// Tool specifications (model-facing surface)
// ---------------------------------------------------------------------------

const NO_ARGS = Object.freeze({ type: 'object', additionalProperties: false, properties: {} })

/**
 * Static tool specifications. Keeping the schemas here (instead of generating
 * them from modules) means the model-facing API is stable even when one layer
 * is unavailable.
 */
export const TOOL_SPECS = Object.freeze([
  {
    name: 'browse_open',
    category: 'browser',
    scope: 'browse.read',
    title: 'Browse open',
    description:
      'Open an http(s) URL in the plugin browser, but only when the host is in the configured allowlist (instagram.com by default). Rejects other schemes, credentials in the URL and non-allowlisted hosts. If the page turns into a login, 2FA, checkpoint or CAPTCHA wall, the browser layer stops and reports NEEDS_HUMAN: hand it to the human, never try to sign in.',
    timeoutMs: 90_000,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['url'],
      properties: { url: { type: 'string', description: 'Absolute http(s) URL on an allowlisted host.' } },
    },
  },
  {
    name: 'browse_snapshot',
    category: 'browser',
    scope: 'browse.read',
    title: 'Browse snapshot',
    description:
      'Return an accessibility-style snapshot of the current page: numbered refs ([e1], [e2], ...) with role, accessible name and value. Read this before clicking; refs are what browse_click/browse_type take. Refuses after a human-intervention latch is set.',
    timeoutMs: 60_000,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        maxNodes: { type: 'integer', minimum: 1, maximum: 500, description: 'Maximum nodes to include (default 200).' },
      },
    },
  },
  {
    name: 'browse_click',
    category: 'browser',
    scope: 'browse.interact',
    title: 'Browse click',
    description:
      'Click a snapshot ref. Write-type social actions (like, follow, DM, post, comment, share, save) and credential fields are permanently refused, whatever the scopes say. On login/2FA/CAPTCHA the layer stops and returns NEEDS_HUMAN.',
    timeoutMs: 60_000,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['ref'],
      properties: {
        ref: { type: 'string', description: 'Ref from browse_snapshot, e.g. "e12".' },
        purpose: {
          type: 'string',
          description: 'Optional intent label. "social.write" is refused permanently.',
        },
      },
    },
  },
  {
    name: 'browse_type',
    category: 'browser',
    scope: 'browse.interact',
    title: 'Browse type',
    description:
      'Type text into a snapshot ref (form field, textbox). Refuses password / one-time-code / username fields: credentials are never handled by this plugin. submit=true presses Enter after typing.',
    timeoutMs: 60_000,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['ref', 'text'],
      properties: {
        ref: { type: 'string', description: 'Ref from browse_snapshot.' },
        text: { type: 'string', description: 'Text to type.' },
        submit: { type: 'boolean', description: 'Press Enter after typing.' },
      },
    },
  },
  {
    name: 'browse_scroll',
    category: 'browser',
    scope: 'browse.read',
    title: 'Browse scroll',
    description: 'Scroll the current page by a pixel delta, or to a snapshot ref. Read-only navigation.',
    timeoutMs: 60_000,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        deltaY: { type: 'number', description: 'Vertical pixels; positive scrolls down.' },
        ref: { type: 'string', description: 'Optional ref to scroll to instead.' },
      },
    },
  },
  {
    name: 'browse_screenshot',
    category: 'browser',
    scope: 'browse.read',
    title: 'Browse screenshot',
    description: 'Capture a screenshot of the current page as a data URL. Read-only evidence; never contains credentials handled by this plugin.',
    timeoutMs: 90_000,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        fullPage: { type: 'boolean', description: 'Capture the whole page instead of the viewport.' },
      },
    },
  },
  {
    name: 'browse_close',
    category: 'browser',
    scope: 'browse.read',
    title: 'Browse close',
    description: 'Close this plugin browser session. A stopping action: it is allowed even while the human-intervention latch is set.',
    timeoutMs: 30_000,
    parameters: NO_ARGS,
  },
  {
    name: 'desktop_observe',
    category: 'desktop',
    scope: 'browse.read',
    title: 'Desktop observe',
    description:
      'Read-only observation of the local Windows desktop: cursor position, screen/monitor rectangles, visible window titles and the foreground window. Requires the browse.read scope (read-only).',
    timeoutMs: 30_000,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        maxWindows: { type: 'integer', minimum: 1, maximum: 300, description: 'Maximum windows to report.' },
      },
    },
  },
  {
    name: 'desktop_focus',
    category: 'desktop',
    scope: 'browse.interact',
    title: 'Desktop focus',
    description:
      'Bring an allowlisted window (by pid and/or a title substring) to the foreground and report whether it really became the foreground window. Use it before desktop_type / desktop_key / desktop_click so keystrokes cannot land in the wrong app. Requires browse.interact.',
    timeoutMs: 30_000,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        pid: { type: 'integer', minimum: 1, description: 'Process id of an allowlisted application.' },
        title: { type: 'string', minLength: 1, maxLength: 200, description: 'Case-insensitive window title substring.' },
      },
    },
  },
  {
    name: 'desktop_move',
    category: 'desktop',
    scope: 'browse.interact',
    title: 'Desktop move',
    description:
      'Move the mouse cursor to a virtual-screen coordinate. Requires browse.interact. Coordinates far outside the screen are rejected, small overshoots are clamped.',
    timeoutMs: 30_000,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['x', 'y'],
      properties: { x: { type: 'number' }, y: { type: 'number' } },
    },
  },
  {
    name: 'desktop_click',
    category: 'desktop',
    scope: 'browse.interact',
    title: 'Desktop click',
    description:
      'Move to a coordinate and click a mouse button (left/right/middle), optionally 1-3 times. Requires browse.interact. This is a destructive action on whatever window has focus; prefer desktop_observe first.',
    timeoutMs: 30_000,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['x', 'y'],
      properties: {
        x: { type: 'number' },
        y: { type: 'number' },
        button: { type: 'string', enum: ['left', 'right', 'middle'] },
        count: { type: 'integer', minimum: 1, maximum: 3 },
      },
    },
  },
  {
    name: 'desktop_type',
    category: 'desktop',
    scope: 'browse.interact',
    title: 'Desktop type',
    description:
      'Type text into the focused window (SendKeys-escaped). Requires browse.interact. The text itself is never written to the audit log, only its length. Never type passwords or tokens.',
    timeoutMs: 30_000,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['text'],
      properties: {
        text: { type: 'string', minLength: 1, maxLength: 2000 },
      },
    },
  },
  {
    name: 'desktop_key',
    category: 'desktop',
    scope: 'browse.interact',
    title: 'Desktop key',
    description:
      'Press one allowlisted key (enter, tab, esc, arrows, F1-F12, letters/digits) with optional ctrl/alt/shift modifiers. Requires browse.interact.',
    timeoutMs: 30_000,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['key'],
      properties: {
        key: { type: 'string' },
        modifiers: {
          type: 'array',
          items: { type: 'string', enum: ['ctrl', 'alt', 'shift'] },
          maxItems: 3,
        },
      },
    },
  },
  {
    name: 'app_launch',
    category: 'desktop',
    scope: 'app.launch',
    title: 'App launch',
    description:
      'Launch an allowlisted desktop application by name (notepad, calc, explorer, mspaint, chrome, msedge, code). Requires app.launch. Arbitrary paths, arguments and commands are rejected.',
    timeoutMs: 30_000,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['app'],
      properties: { app: { type: 'string', description: 'Allowlisted application name.' } },
    },
  },
  {
    name: 'power_action',
    category: 'desktop',
    scope: 'os.power',
    title: 'Power action',
    description:
      'Schedule a Windows reboot or shutdown. Executes only when ALL gates hold: os.power scope, a confirmation token matching DSH_POWER_CONFIRM_TOKEN, DSH_ALLOW_POWER=1, and powerEnabled=true. Otherwise returns a dry-run plan and executes nothing. delaySec defaults to 60.',
    timeoutMs: 30_000,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['reboot', 'shutdown'] },
        delaySec: { type: 'integer', minimum: 0, maximum: 86_400 },
        confirmToken: { type: 'string', description: 'Token from DSH_POWER_CONFIRM_TOKEN.' },
      },
    },
  },
])

const TOOL_SPEC_BY_NAME = new Map(TOOL_SPECS.map((spec) => [spec.name, spec]))

// ---------------------------------------------------------------------------
// Dynamic module loading
// ---------------------------------------------------------------------------

function moduleUrl(relative) {
  return new URL(relative, import.meta.url).href
}

async function importRelative(relative) {
  return import(moduleUrl(relative))
}

function describeError(error) {
  if (error === null || error === undefined) return 'unknown error'
  const code = typeof error.code === 'string' && error.code.length > 0 ? ` (${error.code})` : ''
  const message = typeof error.message === 'string' && error.message.length > 0 ? error.message : String(error)
  return `${message}${code}`
}

/**
 * Load the three layers. Each entry resolves to `{ value, error }`; `value` is
 * null when the layer is unavailable. `overrides` lets tests inject fakes:
 *   { core, browser, desktop } — an object uses it as the layer, `null` marks
 *   the layer unavailable without touching the filesystem.
 *
 * @param {{ overrides?: { core?: unknown, browser?: unknown, desktop?: unknown } }} [options]
 */
export async function loadModules({ overrides = {} } = {}) {
  const result = { core: null, browser: null, desktop: null, errors: {} }

  // --- core: policy engine + audit sink (mandatory for every tool) ---------
  if (Object.prototype.hasOwnProperty.call(overrides, 'core')) {
    if (overrides.core) result.core = overrides.core
    else result.errors.core = 'disabled by injection'
  } else {
    try {
      const [policyModule, auditModule] = await Promise.all([
        importRelative('./lib/core/policy.js'),
        importRelative('./lib/core/audit.js'),
      ])
      if (typeof policyModule.createPolicy !== 'function') {
        throw new TypeError('lib/core/policy.js does not export createPolicy()')
      }
      if (typeof auditModule.createAuditLog !== 'function') {
        throw new TypeError('lib/core/audit.js does not export createAuditLog()')
      }
      result.core = {
        createPolicy: policyModule.createPolicy,
        createAuditLog: auditModule.createAuditLog,
        extractHost: typeof policyModule.extractHost === 'function' ? policyModule.extractHost : null,
      }
    } catch (error) {
      result.errors.core = describeError(error)
    }
  }

  // --- browser ------------------------------------------------------------
  if (Object.prototype.hasOwnProperty.call(overrides, 'browser')) {
    if (overrides.browser) result.browser = overrides.browser
    else result.errors.browser = 'disabled by injection'
  } else {
    try {
      const toolsModule = await importRelative('./lib/browser/tools.js')
      if (typeof toolsModule.createBrowseTools !== 'function') {
        throw new TypeError('lib/browser/tools.js does not export createBrowseTools()')
      }
      result.browser = {
        createBrowseTools: toolsModule.createBrowseTools,
        loadStubDriver: async () => {
          const stub = await importRelative('./lib/browser/stub-driver.js')
          if (typeof stub.createStubDriver !== 'function') {
            throw new TypeError('lib/browser/stub-driver.js does not export createStubDriver()')
          }
          return stub.createStubDriver
        },
        loadCdpDriver: async () => {
          const cdp = await importRelative('./lib/browser/cdp-driver.js')
          if (typeof cdp.createCdpDriver !== 'function') {
            throw new TypeError('lib/browser/cdp-driver.js does not export createCdpDriver()')
          }
          return cdp.createCdpDriver
        },
      }
    } catch (error) {
      result.errors.browser = describeError(error)
    }
  }

  // --- desktop ------------------------------------------------------------
  if (Object.prototype.hasOwnProperty.call(overrides, 'desktop')) {
    if (overrides.desktop) result.desktop = overrides.desktop
    else result.errors.desktop = 'disabled by injection'
  } else {
    try {
      const toolsModule = await importRelative('./lib/desktop/tools.js')
      if (typeof toolsModule.createDesktopTools !== 'function') {
        throw new TypeError('lib/desktop/tools.js does not export createDesktopTools()')
      }
      const powerModule = await importRelative('./lib/desktop/power.js')
      if (typeof powerModule.buildPowerPlan !== 'function' || typeof powerModule.executePower !== 'function') {
        throw new TypeError('lib/desktop/power.js does not export buildPowerPlan()/executePower()')
      }
      result.desktop = {
        createDesktopTools: toolsModule.createDesktopTools,
        buildPowerPlan: powerModule.buildPowerPlan,
        executePower: powerModule.executePower,
        DESKTOP_SCOPES: toolsModule.DESKTOP_SCOPES ?? null,
      }
    } catch (error) {
      result.errors.desktop = describeError(error)
    }
  }

  return result
}

// ---------------------------------------------------------------------------
// Audit adapters (one JSONL file, three writers)
// ---------------------------------------------------------------------------

function appendAudit(auditLog, entry) {
  try {
    auditLog.append(entry)
  } catch {
    // An unwritable audit log must not turn a denial into a crash.
  }
}

/** lib/browser/tools.js calls audit.record({ tool, scope, kind, target, decision, code, message }). */
function createBrowseAuditAdapter(auditLog) {
  return {
    record(entry) {
      const source = entry && typeof entry === 'object' ? entry : {}
      const allowed = source.decision === 'allow'
      appendAudit(auditLog, {
        scope: typeof source.scope === 'string' ? source.scope : 'browse.read',
        kind: typeof source.kind === 'string' && source.kind.length > 0 ? source.kind : source.tool ?? 'browse',
        target: source.target ?? '',
        result: allowed ? 'allow' : 'deny',
        reason: allowed ? 'allowed' : `${source.code ?? 'DENIED'}: ${source.message ?? ''}`,
      })
    },
  }
}

/**
 * lib/desktop/tools.js calls audit.append({ type, tool, action, code, message, meta }).
 * Only the policy-relevant coordinates are kept.
 */
function createDesktopAuditAdapter(auditLog) {
  return {
    append(entry) {
      const source = entry && typeof entry === 'object' ? entry : {}
      const action = source.action && typeof source.action === 'object' ? source.action : {}
      const denied = source.type === 'desktop.denied'
      appendAudit(auditLog, {
        scope: typeof action.scope === 'string' ? action.scope : '',
        kind: typeof source.tool === 'string' ? source.tool : action.kind ?? '',
        target: action.target ?? '',
        result: denied ? 'deny' : 'allow',
        reason: denied ? `${source.code ?? 'DENIED'}: ${source.message ?? ''}` : String(source.type ?? 'desktop.allow'),
      })
    },
  }
}

// ---------------------------------------------------------------------------
// Power confirmation gate (env token, one-time per process)
// ---------------------------------------------------------------------------

/**
 * The policy requires a one-time confirmation token for `os.power`. This plugin
 * has no token-issuing tool on purpose: the operator supplies the token out of
 * band via `DSH_POWER_CONFIRM_TOKEN`, and the same string must be passed as
 * `confirmToken` to `power_action`. Each token is accepted once per process.
 */
export function createEnvConfirmGate({ env = process.env } = {}) {
  const used = new Set()

  function expectedToken() {
    let raw
    try {
      raw = env?.DSH_POWER_CONFIRM_TOKEN
    } catch {
      return null
    }
    return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : null
  }

  function matches(token) {
    const expected = expectedToken()
    if (expected === null) return false
    if (typeof token !== 'string' || token.trim().length === 0) return false
    const given = token.trim()
    return given === expected && !used.has(given)
  }

  return {
    request() {
      throw new Error(
        'power confirmation tokens are issued out of band via DSH_POWER_CONFIRM_TOKEN; there is no in-process request tool',
      )
    },
    peek(token) {
      return matches(token)
    },
    consume(token) {
      if (!matches(token)) return false
      used.add(token.trim())
      return true
    },
  }
}

// ---------------------------------------------------------------------------
// Policy adapters
// ---------------------------------------------------------------------------

/** Desktop tools address pseudo-targets; the policy validates browse hosts. */
export function desktopPolicyTarget(kind) {
  const label = typeof kind === 'string' && kind.length > 0 ? kind : 'desktop'
  return `https://${DESKTOP_SENTINEL_HOST}/${encodeURIComponent(label)}`
}

/**
 * Wrap the shared policy so desktop actions keep their meaning without becoming
 * browser hosts: browse scopes are re-targeted to the internal sentinel host.
 * `app.launch` and `os.power` keep their real targets.
 */
export function createDesktopPolicy(policy) {
  return {
    check(action) {
      const source = action && typeof action === 'object' ? action : {}
      if (source.scope === 'browse.read' || source.scope === 'browse.interact') {
        return policy.check({ ...source, target: desktopPolicyTarget(source.kind) })
      }
      return policy.check(source)
    },
  }
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

function defaultLog(message) {
  try {
    console.warn(`[social-desktop-agent] ${message}`)
  } catch {
    // Logging must never break the host.
  }
}

const JSON_OUTPUT = {
  schema: { type: 'object' },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
}

function asResultObject(value, toolName) {
  if (value === null || value === undefined) return { ok: true, tool: toolName }
  if (typeof value !== 'object') return { ok: true, tool: toolName, value }
  return value
}

function failureResult(toolName, error) {
  const code = typeof error?.code === 'string' && error.code.length > 0 ? error.code : 'TOOL_ERROR'
  const message = typeof error?.message === 'string' && error.message.length > 0 ? error.message : String(error)
  return { ok: false, tool: toolName, code, message }
}

/**
 * Build a runtime around a host context. `register()` resolves after every
 * available tool has been registered; call `dispose()` to unregister them.
 *
 * @param {{
 *   ctx: any,
 *   config?: Record<string, unknown>,
 *   modules?: { core?: unknown, browser?: unknown, desktop?: unknown },
 *   deps?: { desktopRunner?: unknown, browserDriver?: unknown },
 *   env?: NodeJS.ProcessEnv,
 *   now?: () => number,
 *   log?: (message: string) => void,
 * }} options
 */
export function createRuntime(options = {}) {
  const ctx = options.ctx
  const settings = resolveConfig(options.config ?? {})
  const deps = options.deps ?? {}
  const env = options.env ?? process.env
  const now = typeof options.now === 'function' ? options.now : undefined
  const log = typeof options.log === 'function' ? options.log : defaultLog

  const diagnostics = {
    registered: [],
    skipped: [],
    warnings: [],
    categories: { browser: 'pending', desktop: 'pending', core: 'pending' },
  }
  const disposers = []
  let disposed = false
  let auditLog = null
  let policy = null
  let browse = null
  let desktop = null
  let loadResult = null

  function warn(message) {
    diagnostics.warnings.push(message)
    log(message)
  }

  function skip(names, reason) {
    for (const toolName of names) {
      diagnostics.skipped.push({ tool: toolName, reason })
    }
  }

  function registerTool(spec, handler) {
    const tools = ctx?.tools
    if (!tools || typeof tools.register !== 'function') {
      throw new TypeError('host context does not expose ctx.tools.register()')
    }
    const disposer = tools.register({
      name: spec.name,
      description: spec.description,
      parameters: spec.parameters ?? NO_ARGS,
      output: JSON_OUTPUT,
      timeoutMs: spec.timeoutMs ?? 60_000,
      presentCall: () => ({ card: 'generic', title: spec.title ?? spec.name, kind: 'other' }),
      async execute(args, exec) {
        try {
          const value = await handler(args ?? {}, exec)
          return asResultObject(value, spec.name)
        } catch (error) {
          return failureResult(spec.name, error)
        }
      },
    })
    if (typeof disposer === 'function') disposers.push(disposer)
    diagnostics.registered.push(spec.name)
  }

  async function registerBrowser(browserModule) {
    const specs = TOOL_SPECS.filter((spec) => spec.category === 'browser')
    try {
      if (typeof browserModule.createBrowseTools !== 'function') {
        throw new TypeError('browser module does not export createBrowseTools()')
      }
      const resolvedDriver =
        deps.browserDriver ??
        (settings.browserDriver === 'cdp'
          ? await browserModule
              .loadCdpDriver()
              .then((factory) =>
                factory({ port: settings.cdpPort, allowShell: settings.cdpAllowPageTargets === true }),
              )
          : await browserModule.loadStubDriver().then((factory) => factory({})))
      browse = browserModule.createBrowseTools({
        driver: resolvedDriver,
        policy,
        allowlist: settings.allowlist.hosts,
        audit: createBrowseAuditAdapter(auditLog),
        clock: now ?? (() => Date.now()),
      })
      for (const spec of specs) {
        const handler = browse[spec.name]
        if (typeof handler !== 'function') {
          skip([spec.name], 'browser module does not expose this handler')
          continue
        }
        registerTool(spec, (args) => handler(args))
      }
      diagnostics.categories.browser = 'ready'
    } catch (error) {
      diagnostics.categories.browser = 'failed'
      const reason = `browser unavailable: ${describeError(error)}`
      warn(reason)
      skip(
        specs.map((spec) => spec.name),
        reason,
      )
    }
  }

  function registerDesktop(desktopModule) {
    const specs = TOOL_SPECS.filter((spec) => spec.category === 'desktop')
    try {
      if (typeof desktopModule.createDesktopTools !== 'function') {
        throw new TypeError('desktop module does not export createDesktopTools()')
      }
      if (
        typeof desktopModule.buildPowerPlan !== 'function' ||
        typeof desktopModule.executePower !== 'function'
      ) {
        throw new TypeError('desktop module does not export buildPowerPlan()/executePower()')
      }
      // Extra operator gate: when powerEnabled is false, DSH_ALLOW_POWER is
      // stripped from the environment the desktop layer sees, so executePower()
      // can only ever return a dry-run plan.
      const powerEnv = { ...env }
      if (!settings.powerEnabled) powerEnv.DSH_ALLOW_POWER = undefined

      desktop = desktopModule.createDesktopTools({
        policy: createDesktopPolicy(policy),
        audit: createDesktopAuditAdapter(auditLog),
        ...(deps.desktopRunner ? { runner: deps.desktopRunner } : {}),
        env: powerEnv,
      })

      const moduleTools = Array.isArray(desktop.tools) ? desktop.tools : []
      const byName = new Map(moduleTools.map((tool) => [tool.name, tool]))

      for (const spec of specs) {
        if (spec.name === 'power_action') continue // registered below with the real power target
        const definition = byName.get(spec.name)
        if (!definition || typeof definition.execute !== 'function') {
          skip([spec.name], 'desktop module does not expose this tool')
          continue
        }
        registerTool(spec, (args) => definition.execute(args))
      }

      // power_action needs `target: restart|shutdown` for the policy, while the
      // desktop module passes the generic 'os:power'. Register our own handler so
      // the power-target allowlist can actually narrow restart vs shutdown.
      registerTool(TOOL_SPEC_BY_NAME.get('power_action'), async (args) => {
        const plan = desktopModule.buildPowerPlan({
          action: args.action,
          delaySec: args.delaySec,
        })
        if (!plan.ok) return plan

        const policyTarget = plan.action === 'reboot' ? 'restart' : 'shutdown'
        const action = {
          scope: 'os.power',
          kind: 'power_action',
          target: policyTarget,
          ...(typeof args.confirmToken === 'string' ? { confirmToken: args.confirmToken } : {}),
        }

        // Enforce the policy (scope + rate limit + one-time confirmation token).
        try {
          policy.require(action)
        } catch (error) {
          return failureResult('power_action', error)
        }

        if (!settings.powerEnabled) {
          appendAudit(auditLog, {
            scope: 'os.power',
            kind: 'power_action',
            target: policyTarget,
            result: 'deny',
            reason: 'POWER_DISABLED: powerEnabled=false',
          })
          return {
            ok: true,
            executed: false,
            dryRun: true,
            action: plan.action,
            delaySec: plan.delaySec,
            wouldRun: plan.command,
            missing: ['config:powerEnabled'],
          }
        }

        const result = await desktopModule.executePower({
          action: plan.action,
          delaySec: plan.delaySec,
          scopeGranted: true,
          confirmToken: args.confirmToken,
          env: powerEnv,
          runner: desktop.runner,
        })
        appendAudit(auditLog, {
          scope: 'os.power',
          kind: 'power_action',
          target: policyTarget,
          result: 'allow',
          reason:
            result && result.executed === true
              ? 'executed'
              : `dry-run: ${(result?.missing ?? ['not executed']).join(',')}`,
        })
        return result
      })

      diagnostics.categories.desktop = 'ready'
    } catch (error) {
      diagnostics.categories.desktop = 'failed'
      const reason = `desktop unavailable: ${describeError(error)}`
      warn(reason)
      skip(
        specs.map((spec) => spec.name),
        reason,
      )
    }
    return undefined
  }

  async function register() {
    if (disposed) return diagnostics
    if (!settings.enabled) {
      warn('disabled by config; no tools registered')
      skip([...TOOL_NAMES], 'plugin disabled by config')
      return diagnostics
    }

    loadResult = await loadModules({ overrides: options.modules ?? {} })
    if (disposed) return diagnostics
    if (!loadResult.core) {
      const reason = `lib/core unavailable (${loadResult.errors.core ?? 'unknown'}); refusing to register any tool (fail closed)`
      diagnostics.categories.core = 'failed'
      warn(reason)
      skip([...TOOL_NAMES], reason)
      return diagnostics
    }
    diagnostics.categories.core = 'ready'

    try {
      auditLog = loadResult.core.createAuditLog({ file: settings.auditPath, ...(now ? { now } : {}) })
    } catch (error) {
      const reason = `audit log could not be created (${describeError(error)}); refusing to register any tool (fail closed)`
      diagnostics.categories.core = 'failed'
      warn(reason)
      skip([...TOOL_NAMES], reason)
      return diagnostics
    }

    try {
      const allow = {
        hosts: [...settings.allowlist.hosts, DESKTOP_SENTINEL_HOST],
        apps: [...settings.allowlist.apps],
      }
      policy = loadResult.core.createPolicy({
        scopes: settings.scopes,
        allowlist: allow,
        ...(settings.killSwitchFile ? { killSwitch: { file: settings.killSwitchFile } } : {}),
        audit: auditLog,
        confirm: createEnvConfirmGate({ env }),
        ...(now ? { now } : {}),
      })
    } catch (error) {
      const reason = `policy could not be created (${describeError(error)}); refusing to register any tool (fail closed)`
      diagnostics.categories.core = 'failed'
      warn(reason)
      skip([...TOOL_NAMES], reason)
      return diagnostics
    }

    if (loadResult.browser) {
      await registerBrowser(loadResult.browser)
    } else {
      diagnostics.categories.browser = 'missing'
      const reason = `browser layer unavailable: ${loadResult.errors.browser ?? 'not installed'}`
      warn(reason)
      skip(
        TOOL_SPECS.filter((spec) => spec.category === 'browser').map((spec) => spec.name),
        reason,
      )
    }

    if (loadResult.desktop) {
      registerDesktop(loadResult.desktop)
    } else {
      diagnostics.categories.desktop = 'missing'
      const reason = `desktop layer unavailable: ${loadResult.errors.desktop ?? 'not installed'}`
      warn(reason)
      skip(
        TOOL_SPECS.filter((spec) => spec.category === 'desktop').map((spec) => spec.name),
        reason,
      )
    }

    return diagnostics
  }

  function dispose() {
    if (disposed) return
    disposed = true
    while (disposers.length > 0) {
      const disposer = disposers.pop()
      try {
        disposer()
      } catch {
        // The tool registry may already be gone during host shutdown.
      }
    }
    diagnostics.registered.length = 0
  }

  function status() {
    return {
      plugin: name,
      settings: {
        enabled: settings.enabled,
        scopes: settings.scopes,
        allowlist: settings.allowlist,
        auditPath: settings.auditPath,
        killSwitchFile: settings.killSwitchFile,
        powerEnabled: settings.powerEnabled,
        browserDriver: settings.browserDriver,
      },
      categories: { ...diagnostics.categories },
      tools: {
        expected: [...TOOL_NAMES],
        registered: [...diagnostics.registered],
        skipped: diagnostics.skipped.map((entry) => ({ ...entry })),
      },
      warnings: [...diagnostics.warnings],
      policy: policy && typeof policy.snapshot === 'function' ? policy.snapshot() : null,
      moduleErrors: loadResult ? { ...loadResult.errors } : {},
    }
  }

  return {
    settings,
    diagnostics,
    register,
    dispose,
    status,
    get policy() {
      return policy
    },
    get audit() {
      return auditLog
    },
    get browse() {
      return browse
    },
    get desktop() {
      return desktop
    },
  }
}

// ---------------------------------------------------------------------------
// System prompt section
// ---------------------------------------------------------------------------

const SECTION_NAME = 'tool:social-desktop-agent'
/** After fanout (2550), before the workflow section (2600). */
const SECTION_ORDER = 2560

const PROMPT_SECTION = `## Social & desktop agent (dsh-social-desktop-agent)

This plugin grants a deliberately narrow set of browser and Windows-desktop tools. Treat its
denials as final and never try to route around them:

- \`browse_*\` — open/snapshot/click/type/scroll/screenshot/close on allowlisted hosts
  (instagram.com by default). Signing in is out of scope: on a login, 2FA, checkpoint or
  CAPTCHA wall the layer stops and returns \`NEEDS_HUMAN\`. Stop and ask the human.
- \`desktop_*\` — observe the screen/windows and move/click/type/press keys. These are
  destructive: observe before you click, and never type credentials.
- \`app_launch\` — only allowlisted app names; arbitrary paths/commands are rejected.
- \`power_action\` — dry run unless the os.power scope, a confirmation token, \`DSH_ALLOW_POWER=1\`
  and \`powerEnabled: true\` all hold. Report the returned plan instead of retrying.

Liking, following, DMing, posting and commenting are permanently refused. The kill switch
(\`DSH_KILL_SWITCH=1\` or the KILL_SWITCH file) stops every tool immediately.`

function hostWarn(ctx, message) {
  try {
    ctx?.logger?.warn?.(`social-desktop-agent: ${message}`)
  } catch {
    // ignore
  }
}

/**
 * Plugin entry point.
 *
 * @param {any} ctx Cordis context
 * @param {Record<string, unknown>} [rawConfig]
 */
async function applyAsync(ctx, rawConfig = {}) {
  const runtime = createRuntime({ ctx, config: rawConfig })

  if (typeof ctx?.effect === 'function') {
    try {
      ctx.effect(() => () => runtime.dispose())
    } catch (error) {
      hostWarn(ctx, `could not register unload hook: ${describeError(error)}`)
    }
  }

  const enabled = runtime.settings.enabled
  if (enabled) {
    let systemPrompt
    try {
      systemPrompt = typeof ctx?.get === 'function' ? ctx.get('systemPrompt') : ctx?.systemPrompt
    } catch {
      systemPrompt = undefined
    }
    if (systemPrompt && typeof systemPrompt.section === 'function') {
      try {
        systemPrompt.section({ name: SECTION_NAME, order: SECTION_ORDER, text: PROMPT_SECTION })
      } catch (error) {
        hostWarn(ctx, `system prompt section failed: ${describeError(error)}`)
      }
    }
  }

  try {
    await runtime.register()
  } catch (error) {
    hostWarn(ctx, `registration failed: ${describeError(error)}`)
  }

  const summary = runtime.status()
  if (summary.tools.registered.length === 0) {
    hostWarn(ctx, `no tools registered (${summary.warnings.at(-1) ?? 'see warnings'})`)
  } else {
    try {
      console.log(
        `[social-desktop-agent] active: ${summary.tools.registered.length}/${TOOL_NAMES.length} tools, scopes=${summary.settings.scopes.join(',') || 'none'}, driver=${summary.settings.browserDriver}`,
      )
    } catch {
      // console may be unavailable in some hosts
    }
  }
}

/**
 * Plugin entry point.
 *
 * Declared as a plain (non-`async`) function to match the repository plugin
 * convention (`scripts/check-plugin.ps1` looks for `export function apply`), and
 * because Cordis awaits a promise returned from `apply()` anyway: registration
 * completes before the plugin is considered ready, and `await apply(...)` in
 * tests keeps working. The async body lives in `applyAsync`.
 *
 * @param {any} ctx Cordis context
 * @param {Record<string, unknown>} [rawConfig]
 * @returns {Promise<void>}
 */
export function apply(ctx, rawConfig = {}) {
  return applyAsync(ctx, rawConfig)
}

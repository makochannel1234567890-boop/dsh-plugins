/**
 * dsh-social-desktop-agent / lib/desktop/tools.js
 *
 * The agent-facing tool surface for the Windows desktop layer.
 *
 * Tools (7):
 *   desktop_observe, desktop_move, desktop_click, desktop_type, desktop_key,
 *   app_launch, power_action
 *
 * Dependency injection contract (fixed by the project):
 *   createDesktopTools({ policy, audit, confirm, runner })
 *     - policy: { check(action) => { ok:true } | { ok:false, code, message } }
 *     - audit:  { append(entry) => void|Promise }
 *     - confirm: token string | { token } | { verify(ctx) } | (ctx) => boolean
 *     - runner: lib/desktop/win.js runner (default); tests pass a fake with the
 *               same methods, so nothing touches the real machine.
 *
 * Every action is represented as `{ scope, kind, target }` before it runs.
 * The scope mapping (documented for the policy author):
 *   desktop_observe            -> browse.read          (target = 'desktop')
 *   desktop_move/click/type/key-> browse.interact      (target = 'desktop:screen' | 'desktop:input')
 *   app_launch                 -> app.launch           (target = allowlisted app name, e.g. 'notepad')
 *   power_action               -> os.power             (target = 'shutdown' | 'restart')
 *
 * Integration note: lib/core/policy.js addresses `browse.*` scopes by host and
 * `os.power` by 'restart'/'shutdown', so desktop_* kinds need a policy that is
 * aware of OS actions (for example `policy: (action) => …` — the function form
 * is accepted here and is the recommended hook for calling core `require()` so
 * rate and confirmation tokens are actually consumed). app_launch and
 * power_action already match the core target checks; power_action additionally
 * copies `confirmToken` onto the action, which is where the core reads it.
 *
 * Fail-closed rules:
 *   - no policy (or a throwing policy) => the action is denied;
 *   - a denied action never reaches the runner;
 *   - if the audit log cannot be written the operation reports AUDIT_FAILED;
 *   - power_action is dry-run unless all three gates pass (see power.js).
 */

import { createRunner, toDesktopError } from './win.js';
import { createObserver } from './observe.js';
import { createInput } from './input.js';
import { createAppLauncher, listLaunchableApps, resolveApp } from './apps.js';
import { createFocuser, normalizeFocusTarget } from './focus.js';
import { POWER_SCOPE, executePower } from './power.js';

/** Scope names (fixed by the shared action contract). */
export const DESKTOP_SCOPES = Object.freeze({
  read: 'browse.read',
  interact: 'browse.interact',
  appLaunch: 'app.launch',
  power: 'os.power',
});

export const TOOL_NAMES = Object.freeze([
  'desktop_observe',
  'desktop_focus',
  'desktop_move',
  'desktop_click',
  'desktop_type',
  'desktop_key',
  'app_launch',
  'power_action',
]);

const AUDIT_LIMIT = 500;

/**
 * In-memory audit sink used when no remote audit logger is injected.
 * `entries` is exposed so tests (and the dry-run script) can inspect it.
 */
export function createMemoryAudit(limit = AUDIT_LIMIT) {
  /** @type {any[]} */
  const entries = [];
  return {
    entries,
    /** @param {any} entry */
    append(entry) {
      entries.push(entry);
      if (entries.length > limit) entries.shift();
    },
    list() {
      return entries.slice();
    },
  };
}

/**
 * Normalise the audit DI into `{ append, list }`.
 * @param {unknown} audit
 */
function normalizeAudit(audit) {
  if (audit && typeof audit === 'object' && typeof audit.append === 'function') {
    return audit;
  }
  if (typeof audit === 'function') {
    return {
      append: audit,
      list: () => [],
    };
  }
  return createMemoryAudit();
}

/**
 * Normalise the policy DI into a single async check function.
 * @param {unknown} policy
 * @returns {(action: { scope:string, kind:string, target:string }) => Promise<{ ok:boolean, code?:string, message?:string }>}
 */
function normalizePolicy(policy) {
  const check =
    typeof policy === 'function'
      ? policy
      : policy && typeof (/** @type {any} */ (policy).check) === 'function'
        ? /** @type {any} */ (policy).check.bind(policy)
        : null;

  if (!check) {
    return async () => ({
      ok: false,
      code: 'POLICY_NOT_CONFIGURED',
      message: 'no policy was injected; desktop actions are denied by default',
    });
  }

  return async (action) => {
    try {
      const verdict = await check(action);
      if (verdict === true) return { ok: true };
      if (verdict && typeof verdict === 'object') {
        if (verdict.ok === true) return { ok: true };
        if (verdict.allowed === true) return { ok: true };
        return {
          ok: false,
          code: typeof verdict.code === 'string' ? verdict.code : 'POLICY_DENIED',
          message: typeof verdict.message === 'string' ? verdict.message : 'action denied by policy',
        };
      }
      return { ok: false, code: 'POLICY_DENIED', message: 'action denied by policy' };
    } catch (error) {
      return {
        ok: false,
        code: 'POLICY_ERROR',
        message: `policy check threw: ${toDesktopError(error).message}`,
      };
    }
  };
}

/** @param {unknown} value @param {number} [limit] */
function short(value, limit = 300) {
  if (value === undefined || value === null) return null;
  const text = String(value);
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/**
 * @param {{
 *   policy?: unknown,
 *   audit?: unknown,
 *   confirm?: unknown,
 *   runner?: ReturnType<typeof createRunner>,
 *   observer?: ReturnType<typeof createObserver>,
 *   input?: ReturnType<typeof createInput>,
 *   env?: NodeJS.ProcessEnv,
 *   platform?: NodeJS.Platform,
 * }} [deps]
 */
export function createDesktopTools(deps = {}) {
  const runner = deps.runner ?? createRunner();
  const platform = deps.platform ?? runner.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const observer = deps.observer ?? createObserver({ runner, platform });
  const input = deps.input ?? createInput({ runner, observer, platform });
  const appLauncher = createAppLauncher({ runner, platform });
  const focuser = createFocuser({ runner });
  const checkPolicy = normalizePolicy(deps.policy);
  const audit = normalizeAudit(deps.audit);
  const confirm = deps.confirm;

  /** @type {string[]} */
  const auditErrors = [];

  /**
   * @param {any} entry
   * @returns {Promise<boolean>} true when the entry was persisted
   */
  async function record(entry) {
    try {
      await audit.append({ ts: new Date().toISOString(), pid: process.pid, ...entry });
      return true;
    } catch (error) {
      auditErrors.push(`${new Date().toISOString()} ${toDesktopError(error).message}`);
      return false;
    }
  }

  /**
   * @param {{
   *   tool: string,
   *   scope: string,
   *   kind: string,
   *   target: string,
   *   meta?: Record<string, unknown>,
   *   execute: () => Promise<any>,
   *   auditMeta?: (result: any) => Record<string, unknown>,
   * }} context
   */
  async function runGuarded(context) {
    const action = { scope: context.scope, kind: context.kind, target: context.target };
    const policy = await checkPolicy(action);

    if (!policy.ok) {
      const denied = {
        ok: false,
        blocked: true,
        code: policy.code ?? 'POLICY_DENIED',
        message: policy.message ?? 'action denied by policy',
        action,
      };
      await record({
        type: 'desktop.denied',
        tool: context.tool,
        action,
        code: denied.code,
        message: short(denied.message),
      });
      return denied;
    }

    let result;
    try {
      result = await context.execute();
    } catch (error) {
      result = toDesktopError(error, 'TOOL_FAILED').toJSON();
    }
    if (!result || typeof result !== 'object') {
      result = { ok: true, value: result ?? null };
    }

    const ok = result.ok !== false;
    const extra = typeof context.auditMeta === 'function' ? context.auditMeta(result) : {};
    const audited = await record({
      type: ok ? 'desktop.ok' : 'desktop.failed',
      tool: context.tool,
      action,
      ok,
      code: result.code ?? null,
      message: short(result.message),
      ...extra,
    });
    if (!audited) {
      return {
        ok: false,
        code: 'AUDIT_FAILED',
        message: 'audit log write failed; the action result is shown but was not logged',
        result,
      };
    }
    return result;
  }

  async function powerAction(rawInput = {}) {
    const requested =
      typeof rawInput.action === 'string' ? rawInput.action.trim().toLowerCase() : '';
    // The core policy names power targets 'restart' | 'shutdown'; keep the public
    // action vocabulary ('reboot' | 'shutdown') and translate only the target.
    const policyTarget = requested === 'shutdown' ? 'shutdown' : requested === '' ? '' : 'restart';
    const confirmToken =
      typeof (rawInput.confirmToken ?? rawInput.token) === 'string'
        ? String(rawInput.confirmToken ?? rawInput.token)
        : undefined;
    const action = {
      scope: POWER_SCOPE,
      kind: 'power_action',
      target: policyTarget,
      ...(confirmToken ? { confirmToken } : {}),
    };
    const policy = await checkPolicy(action);
    const scopeGranted = policy.ok === true;

    let result;
    try {
      result = await executePower({
        action: rawInput.action,
        delaySec: rawInput.delaySec,
        scopeGranted,
        confirm,
        confirmToken: rawInput.confirmToken ?? rawInput.token,
        env,
        runner,
      });
    } catch (error) {
      result = toDesktopError(error, 'POWER_FAILED').toJSON();
    }

    const type = result.executed === true ? 'power.executed' : result.dryRun === true ? 'power.dry-run' : 'power.failed';
    const audited = await record({
      type,
      tool: 'power_action',
      action,
      ok: result.ok !== false,
      code: result.code ?? null,
      message: short(result.message ?? (result.dryRun ? 'dry-run only' : result.command ?? '')),
      meta: {
        requested: short(rawInput.action, 40),
        delaySec: result.delaySec ?? null,
        command: result.command ?? result.wouldRun ?? null,
        missing: Array.isArray(result.missing) ? result.missing : null,
        policyCode: policy.ok ? null : policy.code ?? 'POLICY_DENIED',
        executed: result.executed === true,
      },
    });
    if (!audited) {
      return {
        ok: false,
        code: 'AUDIT_FAILED',
        message: 'audit log write failed; power result withheld',
        result,
      };
    }
    return result;
  }

  const tools = [
    {
      name: 'desktop_observe',
      description:
        'Observe the Windows desktop: cursor position, virtual screen and monitor rectangles, visible window titles, and the foreground window. Read-only.',
      scope: DESKTOP_SCOPES.read,
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: 'object',
        properties: {
          maxWindows: { type: 'integer', minimum: 1, maximum: 300 },
        },
        additionalProperties: false,
      },
      async execute(rawInput = {}) {
        const requested = Number(rawInput.maxWindows);
        const limit = Number.isInteger(requested) ? Math.min(Math.max(requested, 1), 300) : undefined;
        return runGuarded({
          tool: 'desktop_observe',
          scope: DESKTOP_SCOPES.read,
          kind: 'desktop_observe',
          target: 'desktop',
          execute: async () => {
            const snapshot = await observer.observe();
            if (!snapshot.ok) return snapshot;
            if (limit !== undefined) snapshot.windows = snapshot.windows.slice(0, limit);
            return snapshot;
          },
          auditMeta: (result) => ({
            meta: {
              cursor: result.cursor ?? null,
              windowCount: Array.isArray(result.windows) ? result.windows.length : 0,
              monitorCount: result.metrics?.monitorCount ?? null,
            },
          }),
        });
      },
    },
    {
      name: 'desktop_focus',
      description:
        'Bring an allowlisted window to the foreground and report whether it really became the foreground window. Call this before desktop_type / desktop_key / desktop_click when you are not certain which window has focus; typing without focusing is how keystrokes end up in the wrong app.',
      scope: DESKTOP_SCOPES.interact,
      inputSchema: {
        type: 'object',
        properties: {
          pid: { type: 'integer', minimum: 1 },
          title: { type: 'string', minLength: 1, maxLength: 200 },
        },
        additionalProperties: false,
      },
      async execute(rawInput = {}) {
        let target;
        try {
          target = normalizeFocusTarget(rawInput);
        } catch (error) {
          const failure = toDesktopError(error);
          return { ok: false, code: failure.code, message: failure.message };
        }
        return runGuarded({
          tool: 'desktop_focus',
          scope: DESKTOP_SCOPES.interact,
          kind: 'desktop_focus',
          target: `desktop:window:${target.pid ?? ''}${target.title ? `:${target.title}` : ''}`,
          execute: () => focuser.focus(target),
          auditMeta: (result) => ({
            focused: result?.focused === true,
            pid: result?.pid ?? target.pid ?? null,
            title: short(result?.title ?? target.title ?? '', 120),
          }),
        });
      },
    },
    {
      name: 'desktop_move',
      description:
        'Move the mouse cursor to a virtual-screen coordinate. Coordinates are clamped to the screen; points far outside are rejected.',
      scope: DESKTOP_SCOPES.interact,
      inputSchema: {
        type: 'object',
        properties: {
          x: { type: 'number' },
          y: { type: 'number' },
        },
        required: ['x', 'y'],
        additionalProperties: false,
      },
      async execute(rawInput = {}) {
        return runGuarded({
          tool: 'desktop_move',
          scope: DESKTOP_SCOPES.interact,
          kind: 'desktop_move',
          target: 'desktop:screen',
          execute: () => input.move({ x: rawInput.x, y: rawInput.y }),
          auditMeta: (result) => ({
            meta: {
              requested: { x: rawInput.x, y: rawInput.y },
              resolved: result.ok ? { x: result.x, y: result.y } : null,
              clamped: result.clamped === true,
            },
          }),
        });
      },
    },
    {
      name: 'desktop_click',
      description:
        'Move the cursor to a coordinate and click a mouse button (left/right/middle), optionally repeated 1-3 times for a double/triple click.',
      scope: DESKTOP_SCOPES.interact,
      inputSchema: {
        type: 'object',
        properties: {
          x: { type: 'number' },
          y: { type: 'number' },
          button: { type: 'string', enum: ['left', 'right', 'middle'] },
          count: { type: 'integer', minimum: 1, maximum: 3 },
        },
        required: ['x', 'y'],
        additionalProperties: false,
      },
      async execute(rawInput = {}) {
        return runGuarded({
          tool: 'desktop_click',
          scope: DESKTOP_SCOPES.interact,
          kind: 'desktop_click',
          target: 'desktop:screen',
          execute: () =>
            input.click({ x: rawInput.x, y: rawInput.y, button: rawInput.button, count: rawInput.count }),
          auditMeta: (result) => ({
            meta: {
              requested: { x: rawInput.x, y: rawInput.y },
              resolved: result.ok ? { x: result.x, y: result.y } : null,
              button: rawInput.button ?? 'left',
              count: rawInput.count ?? 1,
              clamped: result.clamped === true,
            },
          }),
        });
      },
    },
    {
      name: 'desktop_type',
      description:
        'Type text into the focused window. The text is escaped for SendKeys and is not written to the audit log (only its length).',
      scope: DESKTOP_SCOPES.interact,
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', minLength: 1, maxLength: 2000 },
        },
        required: ['text'],
        additionalProperties: false,
      },
      async execute(rawInput = {}) {
        return runGuarded({
          tool: 'desktop_type',
          scope: DESKTOP_SCOPES.interact,
          kind: 'desktop_type',
          target: 'desktop:input',
          execute: () => input.type({ text: rawInput.text }),
          auditMeta: () => ({
            meta: {
              length: typeof rawInput.text === 'string' ? rawInput.text.length : 0,
              redacted: true,
            },
          }),
        });
      },
    },
    {
      name: 'desktop_key',
      description:
        'Press one allowlisted key (enter, tab, esc, arrows, F1-F12, letters/digits) with optional ctrl/alt/shift modifiers.',
      scope: DESKTOP_SCOPES.interact,
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          modifiers: {
            type: 'array',
            items: { type: 'string', enum: ['ctrl', 'alt', 'shift'] },
            maxItems: 3,
          },
        },
        required: ['key'],
        additionalProperties: false,
      },
      async execute(rawInput = {}) {
        return runGuarded({
          tool: 'desktop_key',
          scope: DESKTOP_SCOPES.interact,
          kind: 'desktop_key',
          target: 'desktop:input',
          execute: () => input.key({ key: rawInput.key, modifiers: rawInput.modifiers }),
          auditMeta: () => ({
            meta: {
              key: short(rawInput.key, 40),
              modifiers: Array.isArray(rawInput.modifiers) ? rawInput.modifiers.slice(0, 3) : [],
            },
          }),
        });
      },
    },
    {
      name: 'app_launch',
      description:
        'Launch an allowlisted desktop application by name (notepad, calc, explorer, mspaint, chrome, msedge, code). Arbitrary paths or commands are rejected.',
      scope: DESKTOP_SCOPES.appLaunch,
      inputSchema: {
        type: 'object',
        properties: {
          app: { type: 'string' },
        },
        required: ['app'],
        additionalProperties: false,
      },
      async execute(rawInput = {}) {
        // Target the canonical allowlist *name* ('notepad'): index.js configures the
        // core policy with short names, while the launcher resolves the executable.
        const resolution = resolveApp(rawInput.app);
        const target = resolution.ok
          ? resolution.name
          : typeof rawInput.app === 'string'
            ? rawInput.app.trim().toLowerCase()
            : '';
        return runGuarded({
          tool: 'app_launch',
          scope: DESKTOP_SCOPES.appLaunch,
          kind: 'app_launch',
          target,
          execute: () => appLauncher.launch(rawInput.app),
          auditMeta: (result) => ({
            meta: {
              app: result.name ?? short(rawInput.app, 64),
              command: result.command ?? null,
            },
          }),
        });
      },
    },
    {
      name: 'power_action',
      description:
        'Schedule a Windows shutdown or reboot. Executed only when the os.power scope is granted, the confirmation token matches, and DSH_ALLOW_POWER=1; otherwise returns a dry-run plan. delaySec defaults to 60 seconds.',
      scope: POWER_SCOPE,
      annotations: { destructiveHint: true },
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['reboot', 'shutdown'] },
          delaySec: { type: 'integer', minimum: 0, maximum: 86400 },
          confirmToken: { type: 'string' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      execute: powerAction,
    },
  ];

  /** @type {Record<string, (input?: any) => Promise<any>>} */
  const handlers = Object.fromEntries(tools.map((tool) => [tool.name, (input) => tool.execute(input ?? {})]));
  /** @type {Record<string, (typeof tools)[number]>} */
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));

  return {
    tools,
    byName,
    handlers,
    scopes: DESKTOP_SCOPES,
    launchableApps: listLaunchableApps(),
    getAuditEntries() {
      const listed = typeof audit.list === 'function' ? audit.list() : Array.isArray(audit.entries) ? audit.entries : [];
      return Array.isArray(listed) ? listed.slice() : [];
    },
    getAuditErrors() {
      return auditErrors.slice();
    },
    runner,
    observer,
    input,
    appLauncher,
    checkPolicy,
    platform,
  };
}

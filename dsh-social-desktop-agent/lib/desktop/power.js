/**
 * dsh-social-desktop-agent / lib/desktop/power.js
 *
 * Reboot / shutdown, behind three independent gates.
 *
 * A power action is only executed when ALL of these hold:
 *   1. the policy granted the `os.power` scope;
 *   2. the confirmation token matches (confirm DI: token string, verify(), or a
 *      function; also `DSH_POWER_CONFIRM_TOKEN` as a CLI fallback);
 *   3. the environment variable `DSH_ALLOW_POWER=1` is present.
 *
 * When any gate is missing NOTHING is executed. Instead the caller receives
 *   { dryRun: true, wouldRun: 'shutdown /s /t 60', missing: [...] }
 * which is also the default behaviour on a machine that was not explicitly
 * armed. There is no "force" switch.
 *
 * The command itself is always assembled from constants:
 *   shutdown.exe /s /t <delay>   (shutdown)
 *   shutdown.exe /r /t <delay>   (reboot)
 * `delaySec` is validated as an integer in [0, 86400] before it can appear in an
 * argv element.
 */

import { DesktopError, createRunner, toDesktopError } from './win.js';

export const POWER_SCOPE = 'os.power';
export const POWER_ENV_FLAG = 'DSH_ALLOW_POWER';
export const POWER_CONFIRM_ENV = 'DSH_POWER_CONFIRM_TOKEN';
export const POWER_EXECUTABLE = 'shutdown.exe';
export const DEFAULT_DELAY_SEC = 60;
export const MAX_DELAY_SEC = 86_400;

/** Supported power actions, frozen. */
export const POWER_ACTIONS = Object.freeze({
  shutdown: Object.freeze({ flag: '/s', verb: 'shutdown' }),
  reboot: Object.freeze({ flag: '/r', verb: 'reboot' }),
});

/** Accepted aliases (still resolved to a canonical action). */
const POWER_ALIASES = Object.freeze({ restart: 'reboot', poweroff: 'shutdown' });

/**
 * @param {unknown} value
 * @returns {'shutdown'|'reboot'}
 */
export function normalizePowerAction(value) {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  const canonical = POWER_ALIASES[raw] ?? raw;
  if (!Object.prototype.hasOwnProperty.call(POWER_ACTIONS, canonical)) {
    throw new DesktopError('INVALID_POWER_ACTION', 'power action must be reboot or shutdown', {
      action: typeof value === 'string' ? value.slice(0, 40) : value,
    });
  }
  return /** @type {'shutdown'|'reboot'} */ (canonical);
}

/**
 * @param {unknown} [value]
 * @returns {number}
 */
export function normalizeDelaySec(value = DEFAULT_DELAY_SEC) {
  let num = value;
  if (typeof num === 'string' && num.trim() !== '') num = Number(num.trim());
  if (typeof num !== 'number' || !Number.isInteger(num) || num < 0 || num > MAX_DELAY_SEC) {
    throw new DesktopError('INVALID_DELAY', `delaySec must be an integer between 0 and ${MAX_DELAY_SEC}`, {
      delaySec: value,
    });
  }
  return num;
}

/**
 * Build the exact command that would be run. Pure function (no side effects).
 * @param {{ action?: unknown, delaySec?: unknown }} [input]
 * @returns {{ ok:true, action:'shutdown'|'reboot', delaySec:number, executable:string, args:string[], command:string }
 *          | { ok:false, code:string, message:string, details:object }}
 */
export function buildPowerPlan(input = {}) {
  try {
    const action = normalizePowerAction(input.action);
    const delaySec = normalizeDelaySec(input.delaySec);
    const spec = POWER_ACTIONS[action];
    const args = [spec.flag, '/t', String(delaySec)];
    return {
      ok: true,
      action,
      delaySec,
      executable: POWER_EXECUTABLE,
      args,
      command: `${POWER_EXECUTABLE.replace(/\.exe$/i, '')} ${args.join(' ')}`,
    };
  } catch (error) {
    return toDesktopError(error, 'INVALID_POWER_PLAN').toJSON();
  }
}

/**
 * Verify the confirmation token against the injected confirm sink.
 * @param {{
 *   confirm?: unknown,
 *   token?: unknown,
 *   env?: NodeJS.ProcessEnv,
 *   action?: string,
 *   plan?: unknown,
 * }} context
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 */
export async function verifyConfirmToken(context = {}) {
  const provided = typeof context.token === 'string' ? context.token : '';
  const envExpectedRaw = context.env?.[POWER_CONFIRM_ENV];
  const envExpected = typeof envExpectedRaw === 'string' && envExpectedRaw.length > 0 ? envExpectedRaw : null;
  const confirm = context.confirm;
  const payload = { action: context.action, plan: context.plan, token: provided };

  try {
    if (typeof confirm === 'function') {
      return { ok: (await confirm(payload)) === true };
    }
    if (typeof confirm === 'string' && confirm.length > 0) {
      return { ok: provided.length > 0 && provided === confirm };
    }
    if (confirm && typeof confirm === 'object') {
      if (typeof confirm.verify === 'function') {
        return { ok: (await confirm.verify(payload)) === true };
      }
      const expectedFromConfirm =
        typeof confirm.token === 'string'
          ? confirm.token
          : typeof confirm.expectedToken === 'string'
            ? confirm.expectedToken
            : null;
      if (expectedFromConfirm && expectedFromConfirm.length > 0) {
        return { ok: provided.length > 0 && provided === expectedFromConfirm };
      }
      if (typeof confirm.getToken === 'function') {
        const expected = await confirm.getToken({ action: context.action, plan: context.plan });
        if (typeof expected === 'string' && expected.length > 0) {
          return { ok: provided.length > 0 && provided === expected };
        }
      }
    }
    if (envExpected) {
      return { ok: provided.length > 0 && provided === envExpected };
    }
    return { ok: false, reason: 'confirm_not_configured' };
  } catch (error) {
    return { ok: false, reason: `confirm_error:${toDesktopError(error).code}` };
  }
}

/**
 * Evaluate the three gates without executing anything.
 * @param {{
 *   scopeGranted?: boolean,
 *   confirm?: unknown,
 *   token?: unknown,
 *   env?: NodeJS.ProcessEnv,
 *   action?: string,
 *   plan?: unknown,
 * }} [context]
 * @returns {Promise<{ ok:boolean, missing:string[], confirmReason?:string }>}
 */
export async function evaluatePowerGates(context = {}) {
  const missing = [];
  if (context.scopeGranted !== true) missing.push('scope:os.power');

  const confirm = await verifyConfirmToken(context);
  if (!confirm.ok) missing.push('confirm_token');

  if (context.env?.[POWER_ENV_FLAG] !== '1') missing.push(`env:${POWER_ENV_FLAG}`);

  return { ok: missing.length === 0, missing, ...(confirm.reason ? { confirmReason: confirm.reason } : {}) };
}

/**
 * Run (or dry-run) a power action.
 *
 * @param {{
 *   action?: unknown,
 *   delaySec?: unknown,
 *   scopeGranted?: boolean,
 *   confirm?: unknown,
 *   confirmToken?: unknown,
 *   env?: NodeJS.ProcessEnv,
 *   runner?: ReturnType<typeof createRunner>,
 * }} [options]
 */
export async function executePower(options = {}) {
  const plan = buildPowerPlan({ action: options.action, delaySec: options.delaySec });
  if (!plan.ok) return plan;

  const env = options.env ?? process.env;
  const gates = await evaluatePowerGates({
    scopeGranted: options.scopeGranted,
    confirm: options.confirm,
    token: options.confirmToken,
    env,
    action: plan.action,
    plan,
  });

  if (!gates.ok) {
    return {
      ok: true,
      executed: false,
      dryRun: true,
      action: plan.action,
      delaySec: plan.delaySec,
      wouldRun: plan.command,
      executable: plan.executable,
      args: plan.args,
      missing: gates.missing,
      ...(gates.confirmReason ? { confirmReason: gates.confirmReason } : {}),
    };
  }

  const runner = options.runner ?? createRunner();
  try {
    const result = await runner.runProgram(plan.executable, plan.args, { timeout: 15_000 });
    return {
      ok: true,
      executed: true,
      dryRun: false,
      action: plan.action,
      delaySec: plan.delaySec,
      command: plan.command,
      executable: plan.executable,
      args: plan.args,
      stdout: String(result?.stdout ?? '').trim().slice(0, 500),
      at: new Date().toISOString(),
    };
  } catch (error) {
    const failure = toDesktopError(error, 'POWER_EXECUTION_FAILED');
    return {
      ...failure.toJSON(),
      executed: false,
      attempted: true,
      action: plan.action,
      delaySec: plan.delaySec,
      command: plan.command,
      executable: plan.executable,
      args: plan.args,
    };
  }
}

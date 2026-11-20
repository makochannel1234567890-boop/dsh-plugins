/**
 * dsh-social-desktop-agent / lib/desktop/win.js
 *
 * Windows execution helpers for the desktop layer.
 *
 * Design rules (safety first):
 *  - PowerShell is always invoked as
 *      powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command <script>
 *    with the script passed as a SINGLE argv element. Nothing is ever routed through
 *    a shell (`shell: true` is never used here), so `& | ; > cmd` inside a value can
 *    never become a command separator.
 *  - Callers must never concatenate user input into a script. Numeric values go
 *    through `Number` validation helpers in the calling modules; string payloads
 *    (typed text, key names) are passed as base64 environment variables instead.
 *  - Every failure is surfaced as a `DesktopError` with a stable machine `code`,
 *    so the tool layer can return structured JSON instead of throwing.
 *
 * This module has no dependency on lib/core (policy) or lib/browser: the tool
 * layer injects it as a `runner` (DI), and tests inject a fake with the same shape.
 */

import { execFile } from 'node:child_process';

/** @typedef {{ stdout: string, stderr: string }} ProcessOutput */

export const POWERSHELL_EXE = 'powershell.exe';
export const DEFAULT_TIMEOUT_MS = 20_000;
export const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

/** Flags required by the project contract, in the exact order. */
export const POWERSHELL_FLAGS = Object.freeze([
  '-NoProfile',
  '-NonInteractive',
  '-ExecutionPolicy',
  'Bypass',
]);

/** Characters that would turn a launcher argument into shell syntax. */
const SHELL_META_RE = /[&|;<>^%"'`]/;

/** A conservative allowlist for executable names / absolute paths. */
const SAFE_EXECUTABLE_RE = /^[A-Za-z0-9._/:\\ -]+$/;

/** Structured, serialisable error used across the desktop layer. */
export class DesktopError extends Error {
  /**
   * @param {string} code stable machine code, e.g. 'COORD_OUT_OF_SCREEN'
   * @param {string} message human readable message (English, no secrets)
   * @param {Record<string, unknown>} [details] extra structured context
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'DesktopError';
    this.code = code;
    this.details = details;
  }

  /** Shape used by tool results and audit entries. */
  toJSON() {
    return { ok: false, code: this.code, message: this.message, details: this.details };
  }
}

/** True when `value` is a DesktopError. */
export function isDesktopError(value) {
  return value instanceof DesktopError;
}

/**
 * Coerce anything thrown into a DesktopError without losing a stable code.
 * @param {unknown} value
 * @param {string} [fallbackCode]
 * @returns {DesktopError}
 */
export function toDesktopError(value, fallbackCode = 'INTERNAL_ERROR') {
  if (isDesktopError(value)) return value;
  if (value && typeof value === 'object') {
    const code = typeof (/** @type {any} */ (value).code) === 'string' ? /** @type {any} */ (value).code : null;
    const message = typeof (/** @type {any} */ (value).message) === 'string' ? /** @type {any} */ (value).message : String(value);
    if (code) return new DesktopError(code, message, { cause: 'external' });
    return new DesktopError(fallbackCode, message);
  }
  return new DesktopError(fallbackCode, String(value));
}

/**
 * Validate and return a PowerShell script string.
 * @param {unknown} script
 * @returns {string}
 */
export function assertScript(script) {
  if (typeof script !== 'string' || script.trim() === '') {
    throw new DesktopError('INVALID_SCRIPT', 'PowerShell script must be a non-empty string');
  }
  return script;
}

/**
 * Build the argv array for powershell.exe. Exported so tests can pin the exact form.
 * @param {string} script
 * @returns {string[]}
 */
export function buildPowerShellArgs(script) {
  return [...POWERSHELL_FLAGS, '-Command', assertScript(script)];
}

/**
 * Validate a string destined for an argv element (never a shell string).
 * @param {unknown} value
 * @param {string} [label]
 * @returns {string}
 */
export function assertSafeArgument(value, label = 'argument') {
  if (typeof value !== 'string' || value.length === 0) {
    throw new DesktopError('INVALID_ARGUMENT', `${label} must be a non-empty string`);
  }
  if (value.includes('\u0000') || value.includes('\r') || value.includes('\n')) {
    throw new DesktopError('INVALID_ARGUMENT', `${label} must not contain newlines or NUL bytes`);
  }
  if (SHELL_META_RE.test(value)) {
    throw new DesktopError('INJECTION_REJECTED', `${label} contains shell metacharacters`, { label });
  }
  return value;
}

/**
 * Validate an executable name or absolute path passed to execFile.
 * @param {unknown} value
 * @returns {string}
 */
export function assertExecutableName(value) {
  const name = assertSafeArgument(value, 'executable');
  if (!SAFE_EXECUTABLE_RE.test(name)) {
    throw new DesktopError('INVALID_ARGUMENT', 'executable path contains unsupported characters', { executable: name });
  }
  if (name.includes('..')) {
    throw new DesktopError('PATH_TRAVERSAL_REJECTED', 'executable path must not contain ".."', { executable: name });
  }
  return name;
}

/**
 * Parse the JSON payload produced by a PowerShell script.
 *
 * PowerShell may prepend warnings (progress output, encoding notices) before the
 * JSON document, so we accept: whole-document JSON, then the last parsable line,
 * then the outermost `{...}` slice. A BOM is stripped.
 *
 * @param {unknown} stdout
 * @returns {any}
 */
export function parseJsonOutput(stdout) {
  const raw = String(stdout ?? '').replace(/^\uFEFF/, '');
  const text = raw.trim();
  if (text === '') {
    throw new DesktopError('EMPTY_OUTPUT', 'PowerShell produced no output');
  }

  /** @param {string} candidate */
  const attempt = (candidate) => {
    try {
      return { ok: true, value: JSON.parse(candidate) };
    } catch {
      return { ok: false, value: undefined };
    }
  };

  const whole = attempt(text);
  if (whole.ok) return whole.value;

  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const parsed = attempt(lines[i]);
    if (parsed.ok) return parsed.value;
  }

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    const parsed = attempt(text.slice(start, end + 1));
    if (parsed.ok) return parsed.value;
  }

  throw new DesktopError('INVALID_OUTPUT', 'PowerShell output was not valid JSON', {
    preview: text.slice(0, 300),
  });
}

/**
 * Map a node child_process error to a DesktopError.
 * @param {any} error
 * @param {{ phase?: string }} [context]
 * @returns {DesktopError}
 */
export function mapProcessError(error, context = {}) {
  const phase = context.phase ?? 'powershell';
  const stderr = trimTail(error?.stderr);
  const details = {
    phase,
    killed: error?.killed === true,
    signal: error?.signal ?? null,
    exitCode: typeof error?.code === 'number' ? error.code : null,
    stderr,
  };
  const code = typeof error?.code === 'string' ? error.code : null;

  if (code === 'ETIMEDOUT' || details.killed) {
    return new DesktopError('TIMEOUT', `${phase} timed out`, details);
  }
  if (code === 'ENOENT' || code === 'ENOTFOUND') {
    return new DesktopError('BINARY_NOT_FOUND', `${phase} executable was not found`, details);
  }
  return new DesktopError(
    'COMMAND_FAILED',
    `${phase} failed${stderr ? `: ${stderr}` : ''}`,
    details,
  );
}

/** @param {unknown} value @param {number} [limit] */
function trimTail(value, limit = 800) {
  if (value === undefined || value === null) return '';
  const text = String(value).replace(/\u0000/g, '').trim();
  return text.length > limit ? `…${text.slice(-limit)}` : text;
}

/**
 * Call execFile and resolve with stdout/stderr.
 * Kept in one place so `execFileImpl` fakes in tests behave exactly like the real one.
 *
 * @param {Function} execFileImpl
 * @param {string} file
 * @param {string[]} args
 * @param {Record<string, unknown>} options
 * @returns {Promise<ProcessOutput>}
 */
function execFileAsync(execFileImpl, file, args, options) {
  return new Promise((resolve, reject) => {
    let settled = false;
    /** @type {any} */
    let child;
    try {
      child = execFileImpl(file, args, options, (error, stdout, stderr) => {
        if (settled) return;
        settled = true;
        if (error) {
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
          return;
        }
        resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      });
    } catch (error) {
      reject(error);
      return;
    }
    if (child && typeof child.on === 'function') {
      child.on('error', (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      });
    }
  });
}

/**
 * Create the default runner (real machine) or a runner around a fake execFile.
 *
 * Shape (the DI contract used by lib/desktop/tools.js):
 *   runPowerShell(script, opts?) -> { stdout, stderr }
 *   runJson(script, opts?)       -> parsed JSON
 *   runProgram(file, args, opts?)-> { stdout, stderr }   (short-lived CLI, e.g. shutdown /s /t 60)
 *   launchApp(file, args, opts?) -> { pid }              (detached GUI/CLI launch)
 *
 * @param {{
 *   execFileImpl?: Function,
 *   platform?: NodeJS.Platform,
 *   timeoutMs?: number,
 *   env?: NodeJS.ProcessEnv,
 *   maxBuffer?: number,
 * }} [options]
 */
export function createRunner(options = {}) {
  const execFileImpl = options.execFileImpl ?? execFile;
  const platform = options.platform ?? process.platform;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const baseEnv = options.env ?? process.env;
  const maxBuffer = options.maxBuffer ?? MAX_OUTPUT_BYTES;

  if (typeof execFileImpl !== 'function') {
    throw new DesktopError('INVALID_ARGUMENT', 'createRunner requires an execFile-compatible function');
  }

  /** @param {{ timeout?: number, env?: NodeJS.ProcessEnv }} [opts] */
  function buildOptions(opts = {}) {
    const result = {
      timeout: opts.timeout ?? timeoutMs,
      windowsHide: true,
      maxBuffer,
      encoding: 'utf8',
    };
    if (opts.env) result.env = { ...baseEnv, ...opts.env };
    return result;
  }

  /**
   * @param {string} script
   * @param {{ timeout?: number, env?: NodeJS.ProcessEnv }} [opts]
   * @returns {Promise<ProcessOutput>}
   */
  async function runPowerShell(script, opts = {}) {
    const args = buildPowerShellArgs(script);
    try {
      return await execFileAsync(execFileImpl, POWERSHELL_EXE, args, buildOptions(opts));
    } catch (error) {
      throw mapProcessError(error, { phase: 'powershell' });
    }
  }

  /**
   * @param {string} script
   * @param {{ timeout?: number, env?: NodeJS.ProcessEnv }} [opts]
   * @returns {Promise<any>}
   */
  async function runJson(script, opts = {}) {
    const output = await runPowerShell(script, opts);
    return parseJsonOutput(output.stdout);
  }

  /**
   * Run a short-lived executable (argv array, no shell).
   * @param {string} file
   * @param {string[]} [args]
   * @param {{ timeout?: number }} [opts]
   * @returns {Promise<ProcessOutput>}
   */
  async function runProgram(file, args = [], opts = {}) {
    const executable = assertExecutableName(file);
    if (!Array.isArray(args)) {
      throw new DesktopError('INVALID_ARGUMENT', 'runProgram args must be an array');
    }
    for (const arg of args) assertSafeArgument(arg, 'program argument');
    try {
      return await execFileAsync(execFileImpl, executable, args, buildOptions(opts));
    } catch (error) {
      throw mapProcessError(error, { phase: 'program' });
    }
  }

  /**
   * Launch a detached application (argv array, no shell). Resolves as soon as the
   * process has spawned; the child is unref'd so the host is not kept alive.
   * @param {string} file
   * @param {string[]} [args]
   * @param {{ shell?: boolean }} [opts]
   * @returns {Promise<{ pid: number|null, file: string, args: string[] }>}
   */
  async function launchApp(file, args = [], opts = {}) {
    const executable = assertExecutableName(file);
    if (!Array.isArray(args)) {
      throw new DesktopError('INVALID_ARGUMENT', 'launchApp args must be an array');
    }
    for (const arg of args) assertSafeArgument(arg, 'launch argument');

    const spawnOptions = {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      env: baseEnv,
    };
    if (opts.shell === true) spawnOptions.shell = true;

    let spawnedPid = null;

    await new Promise((resolve, reject) => {
      let settled = false;
      /** @type {any} */
      let child;
      try {
        child = execFileImpl(executable, args, spawnOptions, () => {});
      } catch (error) {
        reject(mapProcessError(error, { phase: 'launch' }));
        return;
      }
      if (!child) {
        resolve(undefined);
        return;
      }
      if (typeof child.pid === 'number' && child.pid > 0) {
        spawnedPid = child.pid;
        try {
          child.unref();
        } catch {
          /* fake or already exited: nothing to unref */
        }
        settled = true;
        resolve(undefined);
        return;
      }
      if (typeof child.once !== 'function') {
        resolve(undefined);
        return;
      }
      child.once('spawn', () => {
        if (settled) return;
        settled = true;
        spawnedPid = typeof child.pid === 'number' ? child.pid : null;
        try {
          child.unref();
        } catch {
          /* ignore */
        }
        resolve(undefined);
      });
      child.once('error', (error) => {
        if (settled) return;
        settled = true;
        reject(mapProcessError(error, { phase: 'launch' }));
      });
    });

    return { pid: spawnedPid, file: executable, args: [...args] };
  }

  return { platform, runPowerShell, runJson, runProgram, launchApp };
}

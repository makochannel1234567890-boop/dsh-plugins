/**
 * dsh-social-desktop-agent / lib/desktop/apps.js
 *
 * Application launching with a closed allowlist.
 *
 *  - The only accepted input is the NAME of an allowlisted application.
 *    An arbitrary path or command is rejected (INJECTION_REJECTED /
 *    INVALID_APP_NAME / APP_NOT_ALLOWED).
 *  - The executable and its arguments come from the frozen allowlist table; a
 *    caller can never add its own arguments, so `explorer.exe C:\Windows` or
 *    `code --command ...` cannot be produced.
 *  - execFile is used with an argv array (never a shell string). Entries that are
 *    `.cmd` shims are the only ones allowed to use `shell: true`, and their
 *    command comes from the allowlist constant, not from user input.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DesktopError, createRunner, toDesktopError } from './win.js';

const PROGRAM_FILES = process.env.ProgramFiles ?? 'C:\\Program Files';
const PROGRAM_FILES_X86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
const LOCAL_APP_DATA = process.env.LOCALAPPDATA ?? '';

/** @param {string[]} list */
function freezeList(list) {
  return Object.freeze(list.slice());
}

/** @param {string} base @param {...string} parts */
function under(base, ...parts) {
  if (!base) return null;
  return join(base, ...parts);
}

/**
 * Frozen allowlist. Adding an app is a deliberate, reviewable code change.
 * `candidates` holds trusted absolute install paths (never user input); they are
 * probed with existsSync so common Windows installs work even without PATH.
 */
export const APP_ALLOWLIST = Object.freeze({
  notepad: Object.freeze({ command: 'notepad.exe', args: freezeList([]), label: 'メモ帳' }),
  calc: Object.freeze({ command: 'calc.exe', args: freezeList([]), label: '電卓' }),
  explorer: Object.freeze({ command: 'explorer.exe', args: freezeList([]), label: 'エクスプローラー' }),
  mspaint: Object.freeze({ command: 'mspaint.exe', args: freezeList([]), label: 'ペイント' }),
  chrome: Object.freeze({
    command: 'chrome.exe',
    args: freezeList([]),
    label: 'Google Chrome',
    candidates: Object.freeze(
      [
        under(PROGRAM_FILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        under(PROGRAM_FILES_X86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        under(LOCAL_APP_DATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      ].filter(Boolean),
    ),
  }),
  msedge: Object.freeze({
    command: 'msedge.exe',
    args: freezeList([]),
    label: 'Microsoft Edge',
    candidates: Object.freeze(
      [
        under(PROGRAM_FILES_X86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        under(PROGRAM_FILES, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      ].filter(Boolean),
    ),
  }),
  code: Object.freeze({
    command: 'code.cmd',
    args: freezeList([]),
    label: 'Visual Studio Code',
    requiresShell: true,
    candidates: Object.freeze(
      [
        under(LOCAL_APP_DATA, 'Programs', 'Microsoft VS Code', 'bin', 'code.cmd'),
        under(PROGRAM_FILES, 'Microsoft VS Code', 'bin', 'code.cmd'),
      ].filter(Boolean),
    ),
  }),
});

/** Aliases mapped onto canonical allowlist keys. */
export const APP_ALIASES = Object.freeze({
  paint: 'mspaint',
  files: 'explorer',
  fileexplorer: 'explorer',
  edge: 'msedge',
  vscode: 'code',
  'visual-studio-code': 'code',
});

/** Substrings that must never appear in an app name. */
const INJECTION_MARKERS = Object.freeze([
  '..',
  '&',
  '|',
  ';',
  '<',
  '>',
  '^',
  '%',
  '$',
  '`',
  '"',
  "'",
  '\\',
  '/',
  ':',
  '\r',
  '\n',
  '\u0000',
]);

/**
 * Validate and canonicalise an app name.
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeAppName(value) {
  if (typeof value !== 'string') {
    throw new DesktopError('INVALID_APP_NAME', 'app name must be a string');
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    throw new DesktopError('INVALID_APP_NAME', 'app name must not be empty');
  }
  if (trimmed.length > 64) {
    throw new DesktopError('INVALID_APP_NAME', 'app name is too long', { length: trimmed.length });
  }
  const lowered = trimmed.toLowerCase();
  for (const marker of INJECTION_MARKERS) {
    if (lowered.includes(marker)) {
      throw new DesktopError('INJECTION_REJECTED', 'app name contains a path or shell metacharacter', {
        marker,
        input: trimmed.slice(0, 80),
      });
    }
  }
  let name = lowered;
  for (const ext of ['.exe', '.cmd', '.bat', '.com']) {
    if (name.endsWith(ext)) {
      name = name.slice(0, -ext.length);
      break;
    }
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    throw new DesktopError('INVALID_APP_NAME', 'app name may only contain letters, digits and dashes', {
      input: trimmed.slice(0, 80),
    });
  }
  return APP_ALIASES[name] ?? name;
}

/**
 * Resolve an app name to its frozen allowlist entry.
 * @param {unknown} value
 * @returns {{ ok:true, name:string, entry:{ command:string, args:string[], label:string, candidates?:string[], requiresShell?:boolean } }
 *          | { ok:false, code:string, message:string, details:object }}
 */
export function resolveApp(value) {
  try {
    const name = normalizeAppName(value);
    if (!Object.prototype.hasOwnProperty.call(APP_ALLOWLIST, name)) {
      return {
        ok: false,
        code: 'APP_NOT_ALLOWED',
        message: 'application is not in the allowlist',
        details: { app: name, allowed: Object.keys(APP_ALLOWLIST) },
      };
    }
    return { ok: true, name, entry: APP_ALLOWLIST[name] };
  } catch (error) {
    return toDesktopError(error, 'APP_NOT_ALLOWED').toJSON();
  }
}

/**
 * Pick the first existing trusted candidate, else the allowlist command (PATH).
 * @param {{ command:string, candidates?:readonly string[] }} entry
 * @returns {string}
 */
export function pickExecutable(entry) {
  for (const candidate of entry.candidates ?? []) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      /* inaccessible candidate: fall through */
    }
  }
  return entry.command;
}

/** Names and labels, safe to show to an agent or a human. */
export function listLaunchableApps() {
  return Object.keys(APP_ALLOWLIST).map((name) => ({
    name,
    label: APP_ALLOWLIST[name].label,
    command: APP_ALLOWLIST[name].command,
    requiresShell: APP_ALLOWLIST[name].requiresShell === true,
  }));
}

/**
 * Create the launch API.
 * @param {{ runner?: ReturnType<typeof createRunner>, platform?: NodeJS.Platform }} [options]
 */
export function createAppLauncher(options = {}) {
  const runner = options.runner ?? createRunner();
  const platform = options.platform ?? runner.platform ?? process.platform;

  /**
   * @param {unknown} appName
   * @param {{ args?: unknown }} [launchOptions]
   */
  async function launch(appName, launchOptions = {}) {
    try {
      if (platform !== 'win32') {
        throw new DesktopError('UNSUPPORTED_PLATFORM', 'application launching requires Windows', { platform });
      }
      if (launchOptions.args !== undefined) {
        return {
          ok: false,
          code: 'APP_ARGS_REJECTED',
          message: 'custom application arguments are not allowed',
          details: {},
        };
      }
      const resolved = resolveApp(appName);
      if (!resolved.ok) return resolved;

      const executable = pickExecutable(resolved.entry);
      await runner.launchApp(executable, [...resolved.entry.args], {
        shell: resolved.entry.requiresShell === true,
      });
      return {
        ok: true,
        launched: true,
        name: resolved.name,
        label: resolved.entry.label,
        command: executable,
        args: [...resolved.entry.args],
      };
    } catch (error) {
      return toDesktopError(error, 'APP_LAUNCH_FAILED').toJSON();
    }
  }

  return { launch, listLaunchableApps, platform };
}

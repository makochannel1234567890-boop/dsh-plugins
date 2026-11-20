/**
 * Shared fakes for the desktop-layer tests.
 *
 * Nothing in here touches the real machine: the runner fake records calls instead
 * of spawning PowerShell, so a power test can assert the exact `shutdown.exe`
 * argv while no process is ever started.
 */

import { DesktopError } from '../../lib/desktop/win.js';

/**
 * Fake win.js runner with the same shape as the real one.
 *
 * `responses` is a queue consumed by runJson (functions receive { script, options }).
 * An Error instance in the queue is thrown.
 *
 * @param {{ responses?: any[], platform?: NodeJS.Platform }} [options]
 */
export function createFakeRunner(options = {}) {
  const responses = [...(options.responses ?? [])];
  const calls = [];

  const runner = {
    platform: options.platform ?? 'win32',
    calls,
    async runPowerShell(script, opts = {}) {
      calls.push({ method: 'runPowerShell', script, options: opts });
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return { stdout: JSON.stringify(next ?? { ok: true }), stderr: '' };
    },
    async runJson(script, opts = {}) {
      calls.push({ method: 'runJson', script, options: opts });
      const next = responses.length > 0 ? responses.shift() : { ok: true };
      if (next instanceof Error) throw next;
      return typeof next === 'function' ? next({ script, options: opts }) : next;
    },
    async runProgram(file, args, opts = {}) {
      calls.push({ method: 'runProgram', file, args, options: opts });
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return { stdout: '', stderr: '' };
    },
    async launchApp(file, args, opts = {}) {
      calls.push({ method: 'launchApp', file, args, options: opts });
      return { pid: 4242, file, args };
    },
  };
  return runner;
}

/** Fake observer exposing the metrics/observe surface used by input and tools. */
export function createFakeObserver(options = {}) {
  const bounds = options.bounds ?? { x: 0, y: 0, width: 1920, height: 1080 };
  const observeFixture = options.observe ?? null;
  return {
    platform: options.platform ?? 'win32',
    async getMetrics() {
      if (options.metricsError) return options.metricsError;
      return {
        ok: true,
        metrics: {
          virtualScreen: bounds,
          primaryScreen: { x: 0, y: 0, width: 1920, height: 1080 },
          monitorCount: 1,
        },
        monitors: [
          {
            device: '\\\\.\\DISPLAY1',
            primary: true,
            bounds,
            workArea: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height - 40 },
          },
        ],
      };
    },
    async observe() {
      return observeFixture ?? { ok: true };
    },
    async getCursor() {
      return { ok: true, x: 0, y: 0 };
    },
    async listWindows() {
      return { ok: true, windows: [] };
    },
    async getActiveWindow() {
      return { ok: true, activeWindow: null };
    },
    async getBounds() {
      return { ok: true, bounds, monitors: [] };
    },
  };
}

/** Fake policy: records every action, answers with `allow`/`decide`. */
export function createFakePolicy(options = {}) {
  const calls = [];
  const decide = options.decide;
  return {
    calls,
    async check(action) {
      calls.push(action);
      if (typeof decide === 'function') return decide(action);
      if (options.allow === false) {
        return { ok: false, code: options.code ?? 'SCOPE_DENIED', message: options.message ?? 'denied by test' };
      }
      return { ok: true };
    },
  };
}

/** Fake audit sink. */
export function createFakeAudit() {
  const entries = [];
  return {
    entries,
    async append(entry) {
      entries.push(entry);
    },
    list() {
      return entries.slice();
    },
  };
}

/** A realistic OBSERVE_SCRIPT payload (multi-monitor, one window). */
export const OBSERVE_FIXTURE = {
  ok: true,
  timestamp: '2026-11-17T08:00:00.000Z',
  host: 'TEST-PC',
  metrics: {
    virtualScreen: { x: -1920, y: 0, width: 3840, height: 1080 },
    primaryScreen: { width: 1920, height: 1080 },
    monitorCount: 2,
  },
  cursor: { x: 10, y: 20 },
  monitors: [
    {
      device: '\\\\.\\DISPLAY1',
      primary: true,
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      workArea: { x: 0, y: 0, width: 1920, height: 1040 },
    },
    {
      device: '\\\\.\\DISPLAY2',
      primary: false,
      bounds: { x: -1920, y: 0, width: 1920, height: 1080 },
      workArea: { x: -1920, y: 0, width: 1920, height: 1080 },
    },
  ],
  windows: [
    {
      hwnd: 111,
      title: 'Untitled - Notepad',
      className: 'Notepad',
      pid: 999,
      visible: true,
      minimized: false,
      bounds: { x: 100, y: 100, width: 800, height: 600 },
    },
    {
      hwnd: 222,
      title: 'Calculator',
      className: 'ApplicationFrameWindow',
      pid: 1000,
      visible: true,
      minimized: false,
      bounds: { x: 300, y: 200, width: 400, height: 600 },
    },
  ],
  activeWindow: {
    hwnd: 111,
    title: 'Untitled - Notepad',
    className: 'Notepad',
    pid: 999,
    bounds: { x: 100, y: 100, width: 800, height: 600 },
  },
};

/** Helper: decode the SendKeys payload captured in a fake runner call. */
export function decodeSendKeys(call) {
  const b64 = call?.options?.env?.DSH_SENDKEYS_B64;
  if (typeof b64 !== 'string') return null;
  return Buffer.from(b64, 'base64').toString('utf8');
}

/** Helper: a DesktopError for fake failure injections. */
export function desktopFailure(code = 'COMMAND_FAILED', message = 'injected failure') {
  return new DesktopError(code, message);
}

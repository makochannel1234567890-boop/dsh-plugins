#!/usr/bin/env node
/**
 * dsh-social-desktop-agent / scripts/desktop-dryrun.mjs
 *
 * Read-only smoke test for the Windows desktop layer.
 *
 * It does exactly three things:
 *   1. reads the cursor position, the virtual screen and the visible window list
 *      (GetCursorPos / GetSystemMetrics / EnumWindows through lib/desktop/observe.js);
 *   2. prints the frozen application allowlist;
 *   3. prints the power plan for reboot/shutdown as a DRY-RUN — no token, no
 *      scope, no environment flag is provided here, so `executePower` cannot
 *      reach the execution branch, and this script never calls the runner with a
 *      power command.
 *
 * Usage:  node dsh-social-desktop-agent/scripts/desktop-dryrun.mjs
 * Exit:   0 when observation succeeded, 1 otherwise.
 */

import { createRunner } from '../lib/desktop/win.js';
import { createObserver } from '../lib/desktop/observe.js';
import { listLaunchableApps } from '../lib/desktop/apps.js';
import { buildPowerPlan, evaluatePowerGates } from '../lib/desktop/power.js';

const runner = createRunner();
const observer = createObserver({ runner });

function line(label, value) {
  console.log(`${label.padEnd(22)} ${value}`);
}

console.log('dsh-social-desktop-agent — desktop dry run (read-only)');
line('platform', `${process.platform} (${process.arch})`);
line('node', process.version);
line('powershell', runner.platform === 'win32' ? 'powershell.exe -NoProfile …' : '(not Windows)');
console.log('');

const snapshot = await observer.observe();

if (!snapshot.ok) {
  console.error(`observation failed: ${snapshot.code} — ${snapshot.message}`);
  if (snapshot.details?.stderr) console.error(`stderr: ${snapshot.details.stderr}`);
  process.exitCode = 1;
} else {
  const { cursor, metrics, monitors } = snapshot;
  line('cursor', `(${cursor.x}, ${cursor.y})`);
  const vs = metrics.virtualScreen;
  line('virtual screen', `${vs.width}x${vs.height} at (${vs.x}, ${vs.y})`);
  line('primary screen', `${metrics.primaryScreen.width}x${metrics.primaryScreen.height}`);
  line('monitors', String(monitors.length));
  for (const monitor of monitors) {
    const b = monitor.bounds;
    line(
      `  ${monitor.device || 'display'}`,
      `${b.width}x${b.height} at (${b.x}, ${b.y})${monitor.primary ? ' primary' : ''}`,
    );
  }

  const active = snapshot.activeWindow;
  line('active window', active ? `${active.title} [pid ${active.pid}]` : '(desktop)');
  line('windows', String(snapshot.windows.length));

  const limit = Number(process.env.DSH_DRYRUN_WINDOWS ?? 10);
  const shown = snapshot.windows.slice(0, Number.isFinite(limit) ? limit : 10);
  for (const win of shown) {
    const b = win.bounds;
    const title = win.title.length > 60 ? `${win.title.slice(0, 57)}…` : win.title;
    console.log(`  - ${title}  [pid ${win.pid}] ${b.width}x${b.height} at (${b.x}, ${b.y})${win.minimized ? ' minimized' : ''}`);
  }
  if (snapshot.windows.length > shown.length) {
    console.log(`  … ${snapshot.windows.length - shown.length} more`);
  }
}

console.log('');
console.log('Application allowlist (fixed; arbitrary paths and commands are rejected):');
for (const app of listLaunchableApps()) {
  console.log(`  - ${app.name.padEnd(10)} ${app.label}${app.requiresShell ? ' (shell shim)' : ''}`);
}

console.log('');
console.log('Power plans (DRY-RUN ONLY — nothing is executed by this script):');
for (const action of ['reboot', 'shutdown']) {
  const plan = buildPowerPlan({ action, delaySec: 60 });
  if (!plan.ok) {
    console.log(`  ${action}: invalid plan (${plan.code})`);
    continue;
  }
  const gates = await evaluatePowerGates({ scopeGranted: false, confirm: null, token: null, env: process.env, action, plan });
  console.log(`  ${action.padEnd(9)} wouldRun="${plan.command}"  missing=[${gates.missing.join(', ')}]`);
}

console.log('');
console.log('No power command was executed. No network access, credentials or input injection was performed.');
console.log('To arm a real power action you need all three gates: os.power scope + confirmation token + DSH_ALLOW_POWER=1.');

/**
 * Tests for lib/desktop/tools.js — DI wiring, policy fail-closed behaviour,
 * audit logging and the power dry-run path.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { TOOL_NAMES, createDesktopTools, createMemoryAudit } from '../../lib/desktop/tools.js';
import {
  createFakeAudit,
  createFakeObserver,
  createFakePolicy,
  createFakeRunner,
  decodeSendKeys,
  OBSERVE_FIXTURE,
} from './helpers.mjs';

const BOUNDS = { x: 0, y: 0, width: 1920, height: 1080 };

/**
 * @param {Record<string, any>} [overrides]
 */
function setup(overrides = {}) {
  const runner = overrides.runner ?? createFakeRunner({ responses: overrides.responses ?? [] });
  const policy = overrides.policy ?? createFakePolicy();
  const audit = overrides.audit ?? createFakeAudit();
  const observer =
    overrides.observer ??
    createFakeObserver({ bounds: BOUNDS, observe: overrides.observe ?? { ...OBSERVE_FIXTURE } });
  const desktop = createDesktopTools({
    policy,
    audit,
    confirm: overrides.confirm,
    runner,
    observer,
    env: overrides.env ?? {},
    platform: overrides.platform,
  });
  return { runner, policy, audit, observer, desktop };
}

// --- surface ---------------------------------------------------------------

test('all seven desktop tools are exposed with schemas', () => {
  const { desktop } = setup();
  assert.deepEqual(
    desktop.tools.map((tool) => tool.name),
    [...TOOL_NAMES],
  );
  for (const tool of desktop.tools) {
    assert.equal(typeof tool.description, 'string');
    assert.ok(tool.description.length > 10);
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(typeof tool.execute, 'function');
    assert.equal(typeof desktop.handlers[tool.name], 'function');
  }
  assert.equal(desktop.byName.app_launch.scope, 'app.launch');
  assert.equal(desktop.byName.desktop_observe.scope, 'browse.read');
});

// --- policy ----------------------------------------------------------------

test('desktop_observe asks the policy with the documented action shape', async () => {
  const { desktop, policy } = setup();
  const result = await desktop.handlers.desktop_observe();

  assert.equal(result.ok, true);
  assert.deepEqual(policy.calls[0], { scope: 'browse.read', kind: 'desktop_observe', target: 'desktop' });
});

test('a denied action never reaches the runner and is audited', async () => {
  const { desktop, runner, audit } = setup({
    policy: createFakePolicy({ allow: false, code: 'SCOPE_DENIED' }),
  });

  const result = await desktop.handlers.desktop_click({ x: 10, y: 10 });

  assert.equal(result.ok, false);
  assert.equal(result.blocked, true);
  assert.equal(result.code, 'SCOPE_DENIED');
  assert.equal(runner.calls.length, 0);

  const denied = audit.entries.find((entry) => entry.type === 'desktop.denied');
  assert.ok(denied);
  assert.equal(denied.tool, 'desktop_click');
  assert.deepEqual(denied.action, { scope: 'browse.interact', kind: 'desktop_click', target: 'desktop:screen' });
});

test('no policy injected means every action is denied', async () => {
  const runner = createFakeRunner();
  const audit = createFakeAudit();
  const desktop = createDesktopTools({ runner, audit });

  const result = await desktop.handlers.desktop_observe();

  assert.equal(result.ok, false);
  assert.equal(result.blocked, true);
  assert.equal(result.code, 'POLICY_NOT_CONFIGURED');
  assert.equal(runner.calls.length, 0);
});

test('a throwing policy is contained and reported', async () => {
  const { desktop, runner } = setup({
    policy: {
      async check() {
        throw new Error('policy backend offline');
      },
    },
  });

  const result = await desktop.handlers.desktop_observe();

  assert.equal(result.ok, false);
  assert.equal(result.code, 'POLICY_ERROR');
  assert.equal(runner.calls.length, 0);
});

// --- observe ---------------------------------------------------------------

test('desktop_observe returns a snapshot and audits a redacted summary', async () => {
  const { desktop, audit } = setup();

  const result = await desktop.handlers.desktop_observe();

  assert.equal(result.ok, true);
  assert.equal(result.cursor.x, 10);
  assert.equal(result.windows.length, 2);
  assert.equal(result.activeWindow.title, 'Untitled - Notepad');

  const entry = audit.entries.find((item) => item.type === 'desktop.ok');
  assert.ok(entry);
  assert.equal(entry.tool, 'desktop_observe');
  assert.equal(entry.meta.windowCount, 2);
  // Window titles are privacy sensitive and must not be copied into the audit log.
  assert.equal(JSON.stringify(entry).includes('Notepad'), false);
});

// --- move / click ----------------------------------------------------------

test('desktop_move clamps a near-edge coordinate and audits the resolution', async () => {
  const { desktop, runner, audit } = setup({
    responses: [{ ok: true, x: 1919, y: 500 }],
  });

  const result = await desktop.handlers.desktop_move({ x: 1921, y: 500 });

  assert.equal(result.ok, true);
  assert.equal(result.x, 1919);
  assert.equal(result.clamped, true);
  assert.equal(runner.calls.length, 1);
  assert.match(runner.calls[0].script, /SetCursorPos\(1919, 500\)/);

  const entry = audit.entries.find((item) => item.tool === 'desktop_move' && item.type === 'desktop.ok');
  assert.equal(entry.meta.clamped, true);
  assert.deepEqual(entry.meta.resolved, { x: 1919, y: 500 });
});

test('desktop_click rejects an off-screen point without running anything', async () => {
  const { desktop, runner, audit } = setup();

  const result = await desktop.handlers.desktop_click({ x: 99999, y: 10 });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'COORD_OUT_OF_SCREEN');
  assert.equal(runner.calls.length, 0);
  const entry = audit.entries.find((item) => item.type === 'desktop.failed');
  assert.equal(entry.code, 'COORD_OUT_OF_SCREEN');
});

test('desktop_move reports invalid coordinates structurally', async () => {
  const { desktop, runner } = setup();
  const result = await desktop.handlers.desktop_move({ x: 'abc', y: 10 });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVALID_COORDINATE');
  assert.equal(runner.calls.length, 0);
});

// --- type / key ------------------------------------------------------------

test('desktop_type carries text as data and redacts it in the audit log', async () => {
  const { desktop, runner, audit } = setup({ responses: [{ ok: true, sent: true, length: 9 }] });

  const result = await desktop.handlers.desktop_type({ text: 'hunter2!!' });

  assert.equal(result.ok, true);
  assert.equal(result.length, 9);
  assert.equal(decodeSendKeys(runner.calls[0]), 'hunter2!!');

  const entry = audit.entries.find((item) => item.tool === 'desktop_type');
  assert.equal(entry.meta.length, 9);
  assert.equal(entry.meta.redacted, true);
  assert.equal(JSON.stringify(entry).includes('hunter2'), false);
});

test('desktop_key sends the allowlisted combo and rejects unknown keys', async () => {
  const { desktop, runner, audit } = setup({ responses: [{ ok: true, length: 7 }] });

  const ok = await desktop.handlers.desktop_key({ key: 'enter' });
  assert.equal(ok.ok, true);
  assert.equal(decodeSendKeys(runner.calls[0]), '{ENTER}');

  const rejected = await desktop.handlers.desktop_key({ key: 'volumeup' });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'UNKNOWN_KEY');
  assert.equal(runner.calls.length, 1);
  assert.ok(audit.entries.some((entry) => entry.code === 'UNKNOWN_KEY'));
});

// --- app launch ------------------------------------------------------------

test('app_launch launches an allowlisted app through the runner', async () => {
  const { desktop, runner, audit } = setup();

  const result = await desktop.handlers.app_launch({ app: 'notepad' });

  assert.equal(result.ok, true);
  assert.equal(result.launched, true);
  assert.equal(runner.calls[0].method, 'launchApp');
  assert.equal(runner.calls[0].file, 'notepad.exe');
  assert.deepEqual(runner.calls[0].args, []);
  assert.ok(audit.entries.some((entry) => entry.type === 'desktop.ok' && entry.meta.app === 'notepad'));
});

test('app_launch refuses non-allowlisted and injected names', async () => {
  const { desktop, runner } = setup();

  const denied = await desktop.handlers.app_launch({ app: 'powershell' });
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'APP_NOT_ALLOWED');

  const injected = await desktop.handlers.app_launch({ app: 'notepad & shutdown /s' });
  assert.equal(injected.ok, false);
  assert.equal(injected.code, 'INJECTION_REJECTED');

  assert.equal(runner.calls.length, 0);
});

// --- power -----------------------------------------------------------------

test('power_action dry-runs by default and never executes', async () => {
  const { desktop, runner, audit } = setup();

  const result = await desktop.handlers.power_action({ action: 'shutdown' });

  assert.equal(result.dryRun, true);
  assert.equal(result.executed, false);
  assert.equal(result.wouldRun, 'shutdown /s /t 60');
  assert.deepEqual(result.missing, ['confirm_token', 'env:DSH_ALLOW_POWER']);
  assert.equal(runner.calls.length, 0);

  const entry = audit.entries.find((item) => item.tool === 'power_action');
  assert.equal(entry.type, 'power.dry-run');
  assert.equal(entry.meta.executed, false);
  assert.equal(entry.meta.command, 'shutdown /s /t 60');
});

test('power_action executes only with policy + token + environment', async () => {
  const { desktop, runner, audit } = setup({
    confirm: 'TOKEN-123',
    env: { DSH_ALLOW_POWER: '1' },
  });

  const result = await desktop.handlers.power_action({ action: 'shutdown', confirmToken: 'TOKEN-123' });

  assert.equal(result.ok, true);
  assert.equal(result.executed, true);
  assert.equal(runner.calls.length, 1);
  assert.equal(runner.calls[0].method, 'runProgram');
  assert.equal(runner.calls[0].file, 'shutdown.exe');
  assert.deepEqual(runner.calls[0].args, ['/s', '/t', '60']);

  const entry = audit.entries.find((item) => item.tool === 'power_action');
  assert.equal(entry.type, 'power.executed');
  assert.equal(entry.meta.executed, true);
});

test('power_action stays a dry-run when the policy denies os.power', async () => {
  const { desktop, runner } = setup({
    policy: createFakePolicy({ allow: false }),
    confirm: 'TOKEN-123',
    env: { DSH_ALLOW_POWER: '1' },
  });

  const result = await desktop.handlers.power_action({ action: 'shutdown', confirmToken: 'TOKEN-123' });

  assert.equal(result.dryRun, true);
  assert.deepEqual(result.missing, ['scope:os.power']);
  assert.equal(runner.calls.length, 0);
});

test('the policy sees a core-compatible power action (restart|shutdown + confirmToken)', async () => {
  const { desktop, policy } = setup({ confirm: 'TOKEN-123', env: { DSH_ALLOW_POWER: '1' } });

  await desktop.handlers.power_action({ action: 'reboot', confirmToken: 'TOKEN-123' });
  assert.deepEqual(policy.calls[0], {
    scope: 'os.power',
    kind: 'power_action',
    target: 'restart',
    confirmToken: 'TOKEN-123',
  });

  await desktop.handlers.power_action({ action: 'shutdown' });
  assert.deepEqual(policy.calls[1], { scope: 'os.power', kind: 'power_action', target: 'shutdown' });
});

test('the policy sees the canonical app name as the app.launch target', async () => {
  const { desktop, policy } = setup();

  await desktop.handlers.app_launch({ app: 'notepad.exe' });

  assert.deepEqual(policy.calls[0], { scope: 'app.launch', kind: 'app_launch', target: 'notepad' });
});

test('power_action rejects an unsupported action without execution', async () => {
  const { desktop, runner } = setup({ confirm: 'T', env: { DSH_ALLOW_POWER: '1' } });

  const result = await desktop.handlers.power_action({ action: 'format' });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVALID_POWER_ACTION');
  assert.equal(runner.calls.length, 0);
});

// --- audit wiring ----------------------------------------------------------

test('an unwritable audit log fails closed with AUDIT_FAILED', async () => {
  const audit = {
    async append() {
      throw new Error('audit disk full');
    },
  };
  const { desktop } = setup({ audit });

  const result = await desktop.handlers.desktop_observe();

  assert.equal(result.ok, false);
  assert.equal(result.code, 'AUDIT_FAILED');
  assert.equal(result.result.ok, true);
  assert.equal(desktop.getAuditErrors().length, 1);
});

test('the default audit sink is an in-memory log exposed for inspection', async () => {
  const runner = createFakeRunner();
  const desktop = createDesktopTools({ policy: createFakePolicy(), runner, observer: createFakeObserver() });

  await desktop.handlers.desktop_observe();
  const entries = desktop.getAuditEntries();

  assert.equal(entries.length, 1);
  assert.equal(entries[0].type, 'desktop.ok');
});

test('createMemoryAudit trims to its limit', () => {
  const audit = createMemoryAudit(2);
  audit.append({ n: 1 });
  audit.append({ n: 2 });
  audit.append({ n: 3 });
  assert.deepEqual(audit.list().map((entry) => entry.n), [2, 3]);
});

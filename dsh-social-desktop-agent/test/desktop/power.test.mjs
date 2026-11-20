/**
 * Tests for lib/desktop/power.js — the three-gate power path.
 *
 * Every execution test uses the fake runner: the assertion is on the assembled
 * argv, and no shutdown.exe is ever started by the test suite.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { DesktopError } from '../../lib/desktop/win.js';
import {
  DEFAULT_DELAY_SEC,
  MAX_DELAY_SEC,
  POWER_ENV_FLAG,
  buildPowerPlan,
  evaluatePowerGates,
  executePower,
  normalizeDelaySec,
  normalizePowerAction,
  verifyConfirmToken,
} from '../../lib/desktop/power.js';
import { createFakeRunner } from './helpers.mjs';

// --- plan building ---------------------------------------------------------

test('buildPowerPlan assembles the documented shutdown command', () => {
  const plan = buildPowerPlan({ action: 'shutdown' });
  assert.equal(plan.ok, true);
  assert.equal(plan.action, 'shutdown');
  assert.equal(plan.executable, 'shutdown.exe');
  assert.deepEqual(plan.args, ['/s', '/t', '60']);
  assert.equal(plan.command, 'shutdown /s /t 60');
  assert.equal(DEFAULT_DELAY_SEC, 60);
});

test('buildPowerPlan supports reboot and a custom delay', () => {
  const plan = buildPowerPlan({ action: 'reboot', delaySec: 120 });
  assert.deepEqual(plan.args, ['/r', '/t', '120']);
  assert.equal(plan.command, 'shutdown /r /t 120');

  assert.equal(buildPowerPlan({ action: 'restart', delaySec: 0 }).action, 'reboot');
  assert.deepEqual(buildPowerPlan({ action: 'shutdown', delaySec: 0 }).args, ['/s', '/t', '0']);
});

test('buildPowerPlan rejects unknown actions', () => {
  for (const action of ['format', 'reboot-now', '', null, 42]) {
    const plan = buildPowerPlan({ action });
    assert.equal(plan.ok, false, `${String(action)} must be rejected`);
    assert.equal(plan.code, 'INVALID_POWER_ACTION');
  }
});

test('buildPowerPlan rejects out-of-range or non-integer delays', () => {
  for (const delaySec of [-1, 1.5, 'abc', MAX_DELAY_SEC + 1, Number.NaN, null]) {
    const plan = buildPowerPlan({ action: 'shutdown', delaySec });
    assert.equal(plan.ok, false, `${String(delaySec)} must be rejected`);
    assert.equal(plan.code, 'INVALID_DELAY');
  }
  assert.equal(normalizeDelaySec('90'), 90);
  assert.equal(normalizePowerAction('SHUTDOWN'), 'shutdown');
});

// --- gates -----------------------------------------------------------------

test('a cold machine is missing all three gates', async () => {
  const gates = await evaluatePowerGates({ scopeGranted: false, env: {} });
  assert.equal(gates.ok, false);
  assert.deepEqual(gates.missing, ['scope:os.power', 'confirm_token', `env:${POWER_ENV_FLAG}`]);
});

test('each gate is reported independently', async () => {
  const scopeOnly = await evaluatePowerGates({ scopeGranted: true, env: {} });
  assert.deepEqual(scopeOnly.missing, ['confirm_token', `env:${POWER_ENV_FLAG}`]);

  const noEnv = await evaluatePowerGates({
    scopeGranted: true,
    confirm: 'TOKEN',
    token: 'TOKEN',
    env: {},
  });
  assert.deepEqual(noEnv.missing, [`env:${POWER_ENV_FLAG}`]);

  const envNotOne = await evaluatePowerGates({
    scopeGranted: true,
    confirm: 'TOKEN',
    token: 'TOKEN',
    env: { [POWER_ENV_FLAG]: 'true' },
  });
  assert.deepEqual(envNotOne.missing, [`env:${POWER_ENV_FLAG}`]);

  const all = await evaluatePowerGates({
    scopeGranted: true,
    confirm: 'TOKEN',
    token: 'TOKEN',
    env: { [POWER_ENV_FLAG]: '1' },
  });
  assert.equal(all.ok, true);
  assert.deepEqual(all.missing, []);
});

test('verifyConfirmToken supports token object, verify(), function and env fallback', async () => {
  assert.equal((await verifyConfirmToken({ confirm: { token: 'T' }, token: 'T' })).ok, true);
  assert.equal((await verifyConfirmToken({ confirm: { token: 'T' }, token: 'X' })).ok, false);
  assert.equal((await verifyConfirmToken({ confirm: { expectedToken: 'T' }, token: 'T' })).ok, true);
  assert.equal(
    (await verifyConfirmToken({ confirm: { verify: async ({ token }) => token === 'V' }, token: 'V' })).ok,
    true,
  );
  assert.equal((await verifyConfirmToken({ confirm: async ({ token }) => token === 'F', token: 'F' })).ok, true);
  assert.equal((await verifyConfirmToken({ confirm: async () => false, token: 'F' })).ok, false);
  assert.equal(
    (await verifyConfirmToken({ confirm: null, token: 'E', env: { DSH_POWER_CONFIRM_TOKEN: 'E' } })).ok,
    true,
  );
  assert.equal(
    (await verifyConfirmToken({ confirm: null, token: '', env: { DSH_POWER_CONFIRM_TOKEN: 'E' } })).ok,
    false,
  );
  assert.equal((await verifyConfirmToken({ confirm: { token: '' }, token: '' })).ok, false);
  assert.equal((await verifyConfirmToken({ confirm: null, token: 'x', env: {} })).ok, false);
});

test('verifyConfirmToken reports a throwing confirm sink without executing', async () => {
  const result = await verifyConfirmToken({
    confirm: () => {
      throw new Error('confirm backend down');
    },
    token: 'T',
  });
  assert.equal(result.ok, false);
  assert.match(result.reason ?? '', /confirm_error/);
});

// --- execution -------------------------------------------------------------

test('executePower dry-runs when the gates are missing and runs nothing', async () => {
  const runner = createFakeRunner();
  const result = await executePower({ action: 'shutdown', env: {}, runner });

  assert.equal(result.executed, false);
  assert.equal(result.dryRun, true);
  assert.equal(result.wouldRun, 'shutdown /s /t 60');
  assert.deepEqual(result.missing, ['scope:os.power', 'confirm_token', `env:${POWER_ENV_FLAG}`]);
  assert.equal(runner.calls.length, 0);
});

test('executePower assembles the exact shutdown argv once all gates pass', async () => {
  const runner = createFakeRunner();
  const result = await executePower({
    action: 'shutdown',
    scopeGranted: true,
    confirm: 'TOKEN-123',
    confirmToken: 'TOKEN-123',
    env: { [POWER_ENV_FLAG]: '1' },
    runner,
  });

  assert.equal(result.ok, true);
  assert.equal(result.executed, true);
  assert.equal(result.dryRun, false);
  assert.equal(result.command, 'shutdown /s /t 60');

  assert.equal(runner.calls.length, 1);
  assert.equal(runner.calls[0].method, 'runProgram');
  assert.equal(runner.calls[0].file, 'shutdown.exe');
  assert.deepEqual(runner.calls[0].args, ['/s', '/t', '60']);
});

test('executePower assembles the reboot argv with a custom delay', async () => {
  const runner = createFakeRunner();
  const result = await executePower({
    action: 'reboot',
    delaySec: 120,
    scopeGranted: true,
    confirm: { token: 'T' },
    confirmToken: 'T',
    env: { [POWER_ENV_FLAG]: '1' },
    runner,
  });

  assert.equal(result.executed, true);
  assert.deepEqual(runner.calls[0].args, ['/r', '/t', '120']);
  assert.equal(result.command, 'shutdown /r /t 120');
});

test('executePower stays a dry-run when the scope is missing', async () => {
  const runner = createFakeRunner();
  const result = await executePower({
    action: 'shutdown',
    scopeGranted: false,
    confirm: 'T',
    confirmToken: 'T',
    env: { [POWER_ENV_FLAG]: '1' },
    runner,
  });

  assert.equal(result.dryRun, true);
  assert.equal(result.executed, false);
  assert.deepEqual(result.missing, ['scope:os.power']);
  assert.equal(runner.calls.length, 0);
});

test('executePower stays a dry-run when the token does not match', async () => {
  const runner = createFakeRunner();
  const result = await executePower({
    action: 'shutdown',
    scopeGranted: true,
    confirm: 'RIGHT',
    confirmToken: 'WRONG',
    env: { [POWER_ENV_FLAG]: '1' },
    runner,
  });

  assert.equal(result.dryRun, true);
  assert.deepEqual(result.missing, ['confirm_token']);
  assert.equal(runner.calls.length, 0);
});

test('executePower stays a dry-run when DSH_ALLOW_POWER is absent', async () => {
  const runner = createFakeRunner();
  const result = await executePower({
    action: 'shutdown',
    scopeGranted: true,
    confirm: 'T',
    confirmToken: 'T',
    env: {},
    runner,
  });

  assert.equal(result.dryRun, true);
  assert.deepEqual(result.missing, [`env:${POWER_ENV_FLAG}`]);
  assert.equal(runner.calls.length, 0);
});

test('executePower reports an execution failure structurally', async () => {
  const runner = createFakeRunner({ responses: [new DesktopError('COMMAND_FAILED', 'access denied by OS')] });
  const result = await executePower({
    action: 'shutdown',
    scopeGranted: true,
    confirm: 'T',
    confirmToken: 'T',
    env: { [POWER_ENV_FLAG]: '1' },
    runner,
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'COMMAND_FAILED');
  assert.equal(result.executed, false);
  assert.equal(result.attempted, true);
  assert.deepEqual(result.args, ['/s', '/t', '60']);
});

test('executePower rejects an invalid action before touching the runner', async () => {
  const runner = createFakeRunner();
  const result = await executePower({ action: 'format', env: {}, runner });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVALID_POWER_ACTION');
  assert.equal(runner.calls.length, 0);
});

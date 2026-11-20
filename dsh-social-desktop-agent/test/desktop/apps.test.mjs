/**
 * Tests for lib/desktop/apps.js — closed allowlist and rejected input shapes.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  APP_ALLOWLIST,
  APP_ALIASES,
  createAppLauncher,
  listLaunchableApps,
  normalizeAppName,
  resolveApp,
} from '../../lib/desktop/apps.js';
import { createFakeRunner } from './helpers.mjs';

/** @param {string} code */
function hasCode(code) {
  return (error) => error && error.code === code;
}

test('the allowlist is frozen and contains the documented apps', () => {
  assert.equal(Object.isFrozen(APP_ALLOWLIST), true);
  for (const name of ['notepad', 'calc', 'explorer', 'mspaint', 'chrome', 'msedge', 'code']) {
    assert.ok(APP_ALLOWLIST[name], `${name} must be allowlisted`);
    assert.equal(Object.isFrozen(APP_ALLOWLIST[name]), true);
    assert.deepEqual(APP_ALLOWLIST[name].args, []);
  }
  assert.equal(Object.isFrozen(APP_ALIASES), true);
});

test('allowlisted names resolve to the frozen executable', () => {
  const notepad = resolveApp('notepad');
  assert.equal(notepad.ok, true);
  assert.equal(notepad.name, 'notepad');
  assert.equal(notepad.entry.command, 'notepad.exe');

  assert.equal(resolveApp('msedge').name, 'msedge');
  assert.equal(resolveApp('code').entry.command, 'code.cmd');
});

test('executable extensions and aliases are normalised', () => {
  assert.equal(normalizeAppName('Notepad.exe'), 'notepad');
  assert.equal(normalizeAppName('  CALC  '), 'calc');
  assert.equal(normalizeAppName('paint'), 'mspaint');
  assert.equal(normalizeAppName('edge'), 'msedge');
  assert.equal(normalizeAppName('vscode'), 'code');
  assert.equal(normalizeAppName('mspaint.cmd'), 'mspaint');
});

test('path traversal and shell metacharacters are rejected as injection', () => {
  for (const input of [
    '..\\..\\windows\\system32\\cmd.exe',
    '../calc',
    'calc & shutdown /s',
    'calc | cmd',
    'calc; shutdown',
    'C:\\Windows\\System32\\calc.exe',
    'notepad && calc',
    'notepad > out.txt',
    '"calc"',
    'calc`whoami`',
  ]) {
    const result = resolveApp(input);
    assert.equal(result.ok, false, `${input} must be rejected`);
    assert.equal(result.code, 'INJECTION_REJECTED', `${input} -> ${result.code}`);
  }
});

test('malformed names are rejected with INVALID_APP_NAME', () => {
  for (const input of ['', '   ', 'calc exe', '計算機', null, 42]) {
    const result = resolveApp(input);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'INVALID_APP_NAME', `${String(input)} -> ${result.code}`);
  }
});

test('a well-formed but non-allowlisted name is APP_NOT_ALLOWED', () => {
  for (const input of ['powershell', 'cmd', 'regedit', 'wt', 'unknown-app']) {
    const result = resolveApp(input);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'APP_NOT_ALLOWED', `${input} must not be allowlisted`);
    assert.ok(Array.isArray(result.details.allowed));
    assert.ok(result.details.allowed.includes('notepad'));
  }
});

test('resolveApp never throws', () => {
  assert.doesNotThrow(() => resolveApp(undefined));
  assert.doesNotThrow(() => resolveApp({}));
});

test('launcher spawns an allowlisted app without extra arguments', async () => {
  const runner = createFakeRunner();
  const launcher = createAppLauncher({ runner });

  const result = await launcher.launch('notepad');

  assert.equal(result.ok, true);
  assert.equal(result.launched, true);
  assert.equal(result.name, 'notepad');
  assert.equal(result.command, 'notepad.exe');
  assert.deepEqual(result.args, []);
  assert.equal(runner.calls.length, 1);
  assert.equal(runner.calls[0].method, 'launchApp');
  assert.equal(runner.calls[0].file, 'notepad.exe');
  assert.deepEqual(runner.calls[0].args, []);
});

test('launcher refuses a non-allowlisted app without spawning', async () => {
  const runner = createFakeRunner();
  const launcher = createAppLauncher({ runner });

  const result = await launcher.launch('powershell');

  assert.equal(result.ok, false);
  assert.equal(result.code, 'APP_NOT_ALLOWED');
  assert.equal(runner.calls.length, 0);
});

test('launcher refuses injection strings without spawning', async () => {
  const runner = createFakeRunner();
  const launcher = createAppLauncher({ runner });

  const result = await launcher.launch('notepad & shutdown /s /t 0');

  assert.equal(result.ok, false);
  assert.equal(result.code, 'INJECTION_REJECTED');
  assert.equal(runner.calls.length, 0);
});

test('launcher refuses custom arguments', async () => {
  const runner = createFakeRunner();
  const launcher = createAppLauncher({ runner });

  const result = await launcher.launch('explorer', { args: ['C:\\Windows'] });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'APP_ARGS_REJECTED');
  assert.equal(runner.calls.length, 0);
});

test('launcher is unsupported outside Windows', async () => {
  const runner = createFakeRunner({ platform: 'linux' });
  const launcher = createAppLauncher({ runner, platform: 'linux' });

  const result = await launcher.launch('notepad');

  assert.equal(result.ok, false);
  assert.equal(result.code, 'UNSUPPORTED_PLATFORM');
  assert.equal(runner.calls.length, 0);
});

test('listLaunchableApps exposes names and labels only', () => {
  const apps = listLaunchableApps();
  assert.ok(apps.length >= 7);
  const notepad = apps.find((app) => app.name === 'notepad');
  assert.equal(notepad.label, 'メモ帳');
  assert.equal(notepad.requiresShell, false);
});

/**
 * Tests for lib/desktop/win.js — the PowerShell execution boundary.
 * The critical property: the script is a single argv element, never a shell string.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DesktopError,
  POWERSHELL_EXE,
  assertExecutableName,
  assertSafeArgument,
  buildPowerShellArgs,
  createRunner,
  mapProcessError,
  parseJsonOutput,
  toDesktopError,
} from '../../lib/desktop/win.js';

/** @param {string} code */
function hasCode(code) {
  return (error) => error instanceof DesktopError && error.code === code;
}

test('buildPowerShellArgs pins the documented invocation shape', () => {
  const args = buildPowerShellArgs('Write-Output 1');
  assert.deepEqual(args, [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    'Write-Output 1',
  ]);
});

test('buildPowerShellArgs rejects empty or non-string scripts', () => {
  assert.throws(() => buildPowerShellArgs(''), hasCode('INVALID_SCRIPT'));
  assert.throws(() => buildPowerShellArgs('   '), hasCode('INVALID_SCRIPT'));
  assert.throws(() => buildPowerShellArgs(42), hasCode('INVALID_SCRIPT'));
});

test('parseJsonOutput accepts a BOM and a warning prefix', () => {
  const parsed = parseJsonOutput('\uFEFFWARNING: noisy\r\n{"ok":true,"x":1}\r\n');
  assert.deepEqual(parsed, { ok: true, x: 1 });
});

test('parseJsonOutput accepts pretty json and single-line output', () => {
  assert.deepEqual(parseJsonOutput('{\n  "ok": true\n}'), { ok: true });
  assert.deepEqual(parseJsonOutput('{"ok":true}'), { ok: true });
});

test('parseJsonOutput returns null for a JSON null document', () => {
  assert.equal(parseJsonOutput('null'), null);
});

test('parseJsonOutput reports empty and invalid output', () => {
  assert.throws(() => parseJsonOutput(''), hasCode('EMPTY_OUTPUT'));
  assert.throws(() => parseJsonOutput('not json at all'), hasCode('INVALID_OUTPUT'));
});

test('runPowerShell passes the script as one argv element without a shell', async () => {
  /** @type {any[]} */
  const calls = [];
  const execFileImpl = (file, args, options, cb) => {
    calls.push({ file, args, options });
    cb(null, '{"ok":true}', '');
  };
  const runner = createRunner({ execFileImpl, platform: 'win32' });

  const output = await runner.runPowerShell("Write-Output 'a&b | c'");

  assert.equal(output.stdout, '{"ok":true}');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, POWERSHELL_EXE);
  assert.equal(calls[0].args.length, 6);
  assert.equal(calls[0].args[5], "Write-Output 'a&b | c'");
  assert.equal(calls[0].options.shell, undefined);
  assert.equal(calls[0].options.windowsHide, true);
});

test('runJson parses the payload returned by runPowerShell', async () => {
  const execFileImpl = (file, args, options, cb) => cb(null, '{"ok":true,"cursor":{"x":5,"y":6}}', '');
  const runner = createRunner({ execFileImpl, platform: 'win32' });
  const payload = await runner.runJson('Write-Output 1');
  assert.deepEqual(payload.cursor, { x: 5, y: 6 });
});

test('runPowerShell merges per-call environment variables', async () => {
  /** @type {any} */
  let captured;
  const execFileImpl = (file, args, options, cb) => {
    captured = options;
    cb(null, '{}', '');
  };
  const runner = createRunner({ execFileImpl, platform: 'win32', env: { BASE: '1' } });
  await runner.runJson('Write-Output 1', { env: { DSH_SENDKEYS_B64: 'AAAA' } });
  assert.equal(captured.env.BASE, '1');
  assert.equal(captured.env.DSH_SENDKEYS_B64, 'AAAA');
});

test('runPowerShell maps a timeout to TIMEOUT', async () => {
  const execFileImpl = (file, args, options, cb) => {
    const error = new Error('timed out');
    error.code = 'ETIMEDOUT';
    error.killed = true;
    cb(error, '', '');
  };
  const runner = createRunner({ execFileImpl, platform: 'win32' });
  await assert.rejects(runner.runPowerShell('Write-Output 1'), hasCode('TIMEOUT'));
});

test('runPowerShell maps a missing powershell.exe to BINARY_NOT_FOUND', async () => {
  const execFileImpl = (file, args, options, cb) => {
    const error = new Error('spawn powershell.exe ENOENT');
    error.code = 'ENOENT';
    cb(error, '', '');
  };
  const runner = createRunner({ execFileImpl, platform: 'win32' });
  await assert.rejects(runner.runPowerShell('Write-Output 1'), hasCode('BINARY_NOT_FOUND'));
});

test('runPowerShell maps a failing script to COMMAND_FAILED with stderr', async () => {
  const execFileImpl = (file, args, options, cb) => {
    const error = new Error('exit 1');
    error.code = 1;
    cb(error, '', 'boom: SetCursorPos failed');
  };
  const runner = createRunner({ execFileImpl, platform: 'win32' });
  await assert.rejects(runner.runPowerShell('Write-Output 1'), (error) => {
    assert.equal(error.code, 'COMMAND_FAILED');
    assert.match(error.message, /SetCursorPos failed/);
    return true;
  });
});

test('assertSafeArgument rejects newlines and shell metacharacters', () => {
  assert.equal(assertSafeArgument('notepad.exe', 'executable'), 'notepad.exe');
  assert.throws(() => assertSafeArgument('a\nb'), hasCode('INVALID_ARGUMENT'));
  assert.throws(() => assertSafeArgument('a&b'), hasCode('INJECTION_REJECTED'));
  assert.throws(() => assertSafeArgument('a|b'), hasCode('INJECTION_REJECTED'));
  assert.throws(() => assertSafeArgument('a;b'), hasCode('INJECTION_REJECTED'));
  assert.throws(() => assertSafeArgument(''), hasCode('INVALID_ARGUMENT'));
});

test('assertExecutableName rejects traversal', () => {
  assert.throws(() => assertExecutableName('..\\..\\windows\\system32\\cmd.exe'), hasCode('PATH_TRAVERSAL_REJECTED'));
  assert.throws(() => assertExecutableName('cmd.exe & calc.exe'), hasCode('INJECTION_REJECTED'));
});

test('runProgram passes an argv array and never a shell', async () => {
  /** @type {any[]} */
  const calls = [];
  const execFileImpl = (file, args, options, cb) => {
    calls.push({ file, args, options });
    cb(null, '', '');
  };
  const runner = createRunner({ execFileImpl, platform: 'win32' });
  await runner.runProgram('shutdown.exe', ['/s', '/t', '60']);

  assert.equal(calls[0].file, 'shutdown.exe');
  assert.deepEqual(calls[0].args, ['/s', '/t', '60']);
  assert.equal(calls[0].options.shell, undefined);
});

test('runProgram rejects a metacharacter argument before spawning', async () => {
  let spawned = false;
  const execFileImpl = (file, args, options, cb) => {
    spawned = true;
    cb(null, '', '');
  };
  const runner = createRunner({ execFileImpl, platform: 'win32' });
  await assert.rejects(runner.runProgram('shutdown.exe', ['/s; calc']), hasCode('INJECTION_REJECTED'));
  assert.equal(spawned, false);
});

test('launchApp resolves once the process spawned and reports the command', async () => {
  /** @type {any[]} */
  const calls = [];
  const execFileImpl = (file, args, options, cb) => {
    calls.push({ file, args, options });
    return { pid: 4242, once() {}, on() {} };
  };
  const runner = createRunner({ execFileImpl, platform: 'win32' });
  const result = await runner.launchApp('notepad.exe', []);

  assert.equal(calls[0].file, 'notepad.exe');
  assert.deepEqual(calls[0].args, []);
  assert.equal(calls[0].options.detached, true);
  assert.equal(result.pid, 4242);
  assert.equal(result.file, 'notepad.exe');
});

test('toDesktopError preserves codes and wraps foreign values', () => {
  assert.equal(toDesktopError(new DesktopError('X', 'x')).code, 'X');
  assert.equal(toDesktopError(new Error('plain')).code, 'INTERNAL_ERROR');
  assert.equal(toDesktopError({ code: 'CUSTOM', message: 'm' }).code, 'CUSTOM');
});

test('mapProcessError classifies timeout/not-found/other', () => {
  assert.equal(mapProcessError({ killed: true, code: 'ETIMEDOUT' }).code, 'TIMEOUT');
  assert.equal(mapProcessError({ code: 'ENOENT' }).code, 'BINARY_NOT_FOUND');
  const other = mapProcessError({ code: 2, stderr: 'bad' });
  assert.equal(other.code, 'COMMAND_FAILED');
  assert.match(other.message, /bad/);
});

/**
 * test/desktop/focus.test.mjs
 *
 * Regression tests for `desktop_focus`.
 *
 * The bug this covers (observed live): typing after an `AppActivate` that
 * reported success still landed in a different window, because Windows kept
 * another app in the foreground. The fix reports `focused` explicitly so the
 * caller can stop instead of typing into the wrong window.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FOCUS_ALLOW_ENV,
  FOCUS_PID_ENV,
  FOCUS_TITLE_ENV,
  FOCUSABLE_PROCESSES,
  buildFocusScript,
  createFocuser,
  normalizeFocusTarget,
} from '../../lib/desktop/focus.js';

/** Runner fake that records the script and env it was given. */
function fakeRunner(result) {
  return {
    calls: [],
    async runJson(script, options = {}) {
      this.calls.push({ script, options });
      return typeof result === 'function' ? result() : result;
    },
  };
}

test('スクリプトは AttachThreadInput でフォアグラウンドロックを回避する', () => {
  const script = buildFocusScript();
  assert.match(script, /AttachThreadInput/);
  assert.match(script, /SetForegroundWindow/);
  assert.match(script, /GetForegroundWindow/);
  assert.match(script, /SW_RESTORE|ShowWindow\(\$h, 9\)|ShowWindow\(h, 9\)/);
});

test('スクリプトは入力を文字列連結せず環境変数で受け取る', () => {
  const script = buildFocusScript();
  assert.match(script, new RegExp(`\\$env:${FOCUS_PID_ENV}`));
  assert.match(script, new RegExp(`\\$env:${FOCUS_TITLE_ENV}`));
  assert.match(script, new RegExp(`\\$env:${FOCUS_ALLOW_ENV}`));
});

test('normalizeFocusTarget: pid と title を検証する', () => {
  assert.deepEqual(normalizeFocusTarget({ pid: 1234 }), { pid: 1234, title: null });
  assert.deepEqual(normalizeFocusTarget({ title: ' メモ帳 ' }), { pid: null, title: 'メモ帳' });
  assert.deepEqual(normalizeFocusTarget({ pid: '42', title: 'x' }), { pid: 42, title: 'x' });

  assert.throws(() => normalizeFocusTarget({}), (e) => e.code === 'INVALID_TARGET');
  assert.throws(() => normalizeFocusTarget({ pid: 0 }), (e) => e.code === 'INVALID_PID');
  assert.throws(() => normalizeFocusTarget({ pid: 1.5 }), (e) => e.code === 'INVALID_PID');
  assert.throws(() => normalizeFocusTarget({ pid: -1 }), (e) => e.code === 'INVALID_PID');
  assert.throws(() => normalizeFocusTarget({ title: '   ' }), (e) => e.code === 'INVALID_TITLE');
  assert.throws(() => normalizeFocusTarget({ title: 'x'.repeat(201) }), (e) => e.code === 'INVALID_TITLE');
  assert.throws(() => normalizeFocusTarget({ title: 5 }), (e) => e.code === 'INVALID_TITLE');
});

test('実行: 前面化できたとき focused:true を返す', async () => {
  const runner = fakeRunner({
    ok: true,
    focused: true,
    hwnd: 111,
    pid: 1234,
    title: 'dsh-typing-test.txt - メモ帳',
    process: 'notepad',
    foregroundHwnd: 111,
    foregroundPid: 1234,
    foregroundTitle: 'dsh-typing-test.txt - メモ帳',
  });
  const focuser = createFocuser({ runner });
  const result = await focuser.focus({ pid: 1234 });

  assert.equal(result.ok, true);
  assert.equal(result.focused, true);
  assert.equal(result.title, 'dsh-typing-test.txt - メモ帳');
  assert.equal(runner.calls.length, 1);
  assert.equal(runner.calls[0].options.env[FOCUS_PID_ENV], '1234');
  assert.ok(runner.calls[0].options.env[FOCUS_ALLOW_ENV].includes('notepad'));
});

test('実行: 前面化できなかったときは FOCUS_DENIED を返す（入力してはいけない）', async () => {
  const runner = fakeRunner({
    ok: true,
    focused: false,
    hwnd: 111,
    pid: 1234,
    title: 'メモ帳',
    process: 'notepad',
    foregroundHwnd: 222,
    foregroundPid: 999,
    foregroundTitle: 'Google Chrome',
  });
  const focuser = createFocuser({ runner });
  const result = await focuser.focus({ pid: 1234 });

  assert.equal(result.ok, true);
  assert.equal(result.focused, false);
  assert.equal(result.code, 'FOCUS_DENIED');
  assert.equal(result.foreground.title, 'Google Chrome');
});

test('実行: 一致するウィンドウが無いときは NO_WINDOW を返す', async () => {
  const runner = fakeRunner({ ok: false, code: 'NO_WINDOW', message: 'no matching visible window' });
  const focuser = createFocuser({ runner });
  const result = await focuser.focus({ title: '存在しない' });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'NO_WINDOW');
});

test('実行: 対象プロセスは allowlist に限定される', async () => {
  const runner = fakeRunner({ ok: false, code: 'NO_WINDOW' });
  const focuser = createFocuser({ runner });
  await focuser.focus({ pid: 42 });
  const allow = runner.calls[0].options.env[FOCUS_ALLOW_ENV].split(',');
  assert.ok(allow.includes('chrome'));
  assert.equal(allow.includes('lsass'), false);
  assert.deepEqual([...FOCUSABLE_PROCESSES].includes('notepad'), true);

  const customRunner = fakeRunner({ ok: false, code: 'NO_WINDOW' });
  const custom = createFocuser({ runner: customRunner, allowProcesses: ['notepad'] });
  await custom.focus({ pid: 1 });
  assert.equal(customRunner.calls[0].options.env[FOCUS_ALLOW_ENV], 'notepad');
});

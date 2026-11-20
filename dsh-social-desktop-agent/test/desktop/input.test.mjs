/**
 * Tests for lib/desktop/input.js — clamping, rejection, SendKeys escaping and
 * the "no user text in the script" property.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CLAMP_TOLERANCE_PX,
  MAX_TYPE_LENGTH,
  SENDKEYS_ENV_VAR,
  buildClickScript,
  buildMoveScript,
  buildSendKeysCombo,
  clampToBounds,
  createInput,
  escapeSendKeys,
  normalizeButton,
  normalizeCoordinate,
} from '../../lib/desktop/input.js';
import { createFakeObserver, createFakeRunner, decodeSendKeys } from './helpers.mjs';

/** @param {string} code */
function hasCode(code) {
  return (error) => error && error.code === code;
}

const BOUNDS = { x: -1920, y: 0, width: 3840, height: 1080 };
const SINGLE_BOUNDS = { x: 0, y: 0, width: 1920, height: 1080 };

// --- coordinate validation -------------------------------------------------

test('normalizeCoordinate accepts numbers and numeric strings, rounds to pixels', () => {
  assert.equal(normalizeCoordinate(12, 'x'), 12);
  assert.equal(normalizeCoordinate('12', 'x'), 12);
  assert.equal(normalizeCoordinate(12.4, 'x'), 12);
  assert.equal(normalizeCoordinate(12.6, 'x'), 13);
  assert.equal(normalizeCoordinate(-3, 'x'), -3);
});

test('normalizeCoordinate rejects NaN, Infinity and empty strings', () => {
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, '', 'abc', null, undefined, {}]) {
    assert.throws(() => normalizeCoordinate(value, 'x'), hasCode('INVALID_COORDINATE'));
  }
});

// --- clamping / out-of-screen ---------------------------------------------

test('clampToBounds passes an inside point through unchanged', () => {
  const result = clampToBounds({ x: 100, y: 200 }, SINGLE_BOUNDS);
  assert.equal(result.ok, true);
  assert.equal(result.x, 100);
  assert.equal(result.y, 200);
  assert.equal(result.clamped, false);
});

test('clampToBounds clamps a rounding-level overflow to the edge', () => {
  const right = clampToBounds({ x: 1922, y: 10 }, SINGLE_BOUNDS);
  assert.equal(right.ok, true);
  assert.equal(right.x, 1919);
  assert.equal(right.clamped, true);

  const topLeft = clampToBounds({ x: -3, y: -1 }, SINGLE_BOUNDS);
  assert.equal(topLeft.ok, true);
  assert.equal(topLeft.x, 0);
  assert.equal(topLeft.y, 0);
  assert.equal(topLeft.clamped, true);
});

test('clampToBounds rejects a point that is outside the screen', () => {
  const result = clampToBounds({ x: 5000, y: 10 }, SINGLE_BOUNDS);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'COORD_OUT_OF_SCREEN');
  assert.deepEqual(result.details.requested, { x: 5000, y: 10 });

  const negative = clampToBounds({ x: 10, y: -500 }, SINGLE_BOUNDS);
  assert.equal(negative.ok, false);
  assert.equal(negative.code, 'COORD_OUT_OF_SCREEN');
});

test('clampToBounds honours the multi-monitor virtual screen and tolerance', () => {
  const negativeMonitor = clampToBounds({ x: -1920, y: 0 }, BOUNDS);
  assert.equal(negativeMonitor.ok, true);
  assert.equal(negativeMonitor.x, -1920);

  const justOutside = clampToBounds({ x: -1920 - CLAMP_TOLERANCE_PX - 1, y: 0 }, BOUNDS);
  assert.equal(justOutside.ok, false);
  assert.equal(justOutside.code, 'COORD_OUT_OF_SCREEN');
});

test('clampToBounds rejects invalid bounds', () => {
  const result = clampToBounds({ x: 1, y: 1 }, { x: 0, y: 0, width: 0, height: 0 });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVALID_BOUNDS');
});

// --- SendKeys escaping -----------------------------------------------------

test('escapeSendKeys escapes every SendKeys metacharacter', () => {
  assert.equal(
    escapeSendKeys('a+b^c%d~e(f)g[h]i{j}'),
    'a{+}b{^}c{%}d{~}e{(}f{)}g{[}h{]}i{{}j{}}',
  );
});

test('escapeSendKeys maps newline/tab and normalises CRLF', () => {
  assert.equal(escapeSendKeys('a\nb'), 'a{ENTER}b');
  assert.equal(escapeSendKeys('a\r\nb'), 'a{ENTER}b');
  assert.equal(escapeSendKeys('a\tb'), 'a{TAB}b');
});

test('escapeSendKeys rejects control characters and oversized input', () => {
  assert.throws(() => escapeSendKeys('a\u0007b'), hasCode('INVALID_TEXT'));
  assert.throws(() => escapeSendKeys(''), hasCode('INVALID_TEXT'));
  assert.throws(() => escapeSendKeys(42), hasCode('INVALID_TEXT'));
  assert.throws(() => escapeSendKeys('x'.repeat(MAX_TYPE_LENGTH + 1)), hasCode('INVALID_TEXT'));
});

// --- buttons / keys --------------------------------------------------------

test('normalizeButton and buildSendKeysCombo only accept allowlisted values', () => {
  assert.equal(normalizeButton('right'), 'right');
  assert.throws(() => normalizeButton('scroll'), hasCode('INVALID_BUTTON'));

  assert.deepEqual(buildSendKeysCombo({ key: 'ENTER' }), {
    ok: true,
    combo: '{ENTER}',
    key: 'ENTER',
    modifiers: [],
  });
  assert.equal(buildSendKeysCombo({ key: 'a', modifiers: ['ctrl', 'shift'] }).combo, '^+a');
  assert.equal(buildSendKeysCombo({ key: 'pagedown' }).combo, '{PGDN}');

  assert.equal(buildSendKeysCombo({ key: 'volumeup' }).code, 'UNKNOWN_KEY');
  assert.equal(buildSendKeysCombo({ key: 'a', modifiers: ['meta'] }).code, 'INVALID_MODIFIER');
  assert.equal(buildSendKeysCombo({}).code, 'INVALID_KEY');
});

// --- scripts ---------------------------------------------------------------

test('buildMoveScript embeds only validated integers', () => {
  const script = buildMoveScript(120, 340);
  assert.match(script, /SetCursorPos\(120, 340\)/);
  assert.equal(script.includes('__X__'), false);
  assert.throws(() => buildMoveScript('120; calc', 0), hasCode('INVALID_COORDINATE'));
});

test('buildClickScript is move-then-click in one call', () => {
  const script = buildClickScript({ x: 10, y: 20, button: 'left', count: 2 });
  assert.match(script, /SetCursorPos\(10, 20\)/);
  assert.match(script, /ClickAt\(10, 20, 2, 4, 2, 120\)/);

  // The C# helper must press the button after positioning the cursor.
  const csharpSet = script.indexOf('SetCursorPos(x, y);');
  const csharpDown = script.indexOf('mouse_event(downFlag');
  assert.ok(csharpSet > 0, 'ClickAt must move the cursor first');
  assert.ok(csharpDown > csharpSet, 'the down event must follow the cursor move');
  assert.ok(script.indexOf('mouse_event(upFlag') > csharpDown, 'the up event must follow the down event');
});

// --- input API -------------------------------------------------------------

/** @param {any} [overrides] */
function makeInput(overrides = {}) {
  const runner = overrides.runner ?? createFakeRunner({ responses: [{ ok: true, x: 5, y: 6 }] });
  const observer = overrides.observer ?? createFakeObserver({ bounds: SINGLE_BOUNDS });
  const input = createInput({ runner, observer, platform: overrides.platform });
  return { runner, observer, input };
}

test('move clamps a near-edge point and reports the resolved position', async () => {
  const { runner, input } = makeInput();
  const result = await input.move({ x: 1919, y: 500 });

  assert.equal(result.ok, true);
  assert.deepEqual({ x: result.x, y: result.y }, { x: 5, y: 6 });
  assert.equal(result.clamped, false);
  assert.equal(runner.calls.length, 1);
  assert.match(runner.calls[0].script, /SetCursorPos\(1919, 500\)/);
});

test('move rejects an out-of-screen point without touching the runner', async () => {
  const { runner, input } = makeInput();
  const result = await input.move({ x: 99999, y: 10 });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'COORD_OUT_OF_SCREEN');
  assert.equal(runner.calls.length, 0);
});

test('move reports INVALID_COORDINATE for non-numeric input', async () => {
  const { runner, input } = makeInput();
  const result = await input.move({ x: 'abc', y: 10 });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVALID_COORDINATE');
  assert.equal(runner.calls.length, 0);
});

test('click stays inside the screen and repeats the requested count', async () => {
  const { runner, input } = makeInput({ runner: createFakeRunner({ responses: [{ ok: true, x: 10, y: 20 }] }) });
  const result = await input.click({ x: 10, y: 20, button: 'right', count: 2 });

  assert.equal(result.ok, true);
  assert.equal(result.button, 'right');
  assert.equal(result.count, 2);
  assert.match(runner.calls[0].script, /ClickAt\(10, 20, 8, 16, 2, 120\)/);
});

test('click rejects an off-screen point before running anything', async () => {
  const { runner, input } = makeInput();
  const result = await input.click({ x: -5000, y: 20 });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'COORD_OUT_OF_SCREEN');
  assert.equal(runner.calls.length, 0);
});

test('type sends escaped text through an environment variable, never the script', async () => {
  const { runner, input } = makeInput({ runner: createFakeRunner({ responses: [{ ok: true, sent: true, length: 5 }] }) });
  const result = await input.type({ text: 'Hello' });

  assert.equal(result.ok, true);
  assert.equal(result.length, 5);

  const call = runner.calls[0];
  assert.equal(call.script.includes('Hello'), false, 'the script must not contain the typed text');
  assert.match(call.script, new RegExp(`\\$env:${SENDKEYS_ENV_VAR}`));
  assert.equal(decodeSendKeys(call), 'Hello');
});

test('type escapes SendKeys metacharacters before base64 encoding', async () => {
  const { runner, input } = makeInput();
  await input.type({ text: 'a+b(c)' });
  assert.equal(decodeSendKeys(runner.calls[0]), 'a{+}b{(}c{)}');
});

test('type keeps shell/SQL looking text inert', async () => {
  const hostile = "'); Remove-Item -Recurse C:\\ ; ('& calc | shutdown";
  const { runner, input } = makeInput();
  const result = await input.type({ text: hostile });

  assert.equal(result.ok, true);
  const call = runner.calls[0];
  assert.equal(call.script.includes('Remove-Item'), false);
  assert.equal(call.script.includes('shutdown'), false);
  assert.ok(decodeSendKeys(call).includes('Remove-Item'), 'the text is carried, but only as data');
});

test('type rejects control characters without calling the runner', async () => {
  const { runner, input } = makeInput();
  const result = await input.type({ text: 'a\u0000b' });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVALID_TEXT');
  assert.equal(runner.calls.length, 0);
});

test('key sends an allowlisted key combination', async () => {
  const { runner, input } = makeInput();
  const result = await input.key({ key: 'ENTER', modifiers: ['ctrl'] });

  assert.equal(result.ok, true);
  assert.equal(result.key, 'ENTER');
  assert.equal(decodeSendKeys(runner.calls[0]), '^{ENTER}');
});

test('key rejects an unknown key without calling the runner', async () => {
  const { runner, input } = makeInput();
  const result = await input.key({ key: 'volumeup' });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'UNKNOWN_KEY');
  assert.equal(runner.calls.length, 0);
});

test('input methods are unsupported on non-Windows platforms', async () => {
  const { runner, input } = makeInput({ platform: 'linux' });
  const result = await input.move({ x: 1, y: 1 });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'UNSUPPORTED_PLATFORM');
  assert.equal(runner.calls.length, 0);
});

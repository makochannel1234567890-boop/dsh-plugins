/**
 * Tests for lib/desktop/observe.js — P/Invoke based, read-only observation.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CURSOR_SCRIPT,
  METRICS_SCRIPT,
  OBSERVE_SCRIPT,
  WINDOWS_SCRIPT,
  buildInteropPrelude,
  createObserver,
  normalizeObservePayload,
} from '../../lib/desktop/observe.js';
import { createFakeRunner, desktopFailure, OBSERVE_FIXTURE } from './helpers.mjs';

test('the observation script uses P/Invoke, not WinForms Cursor.Position', () => {
  for (const script of [OBSERVE_SCRIPT, METRICS_SCRIPT, CURSOR_SCRIPT, WINDOWS_SCRIPT]) {
    assert.match(script, /Add-Type/);
    assert.match(script, /GetCursorPos|GetSystemMetrics|EnumWindows/);
    assert.equal(script.includes('[System.Windows.Forms.Cursor]'), false);
  }
  assert.match(OBSERVE_SCRIPT, /GetCursorPos/);
  assert.match(OBSERVE_SCRIPT, /GetSystemMetrics/);
  assert.match(OBSERVE_SCRIPT, /EnumWindows/);
  assert.match(OBSERVE_SCRIPT, /EnumDisplayMonitors/);
  assert.match(OBSERVE_SCRIPT, /GetForegroundWindow/);
});

test('the interop prelude opens and closes the Add-Type here-string correctly', () => {
  const lines = buildInteropPrelude().split('\n');
  assert.equal(lines[0], "$ErrorActionPreference = 'Stop'");
  assert.equal(lines[1], '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8');
  assert.equal(lines[2], "Add-Type -Language CSharp -TypeDefinition @'");
  assert.equal(lines[lines.length - 1], "'@");
  assert.ok(lines.length > 100, 'the C# interop source must be embedded');
});

test('the observation script asks for JSON and a UTF-8 console', () => {
  assert.match(OBSERVE_SCRIPT, /ConvertTo-Json -Compress/);
  assert.match(OBSERVE_SCRIPT, /\[Console\]::OutputEncoding/);
});

test('the monitor query uses GetMonitorInfoW (there is no GetMonitorInfoEx export)', () => {
  assert.match(OBSERVE_SCRIPT, /EntryPoint = "GetMonitorInfoW"/);
  assert.match(OBSERVE_SCRIPT, /GetMonitorInfoExW/);
  assert.equal(OBSERVE_SCRIPT.includes('GetMonitorInfoEx('), false);
});

test('normalizeObservePayload keeps the multi-monitor virtual screen', () => {
  const normalized = normalizeObservePayload(OBSERVE_FIXTURE);
  assert.deepEqual(normalized.metrics.virtualScreen, { x: -1920, y: 0, width: 3840, height: 1080 });
  assert.equal(normalized.metrics.monitorCount, 2);
  assert.equal(normalized.monitors[1].bounds.x, -1920);
  assert.equal(normalized.cursor.x, 10);
});

test('normalizeObservePayload tolerates PowerShell unrolling a single window', () => {
  const payload = { ...OBSERVE_FIXTURE, windows: OBSERVE_FIXTURE.windows[0] };
  const normalized = normalizeObservePayload(payload);
  assert.equal(normalized.windows.length, 1);
  assert.equal(normalized.windows[0].title, 'Untitled - Notepad');
});

test('normalizeObservePayload drops windows without a title and honours maxWindows', () => {
  const payload = {
    ...OBSERVE_FIXTURE,
    windows: [{ hwnd: 1, title: '', bounds: {} }, ...OBSERVE_FIXTURE.windows],
  };
  const normalized = normalizeObservePayload(payload, { maxWindows: 1 });
  assert.equal(normalized.windows.length, 1);
  assert.equal(normalized.windows[0].title, 'Untitled - Notepad');
});

test('normalizeObservePayload fails closed on a missing cursor', () => {
  assert.throws(
    () => normalizeObservePayload({ ...OBSERVE_FIXTURE, cursor: null }),
    (error) => error.code === 'INVALID_OUTPUT',
  );
  assert.throws(() => normalizeObservePayload(null), (error) => error.code === 'INVALID_OUTPUT');
});

test('observer.observe returns a normalized snapshot through the fake runner', async () => {
  const runner = createFakeRunner({ responses: [OBSERVE_FIXTURE] });
  const observer = createObserver({ runner });

  const result = await observer.observe();

  assert.equal(result.ok, true);
  assert.equal(result.cursor.x, 10);
  assert.equal(result.windows.length, 2);
  assert.equal(result.activeWindow.title, 'Untitled - Notepad');
  assert.equal(runner.calls.length, 1);
  assert.equal(runner.calls[0].method, 'runJson');
  assert.match(runner.calls[0].script, /EnumWindows/);
});

test('observer.observe returns a structured error instead of throwing', async () => {
  const runner = createFakeRunner({ responses: [desktopFailure('COMMAND_FAILED', 'powershell died')] });
  const observer = createObserver({ runner });

  const result = await observer.observe();

  assert.equal(result.ok, false);
  assert.equal(result.code, 'COMMAND_FAILED');
  assert.match(result.message, /powershell died/);
});

test('observer methods are unsupported on non-Windows platforms', async () => {
  const runner = createFakeRunner({ platform: 'linux' });
  const observer = createObserver({ runner, platform: 'linux' });

  const result = await observer.observe();

  assert.equal(result.ok, false);
  assert.equal(result.code, 'UNSUPPORTED_PLATFORM');
  assert.equal(runner.calls.length, 0);
});

test('getMetrics reports the virtual screen used for clamping', async () => {
  const runner = createFakeRunner({
    responses: [
      {
        ok: true,
        metrics: {
          virtualScreen: { x: -1920, y: 0, width: 3840, height: 1080 },
          primaryScreen: { width: 1920, height: 1080 },
          monitorCount: 2,
        },
        monitors: OBSERVE_FIXTURE.monitors,
      },
    ],
  });
  const observer = createObserver({ runner });

  const result = await observer.getMetrics();

  assert.equal(result.ok, true);
  assert.deepEqual(result.metrics.virtualScreen, { x: -1920, y: 0, width: 3840, height: 1080 });
  assert.equal(result.metrics.monitorCount, 2);
});

test('getBounds exposes the virtual screen rectangle', async () => {
  const runner = createFakeRunner({ responses: [OBSERVE_FIXTURE] });
  const observer = createObserver({ runner });

  const result = await observer.getBounds();

  assert.equal(result.ok, true);
  assert.deepEqual(result.bounds, { x: -1920, y: 0, width: 3840, height: 1080 });
});

test('listWindows filters empty titles and getCursor returns coordinates', async () => {
  const runner = createFakeRunner({
    responses: [
      {
        ok: true,
        windows: [{ hwnd: 5, title: '', bounds: {} }, OBSERVE_FIXTURE.windows[0]],
        activeWindow: OBSERVE_FIXTURE.activeWindow,
      },
      { ok: true, cursor: { x: 33, y: 44 } },
    ],
  });
  const observer = createObserver({ runner });

  const windows = await observer.listWindows();
  assert.equal(windows.ok, true);
  assert.equal(windows.windows.length, 1);

  const cursor = await observer.getCursor();
  assert.deepEqual({ x: cursor.x, y: cursor.y }, { x: 33, y: 44 });
});

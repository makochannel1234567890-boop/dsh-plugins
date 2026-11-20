/**
 * dsh-social-desktop-agent / lib/desktop/input.js
 *
 * Pointer and keyboard input for Windows.
 *
 * Safety properties:
 *  - Coordinates are validated with `Number` and clamped to the virtual screen
 *    bounding box (multi-monitor aware). A point further outside than
 *    CLAMP_TOLERANCE_PX is rejected instead of being silently clamped, so a
 *    mistyped 100000,100000 cannot land somewhere unexpected.
 *  - A click is always "move then click" in one PowerShell call: SetCursorPos
 *    followed by mouse_event down/up. Doing both in one call avoids a race where
 *    another app steals the cursor between two calls.
 *  - Typed text is NEVER concatenated into the PowerShell script. It is escaped
 *    for the SendKeys mini-language in JS, base64-encoded and passed as an
 *    environment variable; the script only decodes it. Shell metacharacters such
 *    as `; & | $( )` therefore cannot break out of the script.
 *  - Key names and modifiers come from fixed allowlist tables, never from free
 *    text.
 */

import { DesktopError, createRunner, toDesktopError } from './win.js';
import { buildConsolePrelude, buildInteropPrelude, createObserver } from './observe.js';

/** How far outside the virtual screen a point may be before it is rejected. */
export const CLAMP_TOLERANCE_PX = 4;
/** Maximum number of characters accepted by desktop_type. */
export const MAX_TYPE_LENGTH = 2000;
/** Maximum repeat count for a click. */
export const MAX_CLICK_COUNT = 3;
/** Environment variable carrying the base64 SendKeys payload. */
export const SENDKEYS_ENV_VAR = 'DSH_SENDKEYS_B64';

/** mouse_event flags per button. */
export const MOUSE_FLAGS = Object.freeze({
  left: Object.freeze({ down: 0x0002, up: 0x0004 }),
  right: Object.freeze({ down: 0x0008, up: 0x0010 }),
  middle: Object.freeze({ down: 0x0020, up: 0x0040 }),
});

/** Modifier prefixes used by the SendKeys syntax (order: ctrl, alt, shift). */
export const MODIFIER_PREFIXES = Object.freeze({ ctrl: '^', alt: '%', shift: '+' });

/** Named keys that can be sent. Values are SendKeys tokens. */
export const KEY_NAMES = Object.freeze({
  enter: '{ENTER}',
  return: '{ENTER}',
  tab: '{TAB}',
  esc: '{ESC}',
  escape: '{ESC}',
  backspace: '{BACKSPACE}',
  delete: '{DELETE}',
  del: '{DELETE}',
  insert: '{INSERT}',
  ins: '{INSERT}',
  space: ' ',
  up: '{UP}',
  down: '{DOWN}',
  left: '{LEFT}',
  right: '{RIGHT}',
  home: '{HOME}',
  end: '{END}',
  pageup: '{PGUP}',
  pgup: '{PGUP}',
  pagedown: '{PGDN}',
  pgdn: '{PGDN}',
  f1: '{F1}',
  f2: '{F2}',
  f3: '{F3}',
  f4: '{F4}',
  f5: '{F5}',
  f6: '{F6}',
  f7: '{F7}',
  f8: '{F8}',
  f9: '{F9}',
  f10: '{F10}',
  f11: '{F11}',
  f12: '{F12}',
});

/** Characters that have a special meaning in the SendKeys mini-language. */
const SENDKEYS_SPECIAL = new Set(['+', '^', '%', '~', '(', ')', '[', ']', '{', '}']);

/**
 * Validate a coordinate and return it as an integer inside the safe range.
 * @param {unknown} value
 * @param {string} [label]
 * @returns {number}
 */
export function normalizeCoordinate(value, label = 'coordinate') {
  let num = value;
  if (typeof num === 'string') {
    const trimmed = num.trim();
    if (trimmed === '') {
      throw new DesktopError('INVALID_COORDINATE', `${label} must be a finite number`, { [label]: value });
    }
    num = Number(trimmed);
  }
  if (typeof num !== 'number' || !Number.isFinite(num)) {
    throw new DesktopError('INVALID_COORDINATE', `${label} must be a finite number`, { [label]: value });
  }
  const rounded = Math.round(num);
  if (!Number.isSafeInteger(rounded)) {
    throw new DesktopError('INVALID_COORDINATE', `${label} is outside the safe integer range`, { [label]: value });
  }
  return rounded;
}

/**
 * Clamp a point to a screen rectangle.
 *
 * Points inside the rectangle pass through untouched. Points that overflow by at
 * most `tolerancePx` (DPI rounding, right/bottom edge off-by-one) are clamped to
 * the nearest edge and report `clamped: true`. Anything further outside is
 * rejected with COORD_OUT_OF_SCREEN.
 *
 * @param {{ x: unknown, y: unknown }} point
 * @param {{ x:number, y:number, width:number, height:number }} bounds
 * @param {{ tolerancePx?: number }} [options]
 * @returns {{ ok:true, x:number, y:number, clamped:boolean, bounds:{x:number,y:number,width:number,height:number} }
 *          | { ok:false, code:string, message:string, details:object }}
 */
export function clampToBounds(point, bounds, options = {}) {
  const tolerancePx = options.tolerancePx ?? CLAMP_TOLERANCE_PX;
  const x = normalizeCoordinate(point?.x, 'x');
  const y = normalizeCoordinate(point?.y, 'y');

  const rect = bounds ?? {};
  const width = Number(rect.width);
  const height = Number(rect.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return {
      ok: false,
      code: 'INVALID_BOUNDS',
      message: 'screen bounds are missing or invalid',
      details: { bounds: rect },
    };
  }
  const left = Number(rect.x) || 0;
  const top = Number(rect.y) || 0;
  const right = left + width - 1;
  const bottom = top + height - 1;

  const overflowLeft = left - x;
  const overflowRight = x - right;
  const overflowTop = top - y;
  const overflowBottom = y - bottom;
  const worst = Math.max(overflowLeft, overflowRight, overflowTop, overflowBottom);

  if (worst > tolerancePx) {
    return {
      ok: false,
      code: 'COORD_OUT_OF_SCREEN',
      message: 'coordinate is outside the virtual screen',
      details: {
        requested: { x, y },
        bounds: { x: left, y: top, width, height },
        tolerancePx,
      },
    };
  }

  const clampedX = Math.min(Math.max(x, left), right);
  const clampedY = Math.min(Math.max(y, top), bottom);
  return {
    ok: true,
    x: clampedX,
    y: clampedY,
    clamped: clampedX !== x || clampedY !== y,
    bounds: { x: left, y: top, width, height },
  };
}

/**
 * Escape a text for the SendKeys mini-language.
 *
 * SendKeys treats + ^ % ~ ( ) [ ] { } as control characters; every one of them
 * must be wrapped in braces to be typed literally. Newlines become {ENTER} and
 * tabs {TAB}; other control characters are rejected.
 *
 * @param {unknown} text
 * @returns {string}
 */
export function escapeSendKeys(text) {
  if (typeof text !== 'string') {
    throw new DesktopError('INVALID_TEXT', 'text must be a string');
  }
  if (text.length === 0) {
    throw new DesktopError('INVALID_TEXT', 'text must not be empty');
  }
  if (text.length > MAX_TYPE_LENGTH) {
    throw new DesktopError('INVALID_TEXT', `text must not exceed ${MAX_TYPE_LENGTH} characters`, {
      length: text.length,
    });
  }

  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === '\r') continue;
    if (ch === '\n') {
      out += '{ENTER}';
      continue;
    }
    if (ch === '\t') {
      out += '{TAB}';
      continue;
    }
    if (code < 0x20 || code === 0x7f) {
      throw new DesktopError('INVALID_TEXT', 'control characters cannot be typed', {
        char: `U+${code.toString(16).toUpperCase().padStart(4, '0')}`,
      });
    }
    if (SENDKEYS_SPECIAL.has(ch)) {
      out += `{${ch}}`;
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * Validate a click button name.
 * @param {unknown} [button]
 * @returns {'left'|'right'|'middle'}
 */
export function normalizeButton(button = 'left') {
  const value = typeof button === 'string' ? button.trim().toLowerCase() : '';
  if (!Object.prototype.hasOwnProperty.call(MOUSE_FLAGS, value)) {
    throw new DesktopError('INVALID_BUTTON', 'button must be one of left, right, middle', { button });
  }
  return /** @type {'left'|'right'|'middle'} */ (value);
}

/**
 * Validate the repeat count for a click.
 * @param {unknown} [count]
 * @returns {number}
 */
export function normalizeClickCount(count = 1) {
  const n = typeof count === 'string' && count.trim() !== '' ? Number(count) : count;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > MAX_CLICK_COUNT) {
    throw new DesktopError('INVALID_CLICK_COUNT', `count must be an integer between 1 and ${MAX_CLICK_COUNT}`, {
      count,
    });
  }
  return n;
}

/**
 * Turn `{ key, modifiers }` into a SendKeys expression.
 *
 * @param {{ key?: unknown, modifiers?: unknown }} input
 * @returns {{ ok:true, combo:string, key:string, modifiers:string[] } | { ok:false, code:string, message:string, details:object }}
 */
export function buildSendKeysCombo(input = {}) {
  const rawKey = typeof input.key === 'string' ? input.key.trim() : '';
  if (rawKey === '') {
    return { ok: false, code: 'INVALID_KEY', message: 'key must be a non-empty string', details: {} };
  }

  const rawModifiers = input.modifiers === undefined || input.modifiers === null ? [] : input.modifiers;
  if (!Array.isArray(rawModifiers)) {
    return { ok: false, code: 'INVALID_MODIFIER', message: 'modifiers must be an array', details: {} };
  }
  const modifiers = [];
  for (const raw of rawModifiers) {
    const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    if (!Object.prototype.hasOwnProperty.call(MODIFIER_PREFIXES, value)) {
      return {
        ok: false,
        code: 'INVALID_MODIFIER',
        message: 'modifiers must be ctrl, alt or shift',
        details: { modifier: raw },
      };
    }
    if (!modifiers.includes(value)) modifiers.push(value);
  }

  const lower = rawKey.toLowerCase();
  let base;
  if (Object.prototype.hasOwnProperty.call(KEY_NAMES, lower)) {
    base = KEY_NAMES[lower];
  } else if (/^[A-Za-z0-9]$/.test(rawKey)) {
    base = rawKey;
  } else {
    return {
      ok: false,
      code: 'UNKNOWN_KEY',
      message: 'key is not in the allowlist',
      details: { key: rawKey, allowed: Object.keys(KEY_NAMES) },
    };
  }

  const prefix = modifiers.map((m) => MODIFIER_PREFIXES[m]).join('');
  return { ok: true, combo: `${prefix}${base}`, key: rawKey, modifiers };
}

const MOVE_BODY = String.raw`
$ok = [DshDesktopInterop]::SetCursorPos(__X__, __Y__)
if (-not $ok) { throw 'SetCursorPos failed' }
$p = [DshDesktopInterop]::GetCursorPoint()
if ($null -eq $p) { throw 'GetCursorPos failed' }
@{ ok = $true; x = $p[0]; y = $p[1] } | ConvertTo-Json -Compress -Depth 3
`;

/**
 * Build the move script for validated integer coordinates.
 * @param {number} x
 * @param {number} y
 * @returns {string}
 */
export function buildMoveScript(x, y) {
  const px = normalizeCoordinate(x, 'x');
  const py = normalizeCoordinate(y, 'y');
  return `${buildInteropPrelude()}\n${MOVE_BODY.replace('__X__', String(px)).replace('__Y__', String(py)).trim()}\n`;
}

/**
 * Build the click script (move then click in a single call, to avoid a cursor race).
 * @param {{ x:number, y:number, button?: 'left'|'right'|'middle', count?: number }} input
 * @returns {string}
 */
export function buildClickScript(input) {
  const x = normalizeCoordinate(input?.x, 'x');
  const y = normalizeCoordinate(input?.y, 'y');
  const button = normalizeButton(input?.button);
  const count = normalizeClickCount(input?.count);
  const flags = MOUSE_FLAGS[button];
  const body = String.raw`
$ok = [DshDesktopInterop]::SetCursorPos(__X__, __Y__)
if (-not $ok) { throw 'SetCursorPos failed' }
[DshDesktopInterop]::ClickAt(__X__, __Y__, __DOWN__, __UP__, __COUNT__, 120)
$p = [DshDesktopInterop]::GetCursorPoint()
if ($null -eq $p) { throw 'GetCursorPos failed' }
@{ ok = $true; x = $p[0]; y = $p[1]; button = '__BUTTON__'; count = __COUNT__ } |
  ConvertTo-Json -Compress -Depth 3
`
    .trim()
    .replaceAll('__X__', String(x))
    .replaceAll('__Y__', String(y))
    .replaceAll('__DOWN__', String(flags.down))
    .replaceAll('__UP__', String(flags.up))
    .replaceAll('__COUNT__', String(count))
    .replaceAll('__BUTTON__', button);
  return `${buildInteropPrelude()}\n${body}\n`;
}

/**
 * SendKeys script. The payload arrives via an environment variable (base64) and is
 * decoded inside PowerShell, so no user text is ever part of the script source.
 */
const SENDKEYS_BODY = String.raw`
Add-Type -AssemblyName System.Windows.Forms
$b64 = $env:__ENV__
if ([string]::IsNullOrEmpty($b64)) { throw 'missing SendKeys payload' }
$text = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($b64))
[System.Windows.Forms.SendKeys]::SendWait($text)
@{ ok = $true; sent = $true; length = $text.Length } | ConvertTo-Json -Compress -Depth 3
`;

// SendKeys does not need the P/Invoke shim, so its script skips the Add-Type
// compile (~1-2 s saved per keystroke call).
export const SENDKEYS_SCRIPT = `${buildConsolePrelude()}\n${SENDKEYS_BODY.replaceAll('__ENV__', SENDKEYS_ENV_VAR).trim()}\n`;

/**
 * Create the input API.
 *
 * @param {{
 *   runner?: ReturnType<typeof createRunner>,
 *   observer?: ReturnType<typeof createObserver>,
 *   platform?: NodeJS.Platform,
 *   timeoutMs?: number,
 * }} [options]
 */
export function createInput(options = {}) {
  const runner = options.runner ?? createRunner();
  const observer = options.observer ?? createObserver({ runner });
  const platform = options.platform ?? runner.platform ?? process.platform;
  const timeoutMs = options.timeoutMs ?? 20_000;

  function ensureWindows() {
    if (platform !== 'win32') {
      throw new DesktopError('UNSUPPORTED_PLATFORM', 'desktop input requires Windows', { platform });
    }
  }

  /** @param {{ bounds?: any }} [input] */
  async function resolveBounds(input = {}) {
    if (input.bounds) return { ok: true, bounds: input.bounds };
    const metrics = await observer.getMetrics();
    if (!metrics?.ok) {
      return {
        ok: false,
        code: metrics?.code ?? 'OBSERVE_FAILED',
        message: metrics?.message ?? 'could not read screen bounds',
        details: metrics?.details ?? {},
      };
    }
    return { ok: true, bounds: metrics.metrics.virtualScreen };
  }

  /**
   * Move the cursor. Coordinates are clamped; a point far outside is rejected.
   * @param {{ x?: unknown, y?: unknown, bounds?: any }} [input]
   */
  async function move(input = {}) {
    try {
      ensureWindows();
      if (input.bounds) {
        // Validate the supplied bounds shape before clamping.
        const supplied = await resolveBounds(input);
        if (!supplied.ok) return supplied;
      }
      let bounds = input.bounds;
      if (!bounds) {
        const resolved = await resolveBounds(input);
        if (!resolved.ok) return resolved;
        bounds = resolved.bounds;
      }
      const clamped = clampToBounds({ x: input.x, y: input.y }, bounds);
      if (!clamped.ok) return clamped;

      const result = await runner.runJson(buildMoveScript(clamped.x, clamped.y), { timeout: timeoutMs });
      const finalX = Number.isFinite(Number(result?.x)) ? Number(result.x) : clamped.x;
      const finalY = Number.isFinite(Number(result?.y)) ? Number(result.y) : clamped.y;
      return {
        ok: true,
        x: finalX,
        y: finalY,
        requested: { x: normalizeCoordinate(input.x, 'x'), y: normalizeCoordinate(input.y, 'y') },
        clamped: clamped.clamped,
      };
    } catch (error) {
      return toDesktopError(error, 'MOVE_FAILED').toJSON();
    }
  }

  /**
   * Click at a point: the script moves the cursor first, then presses the button.
   * @param {{ x?: unknown, y?: unknown, button?: unknown, count?: unknown, bounds?: any }} [input]
   */
  async function click(input = {}) {
    try {
      ensureWindows();
      const button = normalizeButton(input.button);
      const count = normalizeClickCount(input.count);
      let bounds = input.bounds;
      if (!bounds) {
        const resolved = await resolveBounds(input);
        if (!resolved.ok) return resolved;
        bounds = resolved.bounds;
      }
      const clamped = clampToBounds({ x: input.x, y: input.y }, bounds);
      if (!clamped.ok) return clamped;

      const result = await runner.runJson(
        buildClickScript({ x: clamped.x, y: clamped.y, button, count }),
        { timeout: timeoutMs },
      );
      return {
        ok: true,
        x: Number(result?.x ?? clamped.x),
        y: Number(result?.y ?? clamped.y),
        button,
        count,
        clamped: clamped.clamped,
      };
    } catch (error) {
      return toDesktopError(error, 'CLICK_FAILED').toJSON();
    }
  }

  /**
   * Type text with SendKeys. The text itself never appears in the script.
   * @param {{ text?: unknown }} [input]
   */
  async function type(input = {}) {
    try {
      ensureWindows();
      const text = input.text;
      const escaped = escapeSendKeys(text);
      const payload = Buffer.from(escaped, 'utf8').toString('base64');
      const result = await runner.runJson(SENDKEYS_SCRIPT, {
        timeout: timeoutMs,
        env: { [SENDKEYS_ENV_VAR]: payload },
      });
      return {
        ok: true,
        typed: true,
        length: /** @type {string} */ (text).length,
        sentLength: Number(result?.length ?? escaped.length),
      };
    } catch (error) {
      return toDesktopError(error, 'TYPE_FAILED').toJSON();
    }
  }

  /**
   * Press one key, optionally with modifiers (ctrl/alt/shift).
   * @param {{ key?: unknown, modifiers?: unknown }} [input]
   */
  async function key(input = {}) {
    try {
      ensureWindows();
      const combo = buildSendKeysCombo(input);
      if (!combo.ok) return combo;
      const payload = Buffer.from(combo.combo, 'utf8').toString('base64');
      const result = await runner.runJson(SENDKEYS_SCRIPT, {
        timeout: timeoutMs,
        env: { [SENDKEYS_ENV_VAR]: payload },
      });
      return {
        ok: true,
        sent: true,
        key: combo.key,
        modifiers: combo.modifiers,
        sentLength: Number(result?.length ?? combo.combo.length),
      };
    } catch (error) {
      return toDesktopError(error, 'KEY_FAILED').toJSON();
    }
  }

  return { move, click, type, key, platform, observer };
}

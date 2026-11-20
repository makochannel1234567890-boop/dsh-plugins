/**
 * dsh-social-desktop-agent / lib/desktop/focus.js
 *
 * Bring a window to the foreground — reliably.
 *
 * Why this exists
 * ---------------
 * `desktop_type` / `desktop_key` / `desktop_click` send input to whatever window
 * Windows currently considers foreground. In practice that is fragile:
 *
 *   - `WScript.Shell.AppActivate()` silently fails on modern Windows because the
 *     foreground-lock rejects a background process (our PowerShell child) from
 *     stealing focus; it returns `$false` or, worse, `$true` while the foreground
 *     window stays something else (observed live: keystrokes landed in a browser
 *     tab instead of Notepad).
 *   - Windows 11 Notepad recreates its HWND on some operations, so a cached handle
 *     goes stale between calls.
 *
 * So focus and input are separated: this module resolves the window fresh on every
 * call, restores it if minimised, and forces the foreground with AttachThreadInput
 * (the same technique user tools use). The result explicitly reports whether the
 * foreground really became the target.
 *
 * Safety
 * ------
 *   - only windows of allowlisted applications are ever focused
 *     (same app family as `app_launch`; the process name is checked server-side);
 *   - the caller can never pass a raw handle or a script: pid/title arrive through
 *     environment variables, never through string interpolation;
 *   - everything goes through the injected runner (argv array, no shell).
 */

import { DesktopError, toDesktopError } from './win.js';

/** Environment variables carrying the request. Values never enter the script text. */
export const FOCUS_PID_ENV = 'DSH_FOCUS_PID';
export const FOCUS_TITLE_ENV = 'DSH_FOCUS_TITLE';
export const FOCUS_ALLOW_ENV = 'DSH_FOCUS_ALLOW';

/**
 * Process names that may be focused. Matches the `app_launch` allowlist family
 * (plus the UWP host of the Calculator app on Windows 11).
 */
export const FOCUSABLE_PROCESSES = Object.freeze([
  'notepad',
  'calc',
  'calculatorapp',
  'calculator',
  'explorer',
  'mspaint',
  'chrome',
  'msedge',
  'code',
]);

const INTEROP_CS = String.raw`
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class DshFocusInterop
{
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int maxCount);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool attach);

    public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

    public static string Title(IntPtr h)
    {
        var sb = new StringBuilder(512);
        GetWindowTextW(h, sb, sb.Capacity);
        return sb.ToString();
    }

    public static uint PidOf(IntPtr h)
    {
        uint pid;
        GetWindowThreadProcessId(h, out pid);
        return pid;
    }

    /// Focus h, working around the foreground lock with AttachThreadInput.
    public static bool Force(IntPtr h)
    {
        if (!IsWindow(h)) return false;
        if (IsIconic(h)) ShowWindow(h, 9);           // SW_RESTORE
        IntPtr fg = GetForegroundWindow();
        if (fg == h) return true;

        uint fgPid;
        uint fgThread = GetWindowThreadProcessId(fg, out fgPid);
        uint mine = GetCurrentThreadId();
        bool attached = false;
        if (fgThread != 0 && fgThread != mine)
        {
            attached = AttachThreadInput(fgThread, mine, true);
        }
        BringWindowToTop(h);
        bool ok = SetForegroundWindow(h);
        if (attached) AttachThreadInput(fgThread, mine, false);
        return ok;
    }
}
`;

/**
 * Build the focus script. All parameters travel via environment variables.
 * @returns {string}
 */
export function buildFocusScript() {
  return String.raw`$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -Language CSharp -TypeDefinition @'
${INTEROP_CS.trim()}
'@

$wantPid = 0
if ($env:${FOCUS_PID_ENV}) { $wantPid = [int]$env:${FOCUS_PID_ENV} }
$wantTitle = ''
if ($env:${FOCUS_TITLE_ENV}) { $wantTitle = [string]$env:${FOCUS_TITLE_ENV} }
$allow = @()
if ($env:${FOCUS_ALLOW_ENV}) { $allow = @($env:${FOCUS_ALLOW_ENV} -split ',' | ForEach-Object { $_.Trim().ToLower() } | Where-Object { $_ }) }

$script:candidates = New-Object System.Collections.ArrayList
$callback = [DshFocusInterop+EnumProc]{
  param($hwnd, $lparam)
  try {
    if ([DshFocusInterop]::IsWindowVisible($hwnd)) {
      $t = [DshFocusInterop]::Title($hwnd)
      if ($t -and $t.Trim().Length -gt 0) {
        [void]$script:candidates.Add([pscustomobject]@{
          hwnd = [int64]$hwnd
          pid = [int][DshFocusInterop]::PidOf($hwnd)
          title = $t
        })
      }
    }
  } catch { }
  return $true
}
[void][DshFocusInterop]::EnumWindows($callback, [IntPtr]::Zero)

$selected = $null
foreach ($c in $script:candidates) {
  if ($wantPid -gt 0 -and $c.pid -ne $wantPid) { continue }
  if ($wantTitle -and ($c.title.ToLower().IndexOf($wantTitle.ToLower()) -lt 0)) { continue }
  $proc = ''
  try { $proc = (Get-Process -Id $c.pid -ErrorAction Stop).ProcessName.ToLower() } catch { $proc = '' }
  if ($allow.Count -gt 0 -and ($allow -notcontains $proc)) { continue }
  $selected = [pscustomobject]@{ hwnd = $c.hwnd; pid = $c.pid; title = $c.title; process = $proc }
  break
}

if ($null -eq $selected) {
  @{ ok = $false; code = 'NO_WINDOW'; message = 'no matching visible window (pid/title/allowlist)'; candidates = $script:candidates.Count } | ConvertTo-Json -Compress
  exit 0
}

$target = [IntPtr]$selected.hwnd
$focused = $false
for ($i = 0; $i -lt 3; $i++) {
  [void][DshFocusInterop]::Force($target)
  Start-Sleep -Milliseconds 200
  if ([DshFocusInterop]::GetForegroundWindow() -eq $target) { $focused = $true; break }
}

$fg = [DshFocusInterop]::GetForegroundWindow()
@{ ok = $true
   hwnd = $selected.hwnd
   pid = $selected.pid
   title = $selected.title
   process = $selected.process
   focused = $focused
   foregroundHwnd = [int64]$fg
   foregroundPid = [int][DshFocusInterop]::PidOf($fg)
   foregroundTitle = [DshFocusInterop]::Title($fg)
} | ConvertTo-Json -Compress
`;
}

/**
 * @param {unknown} raw
 * @returns {{ pid: number|null, title: string|null }}
 */
export function normalizeFocusTarget(raw = {}) {
  const input = raw && typeof raw === 'object' ? raw : {};
  let pid = null;
  if (input.pid !== undefined && input.pid !== null) {
    const n = Number(input.pid);
    if (!Number.isInteger(n) || n <= 0 || n > 2 ** 31 - 1) {
      throw new DesktopError('INVALID_PID', 'pid must be a positive integer', { pid: input.pid });
    }
    pid = n;
  }
  let title = null;
  if (input.title !== undefined && input.title !== null) {
    if (typeof input.title !== 'string') {
      throw new DesktopError('INVALID_TITLE', 'title must be a string', { title: typeof input.title });
    }
    const trimmed = input.title.trim();
    if (trimmed.length === 0) throw new DesktopError('INVALID_TITLE', 'title must not be empty');
    if (trimmed.length > 200) throw new DesktopError('INVALID_TITLE', 'title must be at most 200 characters');
    title = trimmed;
  }
  if (pid === null && title === null) {
    throw new DesktopError('INVALID_TARGET', 'provide pid and/or title');
  }
  return { pid, title };
}

/**
 * Create the focus helper bound to a runner.
 * @param {{ runner: { runJson: Function }, allowProcesses?: string[] }} options
 */
export function createFocuser(options = {}) {
  const runner = options.runner;
  if (!runner || typeof runner.runJson !== 'function') {
    throw new DesktopError('RUNNER_INVALID', 'focus requires a runner with runJson()');
  }
  const allow = Array.isArray(options.allowProcesses) && options.allowProcesses.length > 0
    ? options.allowProcesses.map((name) => String(name).toLowerCase())
    : [...FOCUSABLE_PROCESSES];
  const script = buildFocusScript();

  /**
   * @param {{ pid?: unknown, title?: unknown }} [target]
   */
  async function focus(target = {}) {
    const normalized = normalizeFocusTarget(target);
    /** @type {Record<string, string>} */
    const env = { [FOCUS_ALLOW_ENV]: allow.join(',') };
    if (normalized.pid !== null) env[FOCUS_PID_ENV] = String(normalized.pid);
    if (normalized.title !== null) env[FOCUS_TITLE_ENV] = normalized.title;

    let result;
    try {
      result = await runner.runJson(script, { timeout: 20_000, env });
    } catch (error) {
      throw toDesktopError(error, 'FOCUS_FAILED');
    }

    if (!result || result.ok !== true) {
      return {
        ok: false,
        code: (result && result.code) || 'NO_WINDOW',
        message: (result && result.message) || 'matching window not found',
        target: normalized,
      };
    }

    const focused = result.focused === true;
    return {
      ok: true,
      focused,
      hwnd: result.hwnd,
      pid: result.pid,
      title: result.title,
      process: result.process,
      foreground: {
        hwnd: result.foregroundHwnd,
        pid: result.foregroundPid,
        title: result.foregroundTitle,
      },
      // A focus that did not take is reported as a failure the caller can see:
      // sending keystrokes anyway is exactly the bug this module exists to stop.
      ...(focused
        ? {}
        : {
            code: 'FOCUS_DENIED',
            message: 'window was found but Windows kept another window in the foreground',
          }),
      target: normalized,
    };
  }

  return { focus, allowProcesses: allow, script };
}

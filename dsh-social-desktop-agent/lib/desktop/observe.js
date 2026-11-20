/**
 * dsh-social-desktop-agent / lib/desktop/observe.js
 *
 * Read-only desktop observation for Windows.
 *
 * Everything is queried through a small C# P/Invoke shim compiled with
 * `Add-Type` inside a short-lived PowerShell process:
 *   GetCursorPos, GetSystemMetrics, EnumWindows, GetWindowTextW, GetClassNameW,
 *   GetWindowRect, IsWindowVisible, IsIconic, GetForegroundWindow,
 *   EnumDisplayMonitors, GetMonitorInfoEx.
 *
 * [System.Windows.Forms.Cursor]::Position is deliberately NOT used: it may be
 * unavailable (no WinForms assembly), and it does not expose the virtual screen
 * of a multi-monitor setup.
 *
 * Output is always JSON. Failures become structured objects
 * `{ ok:false, code, message, details }` — callers never see a raw throw.
 */

import { DesktopError, createRunner, toDesktopError } from './win.js';

/**
 * C# P/Invoke shim. Compiled by Add-Type on every observation call (cheap enough:
 * each call is its own PowerShell process, so there is no cross-call state).
 */
export const DESKTOP_INTEROP_CS = String.raw`
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class DshDesktopInterop
{
    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X; public int Y; }

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    public struct MONITORINFO
    {
        public int cbSize;
        public RECT rcMonitor;
        public RECT rcWork;
        public uint dwFlags;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct MONITORINFOEX
    {
        public int cbSize;
        public RECT rcMonitor;
        public RECT rcWork;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
        public string szDevice;
    }

    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    public delegate bool EnumMonitorsProc(IntPtr hMonitor, IntPtr hdc, ref RECT lprcMonitor, IntPtr dwData);

    public const int SM_CXSCREEN = 0;
    public const int SM_CYSCREEN = 1;
    public const int SM_XVIRTUALSCREEN = 76;
    public const int SM_YVIRTUALSCREEN = 77;
    public const int SM_CXVIRTUALSCREEN = 78;
    public const int SM_CYVIRTUALSCREEN = 79;

    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern int GetSystemMetrics(int nIndex);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT lpPoint);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    [DllImport("user32.dll")] public static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr lprcClip, EnumMonitorsProc lpfnEnum, IntPtr dwData);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFO lpmi);
    // There is no exported "GetMonitorInfoEx": the wide variant of GetMonitorInfo
    // accepts MONITORINFOEXW, so it is requested explicitly by entry point.
    [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "GetMonitorInfoW")]
    public static extern bool GetMonitorInfoExW(IntPtr hMonitor, ref MONITORINFOEX lpmi);
    [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);

    static DshDesktopInterop()
    {
        try { SetProcessDPIAware(); }
        catch (Exception) { }
    }

    public static string GetWindowTitle(IntPtr hWnd)
    {
        StringBuilder sb = new StringBuilder(1024);
        GetWindowTextW(hWnd, sb, sb.Capacity);
        return sb.ToString();
    }

    public static string GetWindowClass(IntPtr hWnd)
    {
        StringBuilder sb = new StringBuilder(512);
        GetClassNameW(hWnd, sb, sb.Capacity);
        return sb.ToString();
    }

    public static uint GetWindowPid(IntPtr hWnd)
    {
        uint pid;
        GetWindowThreadProcessId(hWnd, out pid);
        return pid;
    }

    public static int[] GetWindowBounds(IntPtr hWnd)
    {
        RECT r;
        if (!GetWindowRect(hWnd, out r)) return new int[] { 0, 0, 0, 0 };
        return new int[] { r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top };
    }

    public static List<IntPtr> EnumerateWindows()
    {
        List<IntPtr> list = new List<IntPtr>();
        EnumWindows(delegate(IntPtr hWnd, IntPtr lParam) { list.Add(hWnd); return true; }, IntPtr.Zero);
        return list;
    }

    public static List<MONITORINFOEX> EnumerateMonitors()
    {
        List<MONITORINFOEX> list = new List<MONITORINFOEX>();
        EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, delegate(IntPtr hMonitor, IntPtr hdc, ref RECT rect, IntPtr data)
        {
            MONITORINFOEX info = new MONITORINFOEX();
            info.cbSize = Marshal.SizeOf(typeof(MONITORINFOEX));
            if (GetMonitorInfoExW(hMonitor, ref info)) list.Add(info);
            return true;
        }, IntPtr.Zero);
        return list;
    }

    public static int[] GetCursorPoint()
    {
        POINT p;
        if (!GetCursorPos(out p)) return null;
        return new int[] { p.X, p.Y };
    }

    public static int[] GetVirtualScreen()
    {
        return new int[] {
            GetSystemMetrics(SM_XVIRTUALSCREEN),
            GetSystemMetrics(SM_YVIRTUALSCREEN),
            GetSystemMetrics(SM_CXVIRTUALSCREEN),
            GetSystemMetrics(SM_CYVIRTUALSCREEN)
        };
    }

    public static void ClickAt(int x, int y, uint downFlag, uint upFlag, int count, int intervalMs)
    {
        for (int i = 0; i < count; i++)
        {
            SetCursorPos(x, y);
            mouse_event(downFlag, 0, 0, 0, UIntPtr.Zero);
            System.Threading.Thread.Sleep(20);
            mouse_event(upFlag, 0, 0, 0, UIntPtr.Zero);
            if (i < count - 1) System.Threading.Thread.Sleep(intervalMs);
        }
    }
}
`.trim();

/**
 * Minimal prelude for scripts that do not need the P/Invoke shim (SendKeys calls).
 * Skipping Add-Type saves the ~1-2 s C# compilation on every keystroke call.
 * @returns {string}
 */
export function buildConsolePrelude() {
  return ["$ErrorActionPreference = 'Stop'", '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8'].join('\n');
}

/**
 * Build the PowerShell prelude shared by every desktop script:
 * UTF-8 output (so JSON and window titles survive), fail-fast errors and the
 * Add-Type compilation of the interop shim.
 *
 * The here-string terminator must sit at the start of a line, which is why the
 * script is assembled line by line instead of being template-concatenated.
 *
 * @returns {string}
 */
export function buildInteropPrelude() {
  const lines = [
    buildConsolePrelude(),
    "Add-Type -Language CSharp -TypeDefinition @'",
    ...DESKTOP_INTEROP_CS.split('\n'),
    "'@",
  ];
  return lines.join('\n');
}

/**
 * Compose a full script: prelude + body + newline.
 * @param {string} body
 * @returns {string}
 */
export function wrapDesktopScript(body) {
  if (typeof body !== 'string' || body.trim() === '') {
    throw new DesktopError('INVALID_SCRIPT', 'desktop script body must be a non-empty string');
  }
  return `${buildInteropPrelude()}\n${body.trim()}\n`;
}

const METRICS_BODY = String.raw`
$vs = [DshDesktopInterop]::GetVirtualScreen()
$monitorList = [DshDesktopInterop]::EnumerateMonitors()
$monitors = @()
foreach ($m in $monitorList) {
  $monitors += @{
    device = $m.szDevice
    primary = (($m.dwFlags -band 1) -ne 0)
    bounds = @{
      x = $m.rcMonitor.Left
      y = $m.rcMonitor.Top
      width = ($m.rcMonitor.Right - $m.rcMonitor.Left)
      height = ($m.rcMonitor.Bottom - $m.rcMonitor.Top)
    }
    workArea = @{
      x = $m.rcWork.Left
      y = $m.rcWork.Top
      width = ($m.rcWork.Right - $m.rcWork.Left)
      height = ($m.rcWork.Bottom - $m.rcWork.Top)
    }
  }
}
@{
  ok = $true
  timestamp = (Get-Date).ToUniversalTime().ToString('o')
  metrics = @{
    virtualScreen = @{ x = $vs[0]; y = $vs[1]; width = $vs[2]; height = $vs[3] }
    primaryScreen = @{
      width = [DshDesktopInterop]::GetSystemMetrics(0)
      height = [DshDesktopInterop]::GetSystemMetrics(1)
    }
    monitorCount = $monitors.Count
  }
  monitors = $monitors
} | ConvertTo-Json -Compress -Depth 8
`;

const CURSOR_BODY = String.raw`
$p = [DshDesktopInterop]::GetCursorPoint()
if ($null -eq $p) { throw 'GetCursorPos failed' }
@{ ok = $true; cursor = @{ x = $p[0]; y = $p[1] }; timestamp = (Get-Date).ToUniversalTime().ToString('o') } |
  ConvertTo-Json -Compress -Depth 5
`;

const WINDOWS_BODY = String.raw`
$windows = @()
$visited = 0
foreach ($h in [DshDesktopInterop]::EnumerateWindows()) {
  if ($visited -ge 500) { break }
  $title = [DshDesktopInterop]::GetWindowTitle($h)
  if ($title.Length -eq 0) { continue }
  $b = [DshDesktopInterop]::GetWindowBounds($h)
  $windows += @{
    hwnd = $h.ToInt64()
    title = $title
    className = [DshDesktopInterop]::GetWindowClass($h)
    pid = [int][DshDesktopInterop]::GetWindowPid($h)
    visible = [DshDesktopInterop]::IsWindowVisible($h)
    minimized = [DshDesktopInterop]::IsIconic($h)
    bounds = @{ x = $b[0]; y = $b[1]; width = $b[2]; height = $b[3] }
  }
  $visited += 1
}
$fg = [DshDesktopInterop]::GetForegroundWindow()
$active = $null
if ($fg -ne [IntPtr]::Zero) {
  $b = [DshDesktopInterop]::GetWindowBounds($fg)
  $active = @{
    hwnd = $fg.ToInt64()
    title = [DshDesktopInterop]::GetWindowTitle($fg)
    className = [DshDesktopInterop]::GetWindowClass($fg)
    pid = [int][DshDesktopInterop]::GetWindowPid($fg)
    bounds = @{ x = $b[0]; y = $b[1]; width = $b[2]; height = $b[3] }
  }
}
@{
  ok = $true
  timestamp = (Get-Date).ToUniversalTime().ToString('o')
  windows = $windows
  activeWindow = $active
} | ConvertTo-Json -Compress -Depth 8
`;

const OBSERVE_BODY = String.raw`
$vs = [DshDesktopInterop]::GetVirtualScreen()
$monitorList = [DshDesktopInterop]::EnumerateMonitors()
$monitors = @()
foreach ($m in $monitorList) {
  $monitors += @{
    device = $m.szDevice
    primary = (($m.dwFlags -band 1) -ne 0)
    bounds = @{
      x = $m.rcMonitor.Left
      y = $m.rcMonitor.Top
      width = ($m.rcMonitor.Right - $m.rcMonitor.Left)
      height = ($m.rcMonitor.Bottom - $m.rcMonitor.Top)
    }
    workArea = @{
      x = $m.rcWork.Left
      y = $m.rcWork.Top
      width = ($m.rcWork.Right - $m.rcWork.Left)
      height = ($m.rcWork.Bottom - $m.rcWork.Top)
    }
  }
}
$cursorPoint = [DshDesktopInterop]::GetCursorPoint()
if ($null -eq $cursorPoint) { throw 'GetCursorPos failed' }

$windows = @()
$visited = 0
foreach ($h in [DshDesktopInterop]::EnumerateWindows()) {
  if ($visited -ge 500) { break }
  $title = [DshDesktopInterop]::GetWindowTitle($h)
  if ($title.Length -eq 0) { continue }
  $b = [DshDesktopInterop]::GetWindowBounds($h)
  $windows += @{
    hwnd = $h.ToInt64()
    title = $title
    className = [DshDesktopInterop]::GetWindowClass($h)
    pid = [int][DshDesktopInterop]::GetWindowPid($h)
    visible = [DshDesktopInterop]::IsWindowVisible($h)
    minimized = [DshDesktopInterop]::IsIconic($h)
    bounds = @{ x = $b[0]; y = $b[1]; width = $b[2]; height = $b[3] }
  }
  $visited += 1
}

$fg = [DshDesktopInterop]::GetForegroundWindow()
$active = $null
if ($fg -ne [IntPtr]::Zero) {
  $b = [DshDesktopInterop]::GetWindowBounds($fg)
  $active = @{
    hwnd = $fg.ToInt64()
    title = [DshDesktopInterop]::GetWindowTitle($fg)
    className = [DshDesktopInterop]::GetWindowClass($fg)
    pid = [int][DshDesktopInterop]::GetWindowPid($fg)
    bounds = @{ x = $b[0]; y = $b[1]; width = $b[2]; height = $b[3] }
  }
}

@{
  ok = $true
  timestamp = (Get-Date).ToUniversalTime().ToString('o')
  host = $env:COMPUTERNAME
  metrics = @{
    virtualScreen = @{ x = $vs[0]; y = $vs[1]; width = $vs[2]; height = $vs[3] }
    primaryScreen = @{
      width = [DshDesktopInterop]::GetSystemMetrics(0)
      height = [DshDesktopInterop]::GetSystemMetrics(1)
    }
    monitorCount = $monitors.Count
  }
  cursor = @{ x = $cursorPoint[0]; y = $cursorPoint[1] }
  monitors = $monitors
  windows = $windows
  activeWindow = $active
} | ConvertTo-Json -Compress -Depth 8
`;

export const METRICS_SCRIPT = wrapDesktopScript(METRICS_BODY);
export const CURSOR_SCRIPT = wrapDesktopScript(CURSOR_BODY);
export const WINDOWS_SCRIPT = wrapDesktopScript(WINDOWS_BODY);
export const OBSERVE_SCRIPT = wrapDesktopScript(OBSERVE_BODY);

/** @param {unknown} value */
function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}

/** @param {unknown} value @param {string} [fallbackKey] */
function toNumber(value, fallback = 0) {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * @param {any} value
 * @param {string} label
 * @returns {{ x:number, y:number, width:number, height:number }}
 */
function normalizeRect(value, label) {
  if (!value || typeof value !== 'object') {
    throw new DesktopError('INVALID_OUTPUT', `missing ${label} rectangle`);
  }
  return {
    x: toNumber(value.x),
    y: toNumber(value.y),
    width: toNumber(value.width),
    height: toNumber(value.height),
  };
}

/**
 * @param {any} value
 * @returns {{ hwnd:string, title:string, className:string, pid:number, visible:boolean, minimized:boolean, bounds:{x:number,y:number,width:number,height:number} }}
 */
function normalizeWindow(value) {
  const w = value && typeof value === 'object' ? value : {};
  return {
    hwnd: String(w.hwnd ?? ''),
    title: String(w.title ?? ''),
    className: String(w.className ?? ''),
    pid: toNumber(w.pid),
    visible: w.visible === true,
    minimized: w.minimized === true,
    bounds: normalizeRect(w.bounds, 'window bounds'),
  };
}

/**
 * Normalise the raw JSON payload from OBSERVE_SCRIPT into a stable shape.
 * Exported so tests can pin the mapping without PowerShell.
 *
 * @param {any} payload
 * @param {{ maxWindows?: number }} [options]
 */
export function normalizeObservePayload(payload, options = {}) {
  if (!payload || typeof payload !== 'object') {
    throw new DesktopError('INVALID_OUTPUT', 'observation payload was not an object');
  }
  const maxWindows = options.maxWindows ?? 300;
  const metricsRaw = payload.metrics && typeof payload.metrics === 'object' ? payload.metrics : {};
  const cursorRaw = payload.cursor && typeof payload.cursor === 'object' ? payload.cursor : null;
  if (!cursorRaw) throw new DesktopError('INVALID_OUTPUT', 'observation payload had no cursor position');

  const cursor = { x: toNumber(cursorRaw.x), y: toNumber(cursorRaw.y) };
  const monitors = asArray(payload.monitors).map((m) => ({
    device: String(m?.device ?? ''),
    primary: m?.primary === true,
    bounds: normalizeRect(m?.bounds, 'monitor bounds'),
    workArea: normalizeRect(m?.workArea, 'monitor workArea'),
  }));
  const windows = asArray(payload.windows)
    .map(normalizeWindow)
    .filter((w) => w.title.length > 0)
    // Visible windows first: EnumWindows also reports hidden helper windows
    // (overlay hosts, IME windows), which are noise for an agent.
    .sort((a, b) => Number(b.visible) - Number(a.visible))
    .slice(0, maxWindows);
  const activeWindow = payload.activeWindow ? normalizeWindow(payload.activeWindow) : null;

  return {
    timestamp: typeof payload.timestamp === 'string' ? payload.timestamp : new Date().toISOString(),
    host: typeof payload.host === 'string' ? payload.host : null,
    metrics: {
      virtualScreen: normalizeRect(metricsRaw.virtualScreen, 'virtualScreen'),
      primaryScreen: normalizeRect(metricsRaw.primaryScreen, 'primaryScreen'),
      monitorCount: monitors.length,
    },
    cursor,
    monitors,
    windows,
    activeWindow,
  };
}

/**
 * Create the observation API.
 *
 * @param {{
 *   runner?: ReturnType<typeof createRunner>,
 *   platform?: NodeJS.Platform,
 *   maxWindows?: number,
 *   timeoutMs?: number,
 * }} [options]
 */
export function createObserver(options = {}) {
  const runner = options.runner ?? createRunner();
  const platform = options.platform ?? runner.platform ?? process.platform;
  const maxWindows = options.maxWindows ?? 300;
  const timeoutMs = options.timeoutMs ?? 30_000;

  function ensureWindows() {
    if (platform !== 'win32') {
      throw new DesktopError('UNSUPPORTED_PLATFORM', 'desktop observation requires Windows', { platform });
    }
  }

  async function call(script, optionsOverride = {}) {
    ensureWindows();
    const payload = await runner.runJson(script, { timeout: timeoutMs, ...optionsOverride });
    if (!payload || payload.ok !== true) {
      throw new DesktopError('INVALID_OUTPUT', 'observation script did not report ok', {
        payload: payload && typeof payload === 'object' ? Object.keys(payload) : null,
      });
    }
    return payload;
  }

  /** Full snapshot: cursor, virtual screen, monitors, window list, active window. */
  async function observe(observeOptions = {}) {
    try {
      const payload = await call(OBSERVE_SCRIPT, observeOptions);
      return { ok: true, ...normalizeObservePayload(payload, { maxWindows }) };
    } catch (error) {
      return toDesktopError(error).toJSON();
    }
  }

  /** Virtual screen (multi-monitor bounding box) plus monitor rectangles. */
  async function getMetrics(metricsOptions = {}) {
    try {
      const payload = await call(METRICS_SCRIPT, metricsOptions);
      const monitors = asArray(payload.monitors).map((m) => ({
        device: String(m?.device ?? ''),
        primary: m?.primary === true,
        bounds: normalizeRect(m?.bounds, 'monitor bounds'),
        workArea: normalizeRect(m?.workArea, 'monitor workArea'),
      }));
      return {
        ok: true,
        metrics: {
          virtualScreen: normalizeRect(payload.metrics?.virtualScreen, 'virtualScreen'),
          primaryScreen: normalizeRect(payload.metrics?.primaryScreen, 'primaryScreen'),
          monitorCount: monitors.length,
        },
        monitors,
      };
    } catch (error) {
      return toDesktopError(error).toJSON();
    }
  }

  /** Current cursor position in virtual-screen pixels. */
  async function getCursor(cursorOptions = {}) {
    try {
      const payload = await call(CURSOR_SCRIPT, cursorOptions);
      const cursor = payload.cursor ?? {};
      return { ok: true, x: toNumber(cursor.x), y: toNumber(cursor.y) };
    } catch (error) {
      return toDesktopError(error).toJSON();
    }
  }

  /** Visible windows with non-empty titles, newest enumeration order. */
  async function listWindows(windowOptions = {}) {
    try {
      const payload = await call(WINDOWS_SCRIPT, windowOptions);
      return {
        ok: true,
        windows: asArray(payload.windows).map(normalizeWindow).filter((w) => w.title.length > 0).slice(0, maxWindows),
      };
    } catch (error) {
      return toDesktopError(error).toJSON();
    }
  }

  /** Foreground window, or null when the desktop itself has focus. */
  async function getActiveWindow(activeOptions = {}) {
    try {
      const payload = await call(WINDOWS_SCRIPT, activeOptions);
      return { ok: true, activeWindow: payload.activeWindow ? normalizeWindow(payload.activeWindow) : null };
    } catch (error) {
      return toDesktopError(error).toJSON();
    }
  }

  /** Virtual screen rectangle used by the input layer for clamping. */
  async function getBounds(boundsOptions = {}) {
    const metrics = await getMetrics(boundsOptions);
    if (!metrics.ok) return metrics;
    return { ok: true, bounds: metrics.metrics.virtualScreen, monitors: metrics.monitors };
  }

  return { observe, getMetrics, getCursor, listWindows, getActiveWindow, getBounds, platform };
}

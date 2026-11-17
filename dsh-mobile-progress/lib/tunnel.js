/**
 * Remote access helpers for dsh-mobile-progress.
 *
 * Three independent jobs, all kept out of `index.js` so they can be unit-tested
 * without a Harness host:
 *
 *  1. Resolve *where* the tunnel binary is (config → PATH → own bin dir →
 *     optional download from the vendor's GitHub release).
 *  2. Turn a process' noisy output into the one public URL the phone needs
 *     (`findPublicUrl`), and attach the access token (`withToken`).
 *  3. Keep the PC awake while the feed runs (`keepAwakeSpawn`), because a
 *     sleeping machine cannot answer the phone.
 *
 * Nothing here writes to the session log; all state stays in the storage dir.
 *
 * @module dsh-mobile-progress/lib/tunnel
 */

import { spawn, spawnSync } from 'node:child_process'
import { createWriteStream, promises as fsp, statSync } from 'node:fs'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'

/** Hosts that appear in `cloudflared` startup banners but are not the tunnel. */
const NOISE_HOSTS = Object.freeze([
  'github.com',
  'api.github.com',
  'cloudflare.com',
  'www.cloudflare.com',
  'dash.cloudflare.com',
  'developers.cloudflare.com',
  'community.cloudflare.com',
  'pkg.go.dev',
  'go.dev',
  'groups.google.com',
  'speed.cloudflare.com',
])

/** Hostname suffixes that are (nearly) certainly the public tunnel itself. */
const TUNNEL_SUFFIXES = Object.freeze([
  '.trycloudflare.com',
  '.ngrok-free.app',
  '.ngrok-free.dev',
  '.ngrok.app',
  '.ngrok.io',
  '.loca.lt',
  '.tunnel.dev',
  '.ts.net',
  '.serveo.net',
  '.pinggy.link',
])

export const DEFAULT_TUNNEL = Object.freeze({
  enabled: true,
  provider: 'cloudflared',
  mode: 'quick',
  token: '',
  command: '',
  binaryPath: '',
  autoDownload: true,
  publicHostname: '',
  requireToken: true,
  maxRestarts: 20,
})

export const DEFAULT_KEEP_AWAKE = Object.freeze({
  enabled: true,
  // Keep the system awake but let the display sleep: an overnight render box
  // should not burn the panel just to serve a progress bar.
  keepDisplayOn: false,
})

function asBool(value, fallback) {
  if (value === undefined || value === null) return fallback
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  const text = String(value).trim().toLowerCase()
  if (['', '0', 'false', 'no', 'off', 'none'].includes(text)) return false
  if (['1', 'true', 'yes', 'on'].includes(text)) return true
  return fallback
}

function asText(value, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback
}

/** Normalize the `tunnel` / `keepAwake` config blocks. */
export function resolveTunnelConfig(raw) {
  const input = raw && typeof raw === 'object' ? raw : {}
  // A bare boolean is accepted as shorthand: `tunnel: false`.
  if (typeof raw === 'boolean') {
    return { ...DEFAULT_TUNNEL, enabled: raw, keepAwake: { ...DEFAULT_KEEP_AWAKE } }
  }
  const mode = ['quick', 'named', 'custom'].includes(asText(input.mode)) ? asText(input.mode) : 'quick'
  const keepAwakeRaw = input.keepAwake
  const keepAwake =
    typeof keepAwakeRaw === 'boolean'
      ? { ...DEFAULT_KEEP_AWAKE, enabled: keepAwakeRaw }
      : {
          ...DEFAULT_KEEP_AWAKE,
          enabled: asBool(keepAwakeRaw?.enabled, DEFAULT_KEEP_AWAKE.enabled),
          keepDisplayOn: asBool(keepAwakeRaw?.keepDisplayOn, DEFAULT_KEEP_AWAKE.keepDisplayOn),
        }
  return {
    enabled: asBool(input.enabled, DEFAULT_TUNNEL.enabled),
    provider: asText(input.provider) || DEFAULT_TUNNEL.provider,
    mode,
    token: asText(input.token),
    command: asText(input.command),
    binaryPath: asText(input.binaryPath),
    autoDownload: asBool(input.autoDownload, DEFAULT_TUNNEL.autoDownload),
    publicHostname: asText(input.publicHostname),
    requireToken: asBool(input.requireToken, DEFAULT_TUNNEL.requireToken),
    maxRestarts: Number.isFinite(Number(input.maxRestarts))
      ? Math.max(0, Math.min(200, Math.trunc(Number(input.maxRestarts))))
      : DEFAULT_TUNNEL.maxRestarts,
    keepAwake,
  }
}

/** CLI arguments for the tunnel process, given the resolved config. */
export function tunnelArgs(config, { port, token = '' } = {}) {
  const local = `http://127.0.0.1:${port}`
  if (config.mode === 'named') {
    return ['tunnel', '--no-autoupdate', 'run', '--token', config.token]
  }
  if (config.mode === 'custom') {
    const command = config.command || ''
    if (command.length === 0) return null
    return tokenizeCommand(command.replaceAll('{port}', String(port)).replaceAll('{url}', local))
  }
  return ['tunnel', '--no-autoupdate', '--protocol', 'http2', '--url', local]
}

/** Split a command line into an argv array, honoring single and double quotes. */
export function tokenizeCommand(command) {
  const parts = []
  let current = ''
  let quote = null
  let started = false
  for (const char of String(command ?? '')) {
    if (quote !== null) {
      if (char === quote) quote = null
      else current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      started = true
      continue
    }
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
      if (started || current.length > 0) {
        parts.push(current)
        current = ''
        started = false
      }
      continue
    }
    current += char
    started = true
  }
  if (started || current.length > 0) parts.push(current)
  return parts
}

/**
 * Find the public URL a tunnel printed. `null` until the provider says it is
 * ready — the phone page must not advertise a URL that does not answer yet.
 */
export function findPublicUrl(text) {
  const haystack = String(text ?? '')
  if (haystack.length === 0) return null
  const urls = haystack.match(/https:\/\/[^\s"'<>]+/gi) ?? []
  const cleaned = urls.map((value) => value.replace(/[).,;:]+$/, ''))
  for (const suffix of TUNNEL_SUFFIXES) {
    for (const value of cleaned) {
      try {
        if (new URL(value).hostname.endsWith(suffix)) return value
      } catch {
        // Not a URL; keep looking.
      }
    }
  }
  for (const value of cleaned) {
    try {
      const { hostname, pathname } = new URL(value)
      if (NOISE_HOSTS.some((noise) => hostname === noise || hostname.endsWith(`.${noise}`))) continue
      if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0') continue
      if (pathname.startsWith('/docs') || pathname.startsWith('/resources')) continue
      return value
    } catch {
      // Not a URL.
    }
  }
  return null
}

/** Attach `?k=<token>` to a URL, preserving an existing query and hash. */
export function withToken(url, accessToken) {
  const raw = String(url ?? '/')
  if (!accessToken) return raw
  const hashAt = raw.indexOf('#')
  const hash = hashAt >= 0 ? raw.slice(hashAt) : ''
  const base = hashAt >= 0 ? raw.slice(0, hashAt) : raw
  const pathPart = base.length > 0 ? base : '/'
  const separator = pathPart.includes('?') ? '&' : '?'
  return `${pathPart}${separator}k=${encodeURIComponent(accessToken)}${hash}`
}

/** Executable name per platform. */
export function binaryName(platform = process.platform) {
  return platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'
}

/** The release asset for this platform, or `null` when there is no direct binary. */
export function releaseAsset(platform = process.platform, arch = process.arch) {
  if (platform === 'win32') {
    if (arch === 'x64') return 'cloudflared-windows-amd64.exe'
    if (arch === 'arm64') return 'cloudflared-windows-arm64.exe'
    return null
  }
  if (platform === 'linux') {
    if (arch === 'x64') return 'cloudflared-linux-amd64'
    if (arch === 'arm64') return 'cloudflared-linux-arm64'
    return null
  }
  // macOS ships the binary inside a .tgz; extracting it is not worth the risk
  // here, so the user installs it with `brew install cloudflared`.
  return null
}

export function releaseUrl(asset) {
  if (!asset) return null
  return `https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}`
}

/** Scan PATH for an executable, without spawning a shell. */
export function findOnPath(names, { env = process.env, platform = process.platform } = {}) {
  const separator = platform === 'win32' ? ';' : ':'
  const directories = String(env.PATH ?? env.Path ?? '')
    .split(separator)
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
  const list = Array.isArray(names) ? names : [names]
  for (const directory of directories) {
    for (const name of list) {
      const candidate = path.join(directory, name)
      try {
        if (isFileSync(candidate)) return candidate
      } catch {
        // Unreadable PATH entries are skipped.
      }
    }
  }
  return null
}

function isFileSync(file) {
  try {
    return statSync(file).isFile()
  } catch {
    return false
  }
}

/**
 * Decide which cloudflared to run.
 *
 * Order: explicit config → PATH → the plugin's own bin directory. The result
 * is `{ path, source }` or `null`; downloading is a separate, explicit step so
 * that a failed download never breaks the LAN page.
 */
export async function locateCloudflared({ binaryPath, storeDir, platform = process.platform, env = process.env } = {}) {
  if (binaryPath) {
    if (await fileExists(binaryPath)) return { path: binaryPath, source: 'config' }
  }
  const name = binaryName(platform)
  const onPath = findOnPath([name], { env, platform })
  if (onPath !== null) return { path: onPath, source: 'path' }
  const local = path.join(storeDir, 'bin', name)
  if (await fileExists(local)) return { path: local, source: 'store' }
  return null
}

async function fileExists(file) {
  try {
    const stat = await fsp.stat(file)
    return stat.isFile()
  } catch {
    return false
  }
}

/** Download `url` to `dest` (follows redirects, never overwrites best-effort). */
export function downloadFile(url, dest, { redirects = 6, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      { headers: { 'user-agent': 'dsh-mobile-progress' } },
      (response) => {
        const status = response.statusCode ?? 0
        if (status >= 300 && status < 400 && response.headers.location) {
          response.resume()
          if (redirects <= 0) {
            reject(new Error('too many redirects'))
            return
          }
          const next = new URL(response.headers.location, url).toString()
          downloadFile(next, dest, { redirects: redirects - 1, onProgress }).then(resolve, reject)
          return
        }
        if (status !== 200) {
          response.resume()
          reject(new Error(`HTTP ${status} for ${url}`))
          return
        }
        const total = Number(response.headers['content-length'] ?? 0)
        let received = 0
        const stream = createWriteStream(dest)
        response.on('data', (chunk) => {
          received += chunk.length
          if (typeof onProgress === 'function' && total > 0) {
            onProgress(received, total)
          }
        })
        response.on('error', (error) => {
          stream.destroy()
          reject(error)
        })
        stream.on('error', (error) => reject(error))
        stream.on('finish', () => resolve({ bytes: received }))
        response.pipe(stream)
      },
    )
    request.on('error', reject)
    request.setTimeout(120_000, () => {
      request.destroy(new Error('download timed out'))
    })
  })
}

/** Download cloudflared into `<storeDir>/bin/` when it is missing. */
export async function installCloudflared({ storeDir, platform = process.platform, arch = process.arch, log } = {}) {
  const asset = releaseAsset(platform, arch)
  if (asset === null) {
    return { ok: false, error: `no prebuilt cloudflared asset for ${platform}/${arch}; install it manually` }
  }
  const url = releaseUrl(asset)
  const directory = path.join(storeDir, 'bin')
  const target = path.join(directory, binaryName(platform))
  await fsp.mkdir(directory, { recursive: true })
  const partial = `${target}.download`
  const started = Date.now()
  try {
    const { bytes } = await downloadFile(url, partial)
    await fsp.rename(partial, target)
    if (platform !== 'win32') await fsp.chmod(target, 0o755)
    const version = await binaryVersion(target)
    log?.(`downloaded cloudflared ${version || ''} (${Math.round(bytes / 1_048_576)} MB) in ${Math.round((Date.now() - started) / 1000)}s`)
    return { ok: true, path: target, version, bytes }
  } catch (error) {
    try {
      await fsp.rm(partial, { force: true })
    } catch {
      // Nothing to clean up.
    }
    return { ok: false, error: String(error?.message ?? error) }
  }
}

/** `cloudflared --version`, or '' when the binary cannot run. */
export function binaryVersion(binary) {
  try {
    const result = spawnSync(binary, ['--version'], { timeout: 15_000, encoding: 'utf8', windowsHide: true })
    if (result.error) return ''
    const text = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
    return text.split(/\r?\n/).find((line) => line.trim().length > 0) ?? ''
  } catch {
    return ''
  }
}

/**
 * Build the keep-awake process spec for this platform.
 *
 * Windows uses `SetThreadExecutionState` with ES_CONTINUOUS | ES_SYSTEM_REQUIRED
 * (0x80000001) so the machine may blank the screen but never suspends while
 * the plugin runs. macOS uses `caffeinate`, Linux `systemd-inhibit`.
 *
 * On Windows the flag script is written to a `.ps1` file and started with
 * `-File`: passing it inline through `-Command` is fragile because the C#
 * signature contains double quotes, which a shell-style re-parse can break.
 */
export function keepAwakeSpawn({ platform = process.platform, keepDisplayOn = false, scriptPath = '' } = {}) {
  if (platform === 'win32') {
    const flags = keepDisplayOn ? '0x80000003' : '0x80000001'
    if (scriptPath.length > 0) {
      return {
        command: 'powershell.exe',
        args: [
          '-NoProfile',
          '-NonInteractive',
          '-WindowStyle',
          'Hidden',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          scriptPath,
          '-Flags',
          flags,
        ],
      }
    }
    const script = [
      "$ErrorActionPreference = 'Stop'",
      "Add-Type -Namespace DshAwake -Name Native -MemberDefinition '[DllImport(\"kernel32.dll\", SetLastError = true)] public static extern uint SetThreadExecutionState(uint esFlags);'",
      `[void][DshAwake.Native]::SetThreadExecutionState(${flags})`,
      `while ($true) { Start-Sleep -Seconds 30; [void][DshAwake.Native]::SetThreadExecutionState(${flags}) }`,
    ].join('; ')
    return {
      command: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-Command', script],
    }
  }
  if (platform === 'darwin') {
    return { command: 'caffeinate', args: keepDisplayOn ? ['-d', '-i', '-s'] : ['-i', '-s'] }
  }
  if (platform === 'linux') {
    return {
      command: 'systemd-inhibit',
      args: [`--what=${keepDisplayOn ? 'idle:sleep' : 'idle'}`, '--why=DSH mobile progress', '--mode=block', 'sleep', 'infinity'],
    }
  }
  return null
}

/** The Windows helper script, written next to the tunnel binary. */
export function keepAwakeScript() {
  return [
    'param([string]$Flags = "0x80000001")',
    '$ErrorActionPreference = "Stop"',
    'Add-Type -Namespace DshAwake -Name Native -MemberDefinition @"',
    '[DllImport("kernel32.dll", SetLastError = true)]',
    'public static extern uint SetThreadExecutionState(uint esFlags);',
    '"@',
    '$value = [Convert]::ToUInt32($Flags, 16)',
    '[void][DshAwake.Native]::SetThreadExecutionState($value)',
    'while ($true) {',
    '  Start-Sleep -Seconds 30',
    '  [void][DshAwake.Native]::SetThreadExecutionState($value)',
    '}',
    '',
  ].join('\n')
}

/** Spawn a detached-free child we can reliably kill later. */
export function spawnTracked(command, args, { env, onLine, onExit, stdio = 'pipe', windowsHide = true } = {}) {
  const child = spawn(command, args, {
    env: env ?? process.env,
    windowsHide,
    stdio: Array.isArray(stdio) ? stdio : [stdio, stdio, stdio],
    detached: false,
  })
  let buffer = ''
  const consume = (chunk) => {
    buffer += chunk.toString('utf8')
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (line.trim().length > 0) onLine?.(line)
    }
  }
  if (typeof stdio === 'string' ? stdio === 'pipe' : stdio[1] === 'pipe') child.stdout?.on('data', consume)
  if (typeof stdio === 'string' ? stdio === 'pipe' : stdio[2] === 'pipe') child.stderr?.on('data', consume)
  child.on('error', (error) => onExit?.({ code: null, signal: null, error }))
  child.on('exit', (code, signal) => onExit?.({ code, signal, error: null }))
  return child
}

/** Kill a child and its descendants (Windows needs taskkill for the tree). */
export function killTree(child, { platform = process.platform } = {}) {
  if (!child || child.killed || child.exitCode !== null) return
  try {
    if (platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 10_000 })
    } else {
      child.kill('SIGTERM')
    }
  } catch {
    try {
      child.kill()
    } catch {
      // Already gone.
    }
  }
}

/** Short, stable description of a binary path for logs (no home directory). */
export function describePath(file) {
  if (!file) return ''
  const home = os.homedir()
  const value = String(file)
  return value.startsWith(home) ? `~${value.slice(home.length)}` : value
}

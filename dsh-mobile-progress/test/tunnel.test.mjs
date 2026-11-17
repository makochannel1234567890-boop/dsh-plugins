import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  DEFAULT_TUNNEL,
  binaryName,
  findOnPath,
  findPublicUrl,
  installCloudflared,
  keepAwakeScript,
  keepAwakeSpawn,
  locateCloudflared,
  releaseAsset,
  releaseUrl,
  resolveTunnelConfig,
  tokenizeCommand,
  tunnelArgs,
  withToken,
} from '../lib/tunnel.js'

test('resolveTunnelConfig fills defaults and accepts the boolean shorthand', () => {
  const defaults = resolveTunnelConfig(undefined)
  assert.equal(defaults.enabled, DEFAULT_TUNNEL.enabled)
  assert.equal(defaults.mode, 'quick')
  assert.equal(defaults.requireToken, true)
  assert.equal(defaults.keepAwake.enabled, true)

  const off = resolveTunnelConfig(false)
  assert.equal(off.enabled, false)
  assert.equal(off.mode, 'quick')

  const named = resolveTunnelConfig({
    mode: 'named',
    token: '  secret-token  ',
    autoDownload: false,
    keepAwake: false,
  })
  assert.equal(named.mode, 'named')
  assert.equal(named.token, 'secret-token')
  assert.equal(named.autoDownload, false)
  assert.equal(named.keepAwake.enabled, false)

  const custom = resolveTunnelConfig({ mode: 'custom', command: 'ngrok http {port}' })
  assert.equal(custom.mode, 'custom')
  assert.equal(custom.command, 'ngrok http {port}')
})

test('tunnelArgs builds provider arguments for each mode', () => {
  const quick = tunnelArgs(resolveTunnelConfig({}), { port: 8790 })
  assert.deepEqual(quick, [
    'tunnel',
    '--no-autoupdate',
    '--protocol',
    'http2',
    '--url',
    'http://127.0.0.1:8790',
  ])

  const named = tunnelArgs(resolveTunnelConfig({ mode: 'named', token: 'abc' }), { port: 8790 })
  assert.deepEqual(named, ['tunnel', '--no-autoupdate', 'run', '--token', 'abc'])

  const custom = tunnelArgs(
    resolveTunnelConfig({ mode: 'custom', command: 'ngrok http {port} --scheme https' }),
    { port: 9001 },
  )
  assert.deepEqual(custom, ['ngrok', 'http', '9001', '--scheme', 'https'])
})

test('tokenizeCommand keeps quoted groups together', () => {
  assert.deepEqual(tokenizeCommand('a b c'), ['a', 'b', 'c'])
  assert.deepEqual(tokenizeCommand('"C:\\Program Files\\x.exe" --flag'), [
    'C:\\Program Files\\x.exe',
    '--flag',
  ])
  assert.deepEqual(tokenizeCommand("one 'two three' four"), ['one', 'two three', 'four'])
  assert.deepEqual(tokenizeCommand('   '), [])
  assert.deepEqual(tokenizeCommand(''), [])
})

test('findPublicUrl picks the tunnel URL and ignores vendor links', () => {
  assert.equal(
    findPublicUrl('INF Your quick Tunnel has been created! Visit it at https://brave-lion-tiger.trycloudflare.com'),
    'https://brave-lion-tiger.trycloudflare.com',
  )
  assert.equal(
    findPublicUrl('|  https://plain-words-here.trycloudflare.com  |'),
    'https://plain-words-here.trycloudflare.com',
  )
  assert.equal(
    findPublicUrl('Forwarding https://abcd-1234.ngrok-free.app -> http://127.0.0.1:8790'),
    'https://abcd-1234.ngrok-free.app',
  )
  // cloudflared prints documentation and update URLs that are not the tunnel.
  assert.equal(
    findPublicUrl(
      'See https://developers.cloudflare.com/cloudflare-one/ for help. Update: https://github.com/cloudflare/cloudflared/releases',
    ),
    null,
  )
  assert.equal(findPublicUrl('no url here'), null)
  assert.equal(findPublicUrl(undefined), null)
})

test('withToken preserves the query and the hash', () => {
  assert.equal(withToken('/', ''), '/')
  assert.equal(withToken('/', 'abc'), '/?k=abc')
  assert.equal(withToken('/#logsCard', 'abc'), '/?k=abc#logsCard')
  assert.equal(withToken('/api/state?x=1', 'a b'), '/api/state?x=1&k=a%20b')
  assert.equal(withToken('https://x.trycloudflare.com/', 'tok'), 'https://x.trycloudflare.com/?k=tok')
})

test('releaseAsset and binaryName follow the platform', () => {
  assert.equal(binaryName('win32'), 'cloudflared.exe')
  assert.equal(binaryName('linux'), 'cloudflared')
  assert.equal(releaseAsset('win32', 'x64'), 'cloudflared-windows-amd64.exe')
  assert.equal(releaseAsset('win32', 'arm64'), 'cloudflared-windows-arm64.exe')
  assert.equal(releaseAsset('linux', 'x64'), 'cloudflared-linux-amd64')
  assert.equal(releaseAsset('darwin', 'arm64'), null)
  assert.equal(
    releaseUrl('cloudflared-windows-amd64.exe'),
    'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe',
  )
  assert.equal(releaseUrl(null), null)
})

test('findOnPath scans PATH entries without a shell', async () => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-mp-path-'))
  const name = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'
  const file = path.join(directory, name)
  await fsp.writeFile(file, 'stub')
  assert.equal(findOnPath([name], { env: { PATH: directory }, platform: process.platform }), file)
  assert.equal(findOnPath([name], { env: { PATH: path.join(directory, 'nope') }, platform: process.platform }), null)
  await fsp.rm(directory, { recursive: true, force: true })
})

test('locateCloudflared prefers config, then PATH, then the store bin dir', async () => {
  const storeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-mp-store-'))
  const name = binaryName(process.platform)
  const emptyEnv = { PATH: path.join(storeDir, 'nothing') }

  assert.equal(await locateCloudflared({ storeDir, env: emptyEnv }), null)

  const binDir = path.join(storeDir, 'bin')
  await fsp.mkdir(binDir, { recursive: true })
  const stored = path.join(binDir, name)
  await fsp.writeFile(stored, 'stub')
  const fromStore = await locateCloudflared({ storeDir, env: emptyEnv })
  assert.equal(fromStore?.path, stored)
  assert.equal(fromStore?.source, 'store')

  const configured = path.join(storeDir, 'custom-cloudflared')
  await fsp.writeFile(configured, 'stub')
  const fromConfig = await locateCloudflared({ binaryPath: configured, storeDir, env: emptyEnv })
  assert.equal(fromConfig?.path, configured)
  assert.equal(fromConfig?.source, 'config')

  await fsp.rm(storeDir, { recursive: true, force: true })
})

test('keepAwakeSpawn emits a platform helper that never sleeps the machine', () => {
  const win = keepAwakeSpawn({ platform: 'win32' })
  assert.equal(win?.command, 'powershell.exe')
  assert.match(win.args.join(' '), /SetThreadExecutionState\(0x80000001\)/)
  assert.ok(win.args.some((value) => value.includes('while ($true)')))

  const winDisplay = keepAwakeSpawn({ platform: 'win32', keepDisplayOn: true })
  assert.match(winDisplay.args.join(' '), /SetThreadExecutionState\(0x80000003\)/)

  // Preferred form: the script is a file, so the C# quotes never pass through a shell.
  const fromFile = keepAwakeSpawn({ platform: 'win32', scriptPath: 'C:\\store\\keep-awake.ps1' })
  assert.deepEqual(fromFile.args, [
    '-NoProfile',
    '-NonInteractive',
    '-WindowStyle',
    'Hidden',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    'C:\\store\\keep-awake.ps1',
    '-Flags',
    '0x80000001',
  ])
  assert.equal(
    keepAwakeSpawn({ platform: 'win32', scriptPath: 'x', keepDisplayOn: true }).args.at(-1),
    '0x80000003',
  )

  assert.deepEqual(keepAwakeSpawn({ platform: 'darwin' }), { command: 'caffeinate', args: ['-i', '-s'] })
  assert.equal(keepAwakeSpawn({ platform: 'linux' })?.command, 'systemd-inhibit')
  assert.equal(keepAwakeSpawn({ platform: 'aix' }), null)
})

test('keepAwakeScript is a valid PowerShell stub with the Win32 signature', () => {
  const script = keepAwakeScript()
  assert.match(script, /^param\(\[string\]\$Flags = "0x80000001"\)/)
  assert.match(script, /DllImport\("kernel32\.dll"/)
  assert.match(script, /SetThreadExecutionState\(\$value\)/)
  assert.match(script, /while \(\$true\)/)
  // Balanced here-string delimiters keep Add-Type parseable.
  assert.equal(script.split('"@').length - 1, 1)
  assert.equal(script.split('@"').length - 1, 1)
})

test('installCloudflared refuses platforms without a direct binary', async () => {
  const result = await installCloudflared({ storeDir: os.tmpdir(), platform: 'darwin', arch: 'arm64' })
  assert.equal(result.ok, false)
  assert.match(result.error, /manually/)
})

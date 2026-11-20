/**
 * Integration tests for dsh-social-desktop-agent.
 *
 * These tests load index.js against a fake host and check the wiring that the
 * unit tests cannot: which tools are registered, that the default settings are
 * least privilege, and that the dangerous paths are refused before anything
 * reaches the real machine.
 *
 * Offline only: the browser layer gets a stub driver, the desktop layer gets a
 * runner that throws if an executable is ever about to run, and the audit log
 * stays in memory (auditPath: null).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  apply,
  createRuntime,
  DEFAULT_CONFIG,
  DEFAULT_SCOPES,
  TOOL_NAMES,
  BROWSER_TOOL_NAMES,
  DESKTOP_TOOL_NAMES,
  DESKTOP_SENTINEL_HOST,
  resolveConfig,
  loadModules,
  createEnvConfirmGate,
  desktopPolicyTarget,
} from '../../index.js'

const STUB_PAGES = [
  {
    url: 'https://www.instagram.com/',
    title: 'Instagram',
    text: 'integration page',
    nodes: [{ ref: 'e1', role: 'link', name: 'Home', url: 'https://www.instagram.com/' }],
  },
]

/** Load a module if the other layer has landed; null when it is still missing. */
async function tryImport(relative) {
  try {
    return await import(relative)
  } catch {
    return null
  }
}

const browserTools = await tryImport('../../lib/browser/tools.js')
const stubDriverModule = await tryImport('../../lib/browser/stub-driver.js')
const desktopTools = await tryImport('../../lib/desktop/tools.js')
const desktopPower = await tryImport('../../lib/desktop/power.js')

const ALL_LAYERS = Boolean(browserTools && stubDriverModule && desktopTools && desktopPower)

function createHost() {
  const defs = new Map()
  return {
    defs,
    ctx: {
      tools: {
        register(def) {
          defs.set(def.name, def)
          return () => defs.delete(def.name)
        },
      },
      get() {
        return undefined
      },
      effect() {},
      logger: { warn() {} },
    },
  }
}

function createFakeRunner() {
  const calls = []
  return {
    calls,
    platform: 'win32',
    async runPowerShell() {
      calls.push('runPowerShell')
      return { stdout: '{}', stderr: '' }
    },
    async runJson() {
      calls.push('runJson')
      return {
        ok: true,
        cursor: { x: 0, y: 0 },
        metrics: { monitorCount: 1 },
        monitorRects: [],
        windows: [],
        foreground: null,
      }
    },
    async runProgram() {
      calls.push('runProgram')
      throw new Error('integration test: real execution is forbidden')
    },
    async launchApp() {
      calls.push('launchApp')
      throw new Error('integration test: real execution is forbidden')
    },
  }
}

function createDriver() {
  if (stubDriverModule?.createStubDriver) {
    return stubDriverModule.createStubDriver({ pages: STUB_PAGES.map((page) => ({ ...page })) })
  }
  return null
}

async function setup(overrides = {}, options = {}) {
  const host = createHost()
  const driver = options.driver ?? createDriver()
  const runtime = createRuntime({
    ctx: host.ctx,
    config: { ...DEFAULT_CONFIG, auditPath: null, ...overrides },
    ...(driver ? { deps: { browserDriver: driver, desktopRunner: options.runner ?? createFakeRunner() } } : {}),
    ...options.runtime,
  })
  await runtime.register()
  return { host, runtime }
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

test('exports the plugin contract and least-privilege defaults', () => {
  assert.equal(typeof apply, 'function')
  assert.equal(typeof createRuntime, 'function')
  assert.equal(typeof resolveConfig, 'function')
  assert.equal(typeof loadModules, 'function')
  assert.equal(DEFAULT_CONFIG.enabled, true)
  assert.deepEqual([...DEFAULT_SCOPES], ['browse.read'])
  assert.deepEqual([...DEFAULT_CONFIG.scopes], ['browse.read'])
  assert.equal(DEFAULT_CONFIG.powerEnabled, false)
  assert.equal(DEFAULT_CONFIG.browserDriver, 'stub')
  assert.equal(TOOL_NAMES.length, 15)
  assert.deepEqual(
    [...BROWSER_TOOL_NAMES, ...DESKTOP_TOOL_NAMES],
    [...TOOL_NAMES],
  )
  assert.deepEqual([...BROWSER_TOOL_NAMES], [
    'browse_open',
    'browse_snapshot',
    'browse_click',
    'browse_type',
    'browse_scroll',
    'browse_screenshot',
    'browse_close',
  ])
  assert.deepEqual([...DESKTOP_TOOL_NAMES], [
    'desktop_observe',
    'desktop_focus',
    'desktop_move',
    'desktop_click',
    'desktop_type',
    'desktop_key',
    'app_launch',
    'power_action',
  ])
})

test('resolveConfig keeps unknown scopes out and treats an explicit [] as "nothing"', () => {
  const defaults = resolveConfig({})
  assert.deepEqual(defaults.scopes, ['browse.read'])
  assert.equal(defaults.powerEnabled, false)
  assert.equal(defaults.killSwitchFile !== null, true)
  assert.deepEqual(resolveConfig({ scopes: [] }).scopes, [])
  assert.deepEqual(resolveConfig({ scopes: ['os.power', 'bogus', 'browse.interact'] }).scopes, [
    'browse.interact',
    'os.power',
  ])
  assert.equal(resolveConfig({ powerEnabled: 'yes' }).powerEnabled, false)
  assert.equal(resolveConfig({ browserDriver: 'cdp' }).browserDriver, 'cdp')
  assert.equal(resolveConfig({ auditPath: null }).auditPath, null)
})

test('environment confirm gate accepts a token once', () => {
  const gate = createEnvConfirmGate({ env: { DSH_POWER_CONFIRM_TOKEN: 'secret-token' } })
  assert.equal(gate.peek('secret-token'), true)
  assert.equal(gate.peek('wrong'), false)
  assert.equal(gate.consume('wrong'), false)
  assert.equal(gate.consume('secret-token'), true)
  assert.equal(gate.peek('secret-token'), false)
  assert.equal(gate.consume('secret-token'), false)
  assert.throws(() => gate.request({}))
})

test('desktop policy target uses the non-resolvable sentinel host', () => {
  const target = desktopPolicyTarget('desktop_observe')
  assert.match(target, new RegExp(`^https://${DESKTOP_SENTINEL_HOST.replace('.', '\\.')}/`))
  assert.match(target, /desktop_observe/)
})

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

test('registers all 15 tools into a fake host when every layer is present', async (t) => {
  if (!ALL_LAYERS) return t.skip('a layer is not implemented yet')
  const { host, runtime } = await setup()
  assert.deepEqual([...host.defs.keys()], [...TOOL_NAMES])
  assert.deepEqual(runtime.diagnostics.registered, [...TOOL_NAMES])
  assert.equal(runtime.diagnostics.categories.core, 'ready')
  assert.equal(runtime.diagnostics.categories.browser, 'ready')
  assert.equal(runtime.diagnostics.categories.desktop, 'ready')
  assert.deepEqual(runtime.diagnostics.skipped, [])

  // Unload must unregister through the disposers the host returned.
  runtime.dispose()
  assert.equal(host.defs.size, 0)
})

test('missing lib/core fails closed: zero tools, no throw', async () => {
  const host = createHost()
  const runtime = createRuntime({
    ctx: host.ctx,
    config: { ...DEFAULT_CONFIG, auditPath: null },
    modules: { core: null },
  })
  await runtime.register()
  assert.equal(host.defs.size, 0)
  assert.ok(runtime.diagnostics.warnings.some((line) => /lib\/core unavailable/i.test(line)))
  assert.equal(runtime.diagnostics.skipped.length, TOOL_NAMES.length)
})

test('a missing browser layer leaves the desktop tools registered', async (t) => {
  if (!desktopTools || !desktopPower) return t.skip('desktop layer is not implemented yet')
  const host = createHost()
  const runtime = createRuntime({
    ctx: host.ctx,
    config: { ...DEFAULT_CONFIG, auditPath: null },
    modules: { browser: null },
    deps: { desktopRunner: createFakeRunner() },
  })
  await runtime.register()
  assert.deepEqual([...host.defs.keys()], [...DESKTOP_TOOL_NAMES])
  assert.equal(runtime.diagnostics.categories.browser, 'missing')
  assert.ok(runtime.diagnostics.warnings.some((line) => /browser layer unavailable/i.test(line)))
})

// ---------------------------------------------------------------------------
// Default denials
// ---------------------------------------------------------------------------

test('default settings allow browse.read but refuse browse.interact and os.power', async (t) => {
  if (!browserTools || !stubDriverModule) return t.skip('browser layer is not implemented yet')
  const { host } = await setup()

  const opened = await host.defs.get('browse_open').execute({ url: 'https://www.instagram.com/' })
  assert.equal(opened.ok, true)

  const click = await host.defs.get('browse_click').execute({ ref: 'e1' })
  assert.equal(click.ok, false)
  assert.equal(click.code, 'SCOPE_DENIED')

  const power = await host.defs.get('power_action').execute({ action: 'reboot' })
  assert.equal(power.ok, false)
  assert.equal(power.code, 'SCOPE_DENIED')
})

test('default desktop input is refused through the shared policy', async (t) => {
  if (!desktopTools || !desktopPower) return t.skip('desktop layer is not implemented yet')
  const { host } = await setup()
  const moved = await host.defs.get('desktop_move').execute({ x: 10, y: 10 })
  assert.equal(moved.ok, false)
  assert.equal(moved.code, 'SCOPE_DENIED')
})

test('a non-allowlisted host is refused before the driver is touched', async (t) => {
  if (!browserTools || !stubDriverModule) return t.skip('browser layer is not implemented yet')
  const { host } = await setup()
  const result = await host.defs.get('browse_open').execute({ url: 'https://example.com/' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'TARGET_DENIED')
})

test('social.write is refused even when browse.interact is granted', async (t) => {
  if (!browserTools || !stubDriverModule) return t.skip('browser layer is not implemented yet')
  const { host } = await setup({ scopes: ['browse.read', 'browse.interact'] })
  await host.defs.get('browse_open').execute({ url: 'https://www.instagram.com/' })
  const result = await host.defs.get('browse_click').execute({ ref: 'e1', purpose: 'social.write' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'TARGET_DENIED')
  assert.equal(result.permanent, true)
})

// ---------------------------------------------------------------------------
// Kill switch / audit
// ---------------------------------------------------------------------------

test('the kill switch refuses actions without touching the driver', async (t) => {
  if (!browserTools || !stubDriverModule) return t.skip('browser layer is not implemented yet')
  const { host } = await setup()
  const previous = process.env.DSH_KILL_SWITCH
  process.env.DSH_KILL_SWITCH = '1'
  try {
    const result = await host.defs.get('browse_open').execute({ url: 'https://www.instagram.com/' })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'KILL_SWITCH')
  } finally {
    if (previous === undefined) delete process.env.DSH_KILL_SWITCH
    else process.env.DSH_KILL_SWITCH = previous
  }
})

test('audit entries use the fixed JSONL shape and never contain typed text', async (t) => {
  if (!ALL_LAYERS) return t.skip('a layer is not implemented yet')
  const runner = createFakeRunner()
  const { host, runtime } = await setup({ scopes: ['browse.read', 'browse.interact'] }, { runner })

  await host.defs.get('browse_open').execute({ url: 'https://www.instagram.com/' })
  await host.defs.get('desktop_type').execute({ text: 'INTEGRATION-SECRET-TEXT' })

  const entries = runtime.audit.readAll()
  assert.ok(entries.length > 0)
  const required = ['ts', 'scope', 'kind', 'target', 'result', 'reason']
  for (const entry of entries) {
    for (const key of required) assert.ok(key in entry, `audit entry is missing ${key}`)
    assert.ok(entry.result === 'allow' || entry.result === 'deny')
  }
  assert.equal(JSON.stringify(entries).includes('INTEGRATION-SECRET-TEXT'), false)
  assert.equal(runner.calls.includes('runProgram'), false)
})

// ---------------------------------------------------------------------------
// Power gates
// ---------------------------------------------------------------------------

test('power_action is a dry run when powerEnabled is false (nothing executes)', async (t) => {
  if (!desktopTools || !desktopPower) return t.skip('desktop layer is not implemented yet')
  const runner = createFakeRunner()
  const previous = process.env.DSH_POWER_CONFIRM_TOKEN
  process.env.DSH_POWER_CONFIRM_TOKEN = 'integration-power-token'
  try {
    const { host } = await setup(
      { scopes: ['browse.read', 'browse.interact', 'app.launch', 'os.power'], powerEnabled: false },
      { runner },
    )
    const result = await host.defs.get('power_action').execute({
      action: 'reboot',
      delaySec: 30,
      confirmToken: 'integration-power-token',
    })
    assert.equal(result.ok, true)
    assert.equal(result.executed, false)
    assert.equal(result.dryRun, true)
    assert.deepEqual(result.missing, ['config:powerEnabled'])
    assert.equal(result.wouldRun, 'shutdown /r /t 30')
    assert.equal(runner.calls.includes('runProgram'), false)
  } finally {
    if (previous === undefined) delete process.env.DSH_POWER_CONFIRM_TOKEN
    else process.env.DSH_POWER_CONFIRM_TOKEN = previous
  }
})

test('power_action still dry-runs without DSH_ALLOW_POWER=1', async (t) => {
  if (!desktopTools || !desktopPower) return t.skip('desktop layer is not implemented yet')
  const runner = createFakeRunner()
  const previousToken = process.env.DSH_POWER_CONFIRM_TOKEN
  const previousFlag = process.env.DSH_ALLOW_POWER
  process.env.DSH_POWER_CONFIRM_TOKEN = 'integration-power-token-2'
  delete process.env.DSH_ALLOW_POWER
  try {
    const { host } = await setup(
      { scopes: ['os.power'], powerEnabled: true },
      { runner },
    )
    const result = await host.defs.get('power_action').execute({
      action: 'shutdown',
      delaySec: 15,
      confirmToken: 'integration-power-token-2',
    })
    assert.equal(result.ok, true)
    assert.equal(result.executed, false)
    assert.equal(result.dryRun, true)
    assert.ok(result.missing.includes('env:DSH_ALLOW_POWER'))
    assert.equal(runner.calls.includes('runProgram'), false)
  } finally {
    if (previousToken === undefined) delete process.env.DSH_POWER_CONFIRM_TOKEN
    else process.env.DSH_POWER_CONFIRM_TOKEN = previousToken
    if (previousFlag === undefined) delete process.env.DSH_ALLOW_POWER
    else process.env.DSH_ALLOW_POWER = previousFlag
  }
})

test('power_action without a confirmation token is refused', async (t) => {
  if (!desktopTools || !desktopPower) return t.skip('desktop layer is not implemented yet')
  const previousToken = process.env.DSH_POWER_CONFIRM_TOKEN
  delete process.env.DSH_POWER_CONFIRM_TOKEN
  try {
    const { host } = await setup({ scopes: ['os.power'], powerEnabled: true })
    const result = await host.defs.get('power_action').execute({ action: 'reboot' })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'CONFIRM_REQUIRED')
  } finally {
    if (previousToken !== undefined) process.env.DSH_POWER_CONFIRM_TOKEN = previousToken
  }
})

test('approval of a scope stays exact: os.power does not grant browse.interact', async (t) => {
  if (!browserTools || !stubDriverModule) return t.skip('browser layer is not implemented yet')
  const { host } = await setup({ scopes: ['os.power'] })
  const opened = await host.defs.get('browse_open').execute({ url: 'https://www.instagram.com/' })
  assert.equal(opened.ok, false)
  assert.equal(opened.code, 'SCOPE_DENIED')
})

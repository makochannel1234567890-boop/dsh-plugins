#!/usr/bin/env node
/**
 * dsh-social-desktop-agent — offline verification.
 *
 * Usage:
 *   node dsh-social-desktop-agent/scripts/verify.mjs
 *
 * What it checks
 *   (a) index.js imports and exports the plugin contract
 *   (b) the expected 14 tools are registered into a fake host, per category;
 *       a missing layer is reported as SKIP (not FAIL), a broken one as FAIL
 *   (c) with the default settings, browse.interact and os.power are refused
 *   (d) social.write is permanently refused, even with browse.interact granted
 *   (e) the kill switch refuses everything, and the audit log is written
 *   (f) missing lib/core fails closed (0 tools, no throw); a missing browser
 *       layer still leaves the desktop tools registered
 *
 * No network, no real browser, no PowerShell, no shutdown.exe. The desktop
 * runner used here throws if an executable is ever about to run.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

/** @type {{ result: 'PASS'|'FAIL'|'SKIP', name: string, detail: string }[]} */
const rows = []
const pass = (name, detail = '') => rows.push({ result: 'PASS', name, detail })
const fail = (name, detail = '') => rows.push({ result: 'FAIL', name, detail })
const skip = (name, detail = '') => rows.push({ result: 'SKIP', name, detail })

function url(relative) {
  return pathToFileURL(path.join(ROOT, relative)).href
}

function short(value, limit = 130) {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  if (text === undefined) return ''
  const oneLine = String(text).replace(/\s+/g, ' ').trim()
  return oneLine.length > limit ? `${oneLine.slice(0, limit - 1)}…` : oneLine
}

function createHost() {
  /** @type {Map<string, any>} */
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
  const refuse = async () => {
    throw new Error('verify: real execution is forbidden')
  }
  return {
    platform: 'win32',
    async runPowerShell() {
      return { stdout: '{}', stderr: '' }
    },
    async runJson() {
      return {
        ok: true,
        cursor: { x: 0, y: 0 },
        metrics: { monitorCount: 1, virtualScreen: { left: 0, top: 0, width: 1920, height: 1080 } },
        monitorRects: [{ left: 0, top: 0, right: 1920, bottom: 1080, primary: true }],
        windows: [],
        foreground: null,
      }
    },
    async runProgram(...args) {
      return refuse(args)
    },
    async launchApp(...args) {
      return refuse(args)
    },
  }
}

function createFakeDriver() {
  let current = { url: 'about:blank', title: '' }
  return {
    async open(rawUrl) {
      current = { url: rawUrl, title: 'verify-page' }
      return { ...current }
    },
    async getPage() {
      return { ...current }
    },
    async snapshot() {
      return {
        ...current,
        nodes: [{ ref: 'e1', role: 'link', name: 'Home', url: current.url }],
      }
    },
    async click(ref) {
      return { ok: true, ref }
    },
    async type(ref) {
      return { ok: true, ref }
    },
    async scroll() {
      return { ok: true }
    },
    async screenshot() {
      return { ok: true, mimeType: 'image/png', dataUrl: 'data:image/png;base64,' }
    },
    async close() {
      return { ok: true }
    },
  }
}

async function tryImport(relative) {
  try {
    return await import(url(relative))
  } catch {
    return null
  }
}

function checkAuditFile(file) {
  if (!existsSync(file)) return { ok: false, detail: 'audit file was not created' }
  const lines = readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  if (lines.length === 0) return { ok: false, detail: 'audit file is empty' }
  const required = ['ts', 'scope', 'kind', 'target', 'result', 'reason']
  for (const line of lines) {
    let record
    try {
      record = JSON.parse(line)
    } catch {
      return { ok: false, detail: `non-JSON audit line: ${short(line, 60)}` }
    }
    for (const key of required) {
      if (!(key in record)) return { ok: false, detail: `audit line is missing "${key}"` }
    }
    if (record.result !== 'allow' && record.result !== 'deny') {
      return { ok: false, detail: `unexpected audit result "${record.result}"` }
    }
  }
  return { ok: true, detail: `${lines.length} JSONL line(s)` }
}

async function registerRuntime(mod, options) {
  const host = createHost()
  const runtime = mod.createRuntime({ ctx: host.ctx, ...options })
  await runtime.register()
  return { host, runtime }
}

function toolNamesFrom(host) {
  return [...host.defs.keys()]
}

function missingTools(expected, actual) {
  return expected.filter((name) => !actual.includes(name))
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const tempDir = mkdtempSync(path.join(os.tmpdir(), 'dsa-verify-'))
const auditPath = path.join(tempDir, 'audit.jsonl')

try {
  // -- (a) import + exported contract --------------------------------------
  let mod
  try {
    mod = await import(url('index.js'))
    pass('index.js import', `name="${mod.name ?? '?'}"`)
  } catch (error) {
    fail('index.js import', short(error?.message ?? error))
  }

  if (mod) {
    const contractProblems = []
    if (mod.name !== 'social-desktop-agent') contractProblems.push(`name=${mod.name}`)
    if (!Array.isArray(mod.inject) || !mod.inject.includes('tools')) contractProblems.push('inject != ["tools"]')
    if (typeof mod.apply !== 'function') contractProblems.push('apply() missing')
    if (typeof mod.resolveConfig !== 'function') contractProblems.push('resolveConfig() missing')
    if (contractProblems.length > 0) fail('exported contract', contractProblems.join('; '))
    else pass('exported contract', 'name/inject/apply/resolveConfig')

    const expectedNames = [
      'browse_open',
      'browse_snapshot',
      'browse_click',
      'browse_type',
      'browse_scroll',
      'browse_screenshot',
      'browse_close',
      'desktop_observe',
      'desktop_focus',
      'desktop_move',
      'desktop_click',
      'desktop_type',
      'desktop_key',
      'app_launch',
      'power_action',
    ]
    const declared = Array.isArray(mod.TOOL_NAMES) ? mod.TOOL_NAMES : []
    if (declared.length === expectedNames.length && expectedNames.every((n, i) => declared[i] === n)) {
      pass('declared TOOL_NAMES', '15 tools in the required order')
    } else {
      fail('declared TOOL_NAMES', short(`got ${declared.join(',') || '(none)'}`, 160))
    }

    const defaults = mod.DEFAULT_CONFIG ?? {}
    const defaultScopes = Array.isArray(defaults.scopes) ? defaults.scopes : []
    const scopeOk = defaultScopes.length === 1 && defaultScopes[0] === 'browse.read'
    const powerOff = defaults.powerEnabled === false
    if (scopeOk && powerOff) pass('default settings are least privilege', "scopes=['browse.read'], powerEnabled=false")
    else fail('default settings are least privilege', short({ scopes: defaultScopes, powerEnabled: defaults.powerEnabled }))

    // -- (b) registration into a fake host --------------------------------
    const stub = await tryImport('lib/browser/stub-driver.js')
    const driver = stub?.createStubDriver
      ? stub.createStubDriver({
          pages: [
            {
              url: 'https://www.instagram.com/',
              title: 'Instagram',
              text: 'verify page',
              nodes: [{ ref: 'e1', role: 'link', name: 'Home', url: 'https://www.instagram.com/' }],
            },
          ],
        })
      : createFakeDriver()

    const { host, runtime } = await registerRuntime(mod, {
      config: { ...defaults, auditPath },
      deps: { browserDriver: driver, desktopRunner: createFakeRunner() },
    })
    const registered = toolNamesFrom(host)
    const categories = runtime.diagnostics.categories
    const ledger = Object.fromEntries(runtime.diagnostics.skipped.map((entry) => [entry.tool, entry.reason]))

    for (const [category, expected] of [
      ['browser', expectedNames.slice(0, 7)],
      ['desktop', expectedNames.slice(7)],
    ]) {
      const state = categories[category]
      if (state === 'ready') {
        const missing = missingTools(expected, registered)
        if (missing.length === 0) pass(`${category} category`, `${expected.length} tools registered`)
        else fail(`${category} category`, `missing handlers: ${missing.join(', ')}`)
      } else if (state === 'missing') {
        skip(`${category} category`, `layer not implemented (${short(ledger[expected[0]] ?? 'no module', 90)})`)
      } else {
        fail(`${category} category`, `registration threw (${short(runtime.diagnostics.warnings.at(-1) ?? state, 90)})`)
      }
    }

    if (categories.core === 'ready') pass('core category', 'policy + audit loaded')
    else fail('core category', short(runtime.diagnostics.warnings.at(-1) ?? categories.core))

    // -- (c1) browse.read works on the default allowlist -------------------
    if (host.defs.has('browse_open')) {
      const result = await host.defs.get('browse_open').execute({ url: 'https://www.instagram.com/' })
      if (result?.ok === true) pass('default browse.read opens an allowlisted page', short(result.url))
      else fail('default browse.read opens an allowlisted page', short(result))
    } else {
      skip('default browse.read opens an allowlisted page', 'browse_open not registered')
    }

    // A non-allowlisted host must still be refused.
    if (host.defs.has('browse_open')) {
      const result = await host.defs.get('browse_open').execute({ url: 'https://example.com/' })
      if (result?.ok === false && result.code === 'TARGET_DENIED') pass('non-allowlisted host is refused', short(result.message, 90))
      else fail('non-allowlisted host is refused', short(result))
    } else {
      skip('non-allowlisted host is refused', 'browse_open not registered')
    }

    // -- (c2) default browse.interact is refused ---------------------------
    if (host.defs.has('browse_click')) {
      const result = await host.defs.get('browse_click').execute({ ref: 'e1' })
      if (result?.ok === false && result.code === 'SCOPE_DENIED') {
        pass('default browse.interact is refused', short(result.message, 100))
      } else {
        fail('default browse.interact is refused', short(result))
      }
    } else {
      skip('default browse.interact is refused', 'browse_click not registered')
    }

    // -- (c3) default os.power is refused ----------------------------------
    if (host.defs.has('power_action')) {
      const result = await host.defs.get('power_action').execute({ action: 'reboot', delaySec: 60 })
      if (result?.ok === false && (result.code === 'SCOPE_DENIED' || result.code === 'CONFIRM_REQUIRED')) {
        pass('default os.power is refused', short(`${result.code}: ${result.message}`, 100))
      } else {
        fail('default os.power is refused', short(result))
      }
    } else {
      skip('default os.power is refused', 'power_action not registered')
    }

    // -- (d) social.write is permanently refused ---------------------------
    const canBrowserInteract = categories.browser === 'ready'
    if (canBrowserInteract) {
      const second = await registerRuntime(mod, {
        config: { ...defaults, auditPath, scopes: ['browse.read', 'browse.interact'] },
        deps: { browserDriver: driver, desktopRunner: createFakeRunner() },
      })
      await second.host.defs.get('browse_open').execute({ url: 'https://www.instagram.com/' })
      const result = await second.host.defs.get('browse_click').execute({ ref: 'e1', purpose: 'social.write' })
      if (result?.ok === false && result.code === 'TARGET_DENIED' && result.permanent === true) {
        pass('social.write is permanently refused', short(result.message, 100))
      } else {
        fail('social.write is permanently refused', short(result))
      }
    } else {
      skip('social.write is permanently refused', 'browser layer not available')
    }

    // -- (e) kill switch ---------------------------------------------------
    if (host.defs.has('browse_open')) {
      const previous = process.env.DSH_KILL_SWITCH
      process.env.DSH_KILL_SWITCH = '1'
      try {
        const result = await host.defs.get('browse_open').execute({ url: 'https://www.instagram.com/' })
        if (result?.ok === false && result.code === 'KILL_SWITCH') pass('kill switch stops the browser layer', short(result.message, 90))
        else fail('kill switch stops the browser layer', short(result))
      } finally {
        if (previous === undefined) delete process.env.DSH_KILL_SWITCH
        else process.env.DSH_KILL_SWITCH = previous
      }
    } else {
      skip('kill switch stops the browser layer', 'browse_open not registered')
    }

    // -- (f) audit log -----------------------------------------------------
    const audit = checkAuditFile(auditPath)
    if (audit.ok) pass('audit log is written as JSONL', audit.detail)
    else fail('audit log is written as JSONL', audit.detail)

    // -- (g) missing lib/core fails closed ---------------------------------
    try {
      const coreOff = await registerRuntime(mod, { modules: { core: null }, config: { ...defaults, auditPath: null } })
      const count = toolNamesFrom(coreOff.host).length
      const warned = coreOff.runtime.diagnostics.warnings.some((line) => /lib\/core unavailable/i.test(line))
      if (count === 0 && warned) pass('missing lib/core fails closed', '0 tools registered, warning recorded')
      else fail('missing lib/core fails closed', `tools=${count}, warning=${warned}`)
    } catch (error) {
      fail('missing lib/core fails closed', short(error?.message ?? error))
    }

    // -- (h) missing browser layer leaves desktop available ----------------
    try {
      const browserOff = await registerRuntime(mod, {
        modules: { browser: null },
        config: { ...defaults, auditPath: null },
        deps: { desktopRunner: createFakeRunner() },
      })
      const names = toolNamesFrom(browserOff.host)
      const desktopNames = expectedNames.slice(7)
      if (categories.desktop === 'ready') {
        const missing = missingTools(desktopNames, names)
        if (missing.length === 0 && names.every((name) => desktopNames.includes(name))) {
          pass('missing browser layer degrades gracefully', `${desktopNames.length} desktop tools remain`)
        } else {
          fail('missing browser layer degrades gracefully', `missing=${missing.join(',') || '-'} extra=${names.filter((n) => !desktopNames.includes(n)).join(',') || '-'}`)
        }
      } else {
        skip('missing browser layer degrades gracefully', 'desktop layer not available')
      }
    } catch (error) {
      fail('missing browser layer degrades gracefully', short(error?.message ?? error))
    }
  }
} finally {
  rmSync(tempDir, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const counts = { PASS: 0, FAIL: 0, SKIP: 0 }
for (const row of rows) counts[row.result] += 1
const width = Math.max(6, ...rows.map((row) => row.name.length))

const line = `-${'-'.repeat(width + 2)}-${'-'.repeat(7)}-${'-'.repeat(40)}`
console.log('')
console.log('dsh-social-desktop-agent — offline verification')
console.log(line)
console.log(`#  ${'CHECK'.padEnd(width)}  RESULT   DETAIL`)
console.log(line)
rows.forEach((row, index) => {
  console.log(`${String(index + 1).padStart(3)} ${row.name.padEnd(width)}  ${row.result.padEnd(7)}  ${short(row.detail, 120)}`)
})
console.log(line)
console.log(`PASS ${counts.PASS}  FAIL ${counts.FAIL}  SKIP ${counts.SKIP}   (of ${rows.length} checks)`)

if (counts.SKIP > 0) {
  console.log('')
  console.log('SKIP means a layer is not implemented yet (module missing).')
  console.log('It is reported, not failed, so this script stays useful while other layers land.')
}

if (counts.FAIL > 0) {
  console.log('')
  console.error(`RESULT: FAIL (${counts.FAIL})`)
  process.exitCode = 1
} else {
  console.log('')
  console.log('RESULT: PASS')
}

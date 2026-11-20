/**
 * Client-half contract test.
 *
 * The browser half is the piece no Host test can reach: it only runs inside the
 * Web page, after a reload. This test loads the shipped `client.js` the way the
 * page does — through `window.__ModuleLoader__.load` — and then drives
 * `exports.apply(ctx)` against a recording slot stub, so a regression in the
 * module id, the registration ids, or the label fails here instead of silently
 * leaving the sidebar without an entry.
 *
 * React is stubbed: hooks return inert values, so components render into plain
 * descriptor objects and nothing touches a DOM. Every test disposes the
 * registrations, because apply() starts the polling timer through ctx.effect and
 * a test runner waits for that handle.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const clientPath = path.join(here, '..', 'client.js')
const pkg = JSON.parse(readFileSync(path.join(here, '..', 'package.json'), 'utf8'))

/** Minimal React: enough for the module to build elements and read hooks. */
function createReactStub() {
  const createElement = (type, props, ...children) => ({
    type,
    props: props ?? null,
    children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false),
  })
  return {
    createElement,
    useEffect() {},
    useRef(initial) {
      return { current: initial }
    },
    useState(initial) {
      return [typeof initial === 'function' ? initial() : initial, function noop() {}]
    },
  }
}

/** Load client.js the way the page does; returns the registered module meta. */
function loadClient() {
  const captured = []
  const window = {
    __ModuleLoader__: {
      load(meta) {
        captured.push(meta)
      },
    },
  }
  const run = new Function('window', 'console', readFileSync(clientPath, 'utf8'))
  run(window, { warn() {}, log() {}, error() {} })
  assert.equal(captured.length, 1, 'client.js must register exactly one module')
  const meta = captured[0]
  const React = createReactStub()
  const exports = meta.factory(function requireStub(id) {
    if (id === 'react') return React
    throw new Error('unexpected require: ' + id)
  })
  return { meta, exports }
}

/**
 * Apply the client half against a recording ctx, run `body`, then dispose.
 * `inject` is emulated as "the slot exists" so both registrations are exercised.
 */
function withAppliedClient(body) {
  const { exports } = loadClient()
  const registrations = []
  const cleanups = []
  const ctx = {
    logger: { warn() {} },
    get() {
      return undefined
    },
    effect(fn) {
      const cleanup = fn()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
      return function dispose() {
        for (const run of cleanups.splice(0)) {
          try {
            run()
          } catch {
            /* already torn down */
          }
        }
      }
    },
    slots: {
      inject(name, fn) {
        if (typeof fn === 'function') fn()
        return function dispose() {}
      },
      register(options, component) {
        registrations.push({ options, component })
        return function dispose() {}
      },
    },
  }

  const dispose = () => {
    for (const run of cleanups.splice(0)) {
      try {
        run()
      } catch {
        /* already torn down */
      }
    }
  }

  try {
    exports.apply(ctx)
    return body({ exports, registrations })
  } finally {
    dispose()
  }
}

test('the module id equals the package name', () => {
  const { meta } = loadClient()
  assert.equal(meta.id, pkg.name, 'the boot graph keys rows by package name; any other id never materializes')
})

test('the declared client injection list matches the sidebar recipe', () => {
  const client = pkg.dsh?.client
  assert.ok(client, 'package.json must declare dsh.client')
  assert.equal(client.platform, 'web')
  assert.equal(client.immediately, true, 'a resident sidebar entry must load at page boot')
  assert.deepEqual(client.inject, ['@deepseek-ai/dsh-client-ui-layout', '@deepseek-ai/dsh-client-ui-sidebar'])
  assert.equal(pkg.exports['./client'], './client.js')
})

test('apply() registers the sidebar row and the panel under one id', () => {
  withAppliedClient(({ registrations }) => {
    assert.equal(registrations.length, 2, 'one sidebar row, one main panel')

    const [row, panel] = registrations
    assert.equal(row.options.name, 'sidebar.panellist')
    assert.equal(row.options.id, 'mobile-progress')
    assert.equal(typeof row.options.order, 'number')
    assert.equal(typeof row.options.label, 'function', 'the label must be a thunk so it follows the locale')
    assert.equal(row.options.label(), 'スマホ進捗')
    assert.equal(typeof row.component, 'function')

    assert.equal(panel.options.name, 'main')
    assert.equal(panel.options.key, 'mobile-progress', 'the panel key must match the row id')
    assert.equal(typeof panel.component, 'function')
    const injected = panel.options.inject()
    assert.equal(typeof injected.onClose, 'function', 'closing must not throw without a layout service')
  })
})

test('the exported shape is the one the loader expects', () => {
  const { exports } = loadClient()
  assert.deepEqual(exports.inject, ['slots'])
  assert.equal(typeof exports.apply, 'function')
})

test('both components render without throwing and without a DOM', () => {
  withAppliedClient(({ registrations }) => {
    const [row, panel] = registrations
    const icon = row.component({ size: 24, active: true })
    assert.equal(icon.type, 'svg')

    const page = panel.component({})
    assert.equal(page.type, 'div')
    assert.equal(page.props['data-mobile-progress-panel'], '1')
  })
})

test('a disconnected bridge renders the notice instead of crashing', () => {
  withAppliedClient(({ registrations }) => {
    const page = registrations[1].component({})
    const flat = JSON.stringify(page)
    assert.ok(flat.includes('data-mobile-progress-panel'), 'panel root is missing')
    assert.ok(flat.includes('Host 側のブリッジに届いていません'), 'the disconnected notice is missing')
  })
})

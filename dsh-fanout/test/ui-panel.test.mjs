/**
 * ui-panel.test.mjs — the sidebar row and the progress panel, rendered offline.
 *
 * `client.js` is a ModuleLoader factory: it registers itself on a `window`
 * global and receives `react` through a `require` shim. That is enough to drive
 * the real client code in Node with a tiny React stand-in — no DOM, no browser,
 * no Host. What this proves:
 *
 *   1. `apply()` registers `sidebar.panellist` (id `fanout`) AND the `main`
 *      panel keyed by the same id — the pair the shell matches up.
 *   2. The panel renders the live Host payload (progress, worker chips, stage
 *      strip) and an old-Host payload (no `percent`/`worker_details`) without
 *      throwing, deriving the same numbers.
 *   3. The icon honours the owner's `size`/`active` props.
 *
 *   node test/ui-panel.test.mjs
 */
import assert from 'node:assert/strict'

/* -------------------------------------------------------------------------- *
 * Minimal React stand-in: elements are plain objects, hooks are slots.
 * -------------------------------------------------------------------------- */

const hookSlots = []
let hookIndex = 0

const ReactShim = {
  createElement(type, props, ...children) {
    return { type, props: props || {}, children }
  },
  useEffect() {
    // Effects are recorded, never executed: this harness renders only.
    hookIndex += 1
  },
  useRef(value) {
    const index = hookIndex
    hookIndex += 1
    if (!(index in hookSlots)) hookSlots[index] = { current: value }
    return hookSlots[index]
  },
  useState(initial) {
    const index = hookIndex
    hookIndex += 1
    if (!(index in hookSlots)) {
      hookSlots[index] = typeof initial === 'function' ? initial() : initial
    }
    return [hookSlots[index], function noopSet() {}]
  },
}

/** Fresh mount: React would start with empty hook state for a new tree. */
function mount(component, props) {
  hookSlots.length = 0
  hookIndex = 0
  return component(props)
}

/* -------------------------------------------------------------------------- *
 * Tree helpers
 * -------------------------------------------------------------------------- */

function textOf(node) {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  if (typeof node === 'object' && node !== null && node.type) return textOf(node.children)
  return ''
}

function collect(node, predicate, found = []) {
  if (node === null || node === undefined || typeof node !== 'object') return found
  if (Array.isArray(node)) {
    for (const child of node) collect(child, predicate, found)
    return found
  }
  if (node.type && predicate(node)) found.push(node)
  if (node.type) collect(node.children, predicate, found)
  return found
}

/* -------------------------------------------------------------------------- *
 * Fixtures
 * -------------------------------------------------------------------------- */

const now = Date.now()

/** The Host ≥ 0.2.0 payload: percent/phase/worker_details present. */
const ACTIVE_RUN = {
  run_id: 'run-20260101000000-aaaa',
  status: 'running',
  total: 3,
  settled: 2,
  failed: 0,
  updated_at: new Date(now).toISOString(),
  created_at: new Date(now - 65_000).toISOString(),
  objective: 'Three asymmetric jobs, merged and verified',
  estimate_tokens: 1234,
  percent: 57,
  phase: 'workers',
  integrator_state: '',
  integrate: true,
  final_path: '',
  cwd: 'C:/w',
  worker_details: [
    { index: 0, state: 'settled', tasks: [{ id: 't1', title: 'Heavy job' }], summary: 'done' },
    { index: 1, state: 'running', tasks: [{ id: 't2', title: 'Light job' }], summary: '' },
    { index: 2, state: 'settled', tasks: [], summary: '' },
  ],
}

/** An older Host: no percent, no phase, no worker_details. */
const LEGACY_RUN = {
  run_id: 'run-20260101000000-bbbb',
  status: 'completed',
  total: 2,
  settled: 2,
  failed: 0,
  updated_at: new Date(now).toISOString(),
  objective: 'A run from a Host that predates the board',
  estimate_tokens: 10,
}

/** An older Host mid-integration: only `status` says so. */
const LEGACY_INTEGRATING_RUN = {
  run_id: 'run-20260101000000-cccc',
  status: 'integrating',
  total: 2,
  settled: 2,
  failed: 0,
  updated_at: new Date(now).toISOString(),
  objective: 'Integration in progress on an older Host',
  estimate_tokens: 10,
}

const STATE_BODY = {
  ok: true,
  config: { workers: 3, expansion: 40 },
  runs: [ACTIVE_RUN, LEGACY_INTEGRATING_RUN, LEGACY_RUN],
  active_run_id: ACTIVE_RUN.run_id,
}

/* -------------------------------------------------------------------------- *
 * Load the real client module
 * -------------------------------------------------------------------------- */

let definition = null
globalThis.window = {
  __ModuleLoader__: {
    load(def) {
      definition = def
    },
  },
}
globalThis.fetch = async function stubFetch(url) {
  const address = String(url)
  const body = address.indexOf('/health') >= 0 ? { ok: true, token: 'test-token' } : STATE_BODY
  return {
    ok: true,
    status: 200,
    text: async function text() {
      return JSON.stringify(body)
    },
  }
}

await import('../client.js')
assert.ok(definition !== null, 'client.js did not register with __ModuleLoader__')

const module = definition.factory(function requireShim(name) {
  if (name === 'react') return ReactShim
  throw new Error(`unexpected require: ${String(name)}`)
})

let checks = 0
const failures = []

async function test(name, fn) {
  try {
    await fn()
    checks += 1
    console.log(`ok  ui-panel · ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.error(`FAIL ui-panel · ${name}`)
    console.error(error instanceof Error ? error.stack : String(error))
  }
}

/* -------------------------------------------------------------------------- *
 * A stub ctx that records slot registrations and hands back the bridge loop.
 * -------------------------------------------------------------------------- */

function makeCtx() {
  const registrations = []
  const effectBodies = []
  const injected = []
  const ctx = {
    get: function get() {
      return undefined
    },
    on: function on() {},
    inject: function inject() {},
    effect: function effect(body) {
      effectBodies.push(body)
      return function dispose() {}
    },
    slots: {
      register: function register(options, component) {
        registrations.push({ options: options, component: component })
        return function off() {}
      },
      inject: function injectSlot(name, factory) {
        injected.push({ name: name, factory: factory })
      },
    },
  }
  return { ctx, registrations, effectBodies, injected }
}

const harness = makeCtx()
module.apply(harness.ctx)

function registrationByName(name) {
  return harness.registrations.find((item) => item.options && item.options.name === name)
}

/* -------------------------------------------------------------------------- *
 * Tests
 * -------------------------------------------------------------------------- */

await test('apply() registers the sidebar row and its main panel under one id', async () => {
  const row = registrationByName('sidebar.panellist')
  const panel = registrationByName('main')
  assert.ok(row, 'no sidebar.panellist registration')
  assert.ok(panel, 'no main registration')
  assert.equal(row.options.id, 'fanout')
  assert.equal(panel.options.key, 'fanout', 'the row and the panel must share the id')
  assert.equal(typeof row.options.label, 'function')
  assert.equal(row.options.label(), 'Fan-out')
  assert.equal(typeof row.component, 'function')
  assert.equal(typeof panel.component, 'function')
  // Every seat this plugin fills. The dock goes through an injection effect
  // (the slot must exist first), the rest register directly.
  const seats = harness.registrations.map((entry) => entry.options.name).sort()
  assert.deepEqual(seats, [
    'conversation.input.overlay',
    'main',
    'sidebar.panellist',
    'sidebar.session.row.leading',
  ])
  const injected = harness.injected.map((entry) => entry.name).sort()
  assert.deepEqual(injected, ['conversation.input.dock'])
})

await test('the icon honours the owner size/active props', async () => {
  const row = registrationByName('sidebar.panellist')
  const icon = mount(row.component, { size: 24, active: true })
  assert.equal(icon.type, 'svg')
  assert.equal(icon.props.width, 24)
  assert.equal(icon.props.height, 24)
  const paths = collect(icon, (node) => node.type === 'path')
  assert.ok(paths.length >= 2, 'expected a fan-out glyph made of paths')
  assert.match(String(paths[0].props.stroke), /brand-primary/, 'active state uses the brand token')

  const idle = mount(row.component, { size: 16 })
  assert.equal(idle.props.width, 16)
  const idlePaths = collect(idle, (node) => node.type === 'path')
  assert.match(String(idlePaths[0].props.stroke), /label-secondary/)
})

await test('before any Host data the panel shows the empty state, not a crash', async () => {
  const panel = registrationByName('main')
  const tree = mount(panel.component)
  assert.equal(tree.props['data-fanout-panel'], '1')
  const text = textOf(tree)
  assert.match(text, /Fan-out 進捗/)
  assert.match(text, /まだ分割した実行はありません/)
})

await test('the panel renders live data once the bridge answers', async () => {
  // `apply()` captured the bridge loop in ctx.effect; running it performs the
  // same connect + /state round trip the browser does on mount.
  assert.ok(harness.effectBodies.length >= 1, 'expected the bridge loop effect')
  const cleanup = harness.effectBodies[0]()
  await new Promise((resolve) => setTimeout(resolve, 60))

  const panel = registrationByName('main')
  const tree = mount(panel.component)
  const text = textOf(tree).replace(/\s+/g, ' ')

  assert.match(text, /run-2026/, 'the run id is shown')
  assert.match(text, /57%/, 'the Host percent is shown')
  assert.match(text, /100%/, 'an old-Host run derives 100% from completed + settled')
  assert.match(text, /分岐実行/, 'the stage strip is rendered')
  assert.match(text, /ワーカー 6\/7/, 'aggregate worker counters span every run')
  assert.match(text, /いま実行中/, 'the active run gets its own section')
  assert.match(text, /直近の実行/, 'finished runs get the recent section')
  // An older Host sends no integrator_state: `status: integrating` must still
  // read as integration, not as a run idling at 85%.
  assert.match(text, /90%/, 'an integrating run without integrator_state derives 90%')
  assert.match(text, /統合: 実行中/)

  // Worker chips carry the task titles in their tooltip.
  const chips = collect(tree, (node) => typeof node.props.title === 'string' && /^W\d/.test(node.props.title))
  assert.equal(chips.length, 3, 'one chip per worker of the rich run')
  assert.match(chips[0].props.title, /Heavy job/)
  assert.match(chips[0].props.title, /完了/)
  assert.match(chips[1].props.title, /実行中/)

  cleanup()
})

await test('every progressbar is a real, bounded aria progressbar', async () => {
  const panel = registrationByName('main')
  const tree = mount(panel.component)
  const bars = collect(tree, (node) => node.props.role === 'progressbar')
  assert.equal(bars.length, 3, 'one bar per rendered run')
  for (const bar of bars) {
    const value = Number(bar.props['aria-valuenow'])
    assert.ok(Number.isFinite(value) && value >= 0 && value <= 100, `bad aria-valuenow: ${bar.props['aria-valuenow']}`)
    assert.equal(bar.props['aria-valuemin'], 0)
    assert.equal(bar.props['aria-valuemax'], 100)
  }
})

await test('the composer dock is a checkbox that morphs open', async () => {
  const dock = harness.injected.find((item) => item.name === 'conversation.input.dock')
  assert.ok(dock, 'the dock is not injected into conversation.input.dock')
  assert.equal(typeof dock.factory, 'function')
  dock.factory()
  const entry = harness.registrations.find((item) => item.options && item.options.id === 'fanout-dock')
  assert.ok(entry, 'the injected factory did not register the dock')
  assert.equal(entry.options.name, 'conversation.input.dock')
  assert.equal(typeof entry.component, 'function')

  const tree = mount(entry.component, { sessionId: 'session-1' })

  const boxes = collect(tree, (node) => node.type === 'input' && node.props.type === 'checkbox')
  assert.equal(boxes.length, 2, 'the dock exposes the arming box and the Team switch')
  assert.equal(boxes[0].props.checked, false, 'the arming box starts unchecked')
  assert.equal(typeof boxes[0].props.onChange, 'function', 'the box is driven by a handler')
  // The Team switch is Host-owned: before a read answers it stays disabled
  // instead of showing a selection it cannot know.
  assert.equal(boxes[1].props.disabled, true, 'the Team switch waits for a Host read')
  assert.match(textOf(tree), /エージェント連携/, 'the Team switch names itself')

  // The settings body stays mounted so its height can animate; while closed it
  // is a 0fr grid row and hidden from assistive technology / tab order.
  const morph = collect(
    tree,
    (node) => node.props && node.props.style && node.props.style.gridTemplateRows === '0fr',
  )
  assert.equal(morph.length, 1, 'no collapsed morph container')
  assert.equal(morph[0].props.style.visibility, 'hidden')

  assert.match(textOf(tree), /単一セッション/, 'the closed state still explains the single-session fallback')
})

await test('the composer takeover is registered, closed by default, and never eats clicks', async () => {
  const entry = harness.registrations.find((item) => item.options && item.options.id === 'fanout-takeover')
  assert.ok(entry, 'no composer takeover registration')
  assert.equal(entry.options.name, 'conversation.input.overlay')
  assert.equal(typeof entry.component, 'function')

  const tree = mount(entry.component, { sessionId: 'session-1' })
  assert.equal(tree.props['aria-hidden'], 'true', 'a disarmed takeover stays out of the a11y tree')
  const veils = collect(
    tree,
    (node) => node.props && node.props.style && node.props.style.gridTemplateRows === '0fr',
  )
  assert.equal(veils.length, 1, 'the closed panel is a 0fr grid row')
  assert.equal(veils[0].props.style.opacity, 0)
  assert.equal(veils[0].props.style.pointerEvents, 'none', 'a closed panel never intercepts input')
  assert.match(textOf(tree), /ファンアウト/)
})

await test('the sidebar mark appears only for a session that belongs to a run', async () => {
  const entry = harness.registrations.find((item) => item.options && item.options.id === 'fanout-session-mark')
  assert.ok(entry, 'no sidebar session mark registration')
  assert.equal(entry.options.name, 'sidebar.session.row.leading')
  assert.equal(mount(entry.component, { sessionId: 'session-1' }), null)
  assert.equal(mount(entry.component, {}), null)
})

// ---------------------------------------------------------------------------

if (failures.length > 0) {
  console.error(`not ok ui-panel.test.mjs — ${failures.length} of ${checks + failures.length} checks failed`)
  throw new Error(
    `ui-panel.test.mjs: ${failures.length} check(s) failed: ${failures.map((item) => item.name).join(', ')}`,
  )
}
console.log(`ok ui-panel.test.mjs (${checks} checks)`)

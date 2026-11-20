/**
 * lib/model — the run model resolver.
 *
 * The rules under test are the ones that keep the fan-out off a hardcoded id:
 * match the live catalog, keep the default's shape, and never throw when the
 * selection cannot be applied.
 */

import assert from 'node:assert/strict'

import {
  applySelection,
  buildSelections,
  compilePattern,
  DEFAULT_MODEL_PATTERN,
  describeTarget,
  pickEffort,
  pickTarget,
} from '../lib/model.js'

/** Same shape as the other suites: a named block that throws on the first fault. */
let checks = 0
function test(name, run) {
  run()
  checks += 1
  void name
}

const CATALOG = {
  default: { provider: 'deepseek', model: 'deepseek-chat', reasoning: { effort: 'medium' } },
  routableProviders: ['deepseek'],
  groups: [
    {
      id: 'deepseek',
      name: 'DeepSeek',
      models: [
        { id: 'deepseek-chat', name: 'DeepSeek Chat' },
        { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' },
      ],
    },
    {
      id: 'deepseek-labs',
      name: 'DeepSeek Labs',
      models: [
        {
          id: 'deepseek-v4.1-flash',
          name: 'DeepSeek V4.1 Flash',
          reasoning: {
            efforts: [
              { id: 'low', name: 'Low' },
              { id: 'medium', name: 'Medium' },
              { id: 'max', name: 'Max' },
            ],
          },
        },
      ],
    },
  ],
}

test('compilePattern tolerates a broken configuration', () => {
  assert.equal(compilePattern('[unclosed'), null)
  assert.equal(compilePattern(''), null)
  assert.equal(compilePattern(undefined), null)
  const re = compilePattern('flash')
  assert.ok(re && re.test('FLASH'))
})

test('pickEffort prefers the configured id, then anything max-like', () => {
  const reasoning = { efforts: [{ id: 'l', name: 'Low' }, { id: 'mx', name: 'Maximum' }] }
  assert.equal(pickEffort(reasoning, 'l'), 'l')
  assert.equal(pickEffort(reasoning, 'max'), 'mx')
  assert.equal(pickEffort({ efforts: [] }, 'max'), '')
  assert.equal(pickEffort(undefined, 'max'), '')
})

test('pickTarget resolves the configured family and reports how it matched', () => {
  const hit = pickTarget(CATALOG, { pattern: DEFAULT_MODEL_PATTERN })
  assert.equal(hit.matchedBy, 'pattern')
  assert.equal(hit.target.providerId, 'deepseek-labs')
  assert.equal(hit.target.modelId, 'deepseek-v4.1-flash')
  assert.equal(hit.target.effortId, 'max')
})

test('pickTarget falls back to any flash tier, then reports none', () => {
  const fallback = pickTarget(CATALOG, { pattern: 'v9\\.9-flash' })
  assert.equal(fallback.matchedBy, 'fallback')
  assert.equal(fallback.target.modelId, 'deepseek-v4.1-flash')

  // The primary pattern misses too, so the fallback answers — and says so.
  const second = pickTarget(CATALOG, { pattern: 'v9\\.9-nothing' })
  assert.equal(second.matchedBy, 'fallback')
  assert.equal(second.groups, 2)

  const noFlash = {
    ...CATALOG,
    groups: [{ id: 'deepseek', name: 'DeepSeek', models: [{ id: 'deepseek-chat', name: 'Chat' }] }],
  }
  const none = pickTarget(noFlash, { pattern: 'v9\\.9-nothing' })
  assert.equal(none.matchedBy, 'none')
  assert.equal(none.target, null)

  const empty = pickTarget(null, {})
  assert.equal(empty.matchedBy, 'none')
  assert.equal(empty.target, null)
})

test('buildSelections keeps the catalog default shape and patches the effort it uses', () => {
  const { target } = pickTarget(CATALOG, {})
  const [withEffort, plain] = buildSelections(CATALOG.default, target)
  assert.equal(withEffort.provider, 'deepseek-labs')
  assert.equal(withEffort.model, 'deepseek-v4.1-flash')
  assert.equal(withEffort.reasoning.effort, 'max')
  assert.equal(plain.reasoning.effort, 'medium', 'the retry drops the effort patch only')
  assert.notEqual(withEffort, CATALOG.default, 'the default is never mutated')
  assert.equal(CATALOG.default.model, 'deepseek-chat')
})

test('buildSelections patches a top-level effort field when that is the shape', () => {
  const [only] = buildSelections({ provider: 'p', model: 'm', effort: 'low' }, {
    providerId: 'p2',
    modelId: 'm2',
    effortId: 'max',
  })
  assert.deepEqual(only, { provider: 'p2', model: 'm2', effort: 'max' })
})

test('buildSelections omits the effort patch when the default has nowhere to put it', () => {
  const rows = buildSelections({ provider: 'p', model: 'm' }, { providerId: 'p2', modelId: 'm2', effortId: 'max' })
  assert.equal(rows.length, 1)
  assert.deepEqual(rows[0], { provider: 'p2', model: 'm2' })
})

test('describeTarget is safe on junk', () => {
  assert.match(describeTarget({ providerId: 'deepseek', modelId: 'flash', effortId: 'max' }), /deepseek\/flash · max/)
  assert.equal(describeTarget(null), '')
  assert.equal(describeTarget({}), '')
})

// --- applySelection (async: a top-level await, not a test() block) ----------

const calls = []
const strict = {
  async selectModel(request) {
    calls.push(request)
    if (request.reasoning && request.reasoning.effort === 'max') throw new Error('unknown reasoning effort')
    return { selected: { provider: request.provider, model: request.model } }
  },
}
const ok = await applySelection(strict, 's1', [
  { provider: 'p', model: 'm', reasoning: { effort: 'max' } },
  { provider: 'p', model: 'm', reasoning: { effort: 'medium' } },
])
assert.equal(ok.ok, true)
assert.equal(ok.effort, false, 'the retry means the effort was not applied')
assert.equal(calls.length, 2)
assert.equal(calls[0].sessionId, 's1')

const failing = {
  async selectModel() {
    throw new Error('nope')
  },
}
const failed = await applySelection(failing, 's1', [{ provider: 'p', model: 'm' }])
assert.equal(failed.ok, false)
assert.match(failed.error, /nope/)

const unavailable = await applySelection({}, 's1', [{ provider: 'p', model: 'm' }])
assert.equal(unavailable.ok, false)
assert.match(unavailable.error, /selectModel/)

console.log(`ok model.test.mjs (${checks} checks)`)


/**
 * plan.test.mjs — pure planning helpers in `lib/plan.js`.
 *
 * Plain ESM + node:assert/strict (no test framework), because the Harness Node
 * build may not expose a stable `node:test` runner. Run with:
 *
 *   node plan.test.mjs
 *   node test/plan.test.mjs      (from the plugin root)
 *
 * 日本語コメント: 期待値は DESIGN.md と lib/plan.js の実装コメントに合わせる。
 * 実装が仕様から外れている場合はここを緩めず、FINDINGS.md に記録する。
 */
import assert from 'node:assert/strict'

import {
  MAX_TASKS,
  SLIDER_MAX,
  estimateBudget,
  expansionPlan,
  intensityPlan,
  makeRunId,
  normalizeTasks,
  packTasks,
  packingCovers,
  phaseOf,
  progressOf,
  truncate,
} from '../lib/plan.js'

let checks = 0
const failures = []

function test(name, fn) {
  try {
    fn()
    checks += 1
    console.log(`ok  plan · ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.error(`FAIL plan · ${name}`)
    console.error(error instanceof Error ? error.stack : String(error))
  }
}

/** Fixture: already-normalised tasks, as the engine would pass them to packTasks. */
function tasksFor(weights) {
  return weights.map((weight, index) => ({
    id: `t${index + 1}`,
    title: `Task ${index + 1}`,
    brief: `brief ${index + 1}`,
    weight,
    scope: [],
  }))
}

// ---------------------------------------------------------------------------
// normalizeTasks
// ---------------------------------------------------------------------------

test('normalizeTasks: non-array and blank input is dropped', () => {
  assert.deepEqual(normalizeTasks(undefined), [])
  assert.deepEqual(normalizeTasks(null), [])
  assert.deepEqual(normalizeTasks('t1'), [])
  assert.deepEqual(normalizeTasks([null, 'x', 3, {}, { title: '', brief: '   ' }]), [])
})

test('normalizeTasks: ids are stable t1..tN and blanks do not consume an id', () => {
  const tasks = normalizeTasks([
    { title: 'A', brief: 'a' },
    null,
    { title: '   ', brief: '   ' },
    { title: 'B', brief: 'b' },
    { title: '', brief: 'title falls back to the brief' },
  ])
  assert.equal(tasks.length, 3)
  assert.deepEqual(tasks.map((task) => task.id), ['t1', 't2', 't3'])
  assert.equal(tasks[0].title, 'A')
  assert.equal(tasks[2].title, 'title falls back to the brief')
})

test('normalizeTasks: weight clamps to 0.25..8, non-numbers default to 1', () => {
  const tasks = normalizeTasks([
    { title: 'low', brief: 'x', weight: 0.1 },
    { title: 'floor', brief: 'x', weight: 0.25 },
    { title: 'normal', brief: 'x', weight: 2.5 },
    { title: 'high', brief: 'x', weight: 99 },
    { title: 'negative', brief: 'x', weight: -3 },
    { title: 'string', brief: 'x', weight: '2.5' },
    { title: 'nan', brief: 'x', weight: Number.NaN },
    { title: 'missing', brief: 'x' },
  ])
  assert.deepEqual(
    tasks.map((task) => task.weight),
    [0.25, 0.25, 2.5, 8, 0.25, 1, 1, 1],
  )
})

test('normalizeTasks: brief truncation honours maxBrief (default 4000, clamped 200..12000)', () => {
  const longBrief = 'x'.repeat(5000)
  const byDefault = normalizeTasks([{ title: 'L', brief: longBrief }])
  assert.equal(byDefault[0].brief.length, 4000)
  assert.ok(byDefault[0].brief.endsWith('…'))

  const strict = normalizeTasks([{ title: 'S', brief: longBrief }], { maxBrief: 250 })
  assert.equal(strict[0].brief.length, 250)
  assert.ok(strict[0].brief.endsWith('…'))

  // Below the 200 floor is clamped up, above the 12000 ceiling is clamped down.
  const tooSmall = normalizeTasks([{ title: 'T', brief: longBrief }], { maxBrief: 5 })
  assert.equal(tooSmall[0].brief.length, 200)
  const belowFloor = normalizeTasks([{ title: 'B', brief: longBrief }], { maxBrief: 120 })
  assert.equal(belowFloor[0].brief.length, 200)
  const tooBig = normalizeTasks([{ title: 'U', brief: 'y'.repeat(13000) }], { maxBrief: 99999 })
  assert.equal(tooBig[0].brief.length, 12000)
})

test('normalizeTasks: MAX_TASKS caps the list (mirrors fanout_start maxItems)', () => {
  const input = Array.from({ length: MAX_TASKS + 6 }, (_, index) => ({
    title: `T${index}`,
    brief: 'b',
  }))
  const tasks = normalizeTasks(input)
  assert.equal(MAX_TASKS, 24) // index.js `tasks.maxItems`
  assert.equal(tasks.length, MAX_TASKS)
  assert.deepEqual(
    tasks.map((task) => task.id),
    Array.from({ length: MAX_TASKS }, (_, index) => `t${index + 1}`),
  )
  assert.equal(typeof SLIDER_MAX, 'number')
})

test('normalizeTasks: scope keeps <=12 non-empty trimmed strings', () => {
  const scope = [' a ', 7, '', 'b', ...Array.from({ length: 12 }, (_, index) => `p${index}`)]
  const [task] = normalizeTasks([{ title: 'S', brief: 'b', scope }])
  assert.equal(task.scope.length, 12)
  assert.deepEqual(task.scope.slice(0, 2), ['a', 'b'])
  assert.deepEqual(normalizeTasks([{ title: 'N', brief: 'b', scope: 'src/' }])[0].scope, [])
})

// ---------------------------------------------------------------------------
// packTasks (LPT bin packing)
// ---------------------------------------------------------------------------

test('packTasks: [5,2,1] with 2 workers balances to 5 and 3', () => {
  const tasks = tasksFor([5, 2, 1])
  const buckets = packTasks(tasks, 2)
  assert.equal(buckets.length, 2)
  assert.deepEqual(
    buckets.map((bucket) => bucket.weight).sort((a, b) => b - a),
    [5, 3],
  )
  // LPT: heaviest first, then each task onto the least-loaded bucket.
  assert.deepEqual(buckets[0].taskIds, ['t1'])
  assert.deepEqual(buckets[1].taskIds, ['t2', 't3'])
  assert.ok(packingCovers(tasks, buckets))
})

test('packTasks: [4,3,2,1] with 2 workers balances 5/5 (not 7/3)', () => {
  const tasks = tasksFor([4, 3, 2, 1])
  const buckets = packTasks(tasks, 2)
  assert.deepEqual(
    buckets.map((bucket) => bucket.weight).sort((a, b) => b - a),
    [5, 5],
  )
  assert.ok(packingCovers(tasks, buckets))
})

test('packTasks: every task id appears exactly once', () => {
  const tasks = tasksFor([0.25, 8, 1.5, 3.33, 0.5, 7.9, 2, 1])
  for (const workers of [1, 2, 3, 5, 8, 99]) {
    const buckets = packTasks(tasks, workers)
    const ids = buckets.flatMap((bucket) => bucket.taskIds)
    assert.equal(ids.length, tasks.length, `workers=${workers}`)
    assert.equal(new Set(ids).size, tasks.length, `workers=${workers}`)
    assert.ok(packingCovers(tasks, buckets), `workers=${workers}`)
    assert.ok(buckets.length <= Math.min(workers, tasks.length), `workers=${workers}`)
  }
})

test('packTasks: workerCount clamped to 1..tasks.length', () => {
  const tasks = tasksFor([2, 1, 1])
  assert.equal(packTasks(tasks, 0).length, 1)
  assert.equal(packTasks(tasks, -4).length, 1)
  assert.equal(packTasks(tasks, undefined).length, 1)
  assert.equal(packTasks(tasks, 2.9).length, 2)
  assert.equal(packTasks(tasks, 99).length, 3)
})

test('packTasks: empty input is safe', () => {
  assert.deepEqual(packTasks([], 4), [])
  assert.deepEqual(packTasks([], 0), [])
  assert.equal(packingCovers([], []), true)
  assert.equal(packingCovers([], [{ index: 0, taskIds: [], weight: 0 }]), true)
})

// ---------------------------------------------------------------------------
// expansionPlan / intensityPlan
// ---------------------------------------------------------------------------

test('expansionPlan: slider boundaries 0/1/30/31/60/61/85/86/100', () => {
  const expected = [
    [0, { level: 0, axes: 0, classify: false }],
    [1, { level: 1, axes: 1, classify: false }],
    [30, { level: 1, axes: 1, classify: false }],
    [31, { level: 2, axes: 3, classify: false }],
    [60, { level: 2, axes: 3, classify: false }],
    [61, { level: 3, axes: 5, classify: true }],
    [85, { level: 3, axes: 5, classify: true }],
    [86, { level: 4, axes: 8, classify: true }],
    [100, { level: 4, axes: 8, classify: true }],
  ]
  for (const [slider, want] of expected) {
    const plan = expansionPlan(slider)
    assert.equal(plan.slider, slider, `slider ${slider}`)
    assert.equal(plan.level, want.level, `slider ${slider} level`)
    assert.equal(plan.axes, want.axes, `slider ${slider} axes`)
    assert.equal(plan.classify, want.classify, `slider ${slider} classify`)
    assert.equal(typeof plan.label, 'string', `slider ${slider} label`)
    assert.ok(plan.label.length > 0, `slider ${slider} label`)
  }
  assert.equal(expansionPlan(0).label, 'オフ')
  assert.equal(expansionPlan(1).label, '浅く1軸')
  assert.equal(expansionPlan(31).label, '3軸')
})

test('expansionPlan: out-of-range and non-number input is clamped', () => {
  assert.equal(expansionPlan(-10).level, 0)
  assert.equal(expansionPlan(-10).slider, 0)
  assert.equal(expansionPlan(101).slider, 100)
  assert.equal(expansionPlan(101).level, 4)
  assert.equal(expansionPlan(undefined).slider, 40) // defaultExpansion fallback
  assert.equal(expansionPlan(Number.NaN).slider, 40)
  assert.equal(expansionPlan('50').slider, 40) // strings are not coerced (tool schema is numeric)
})

test('intensityPlan: intensity 1..5 widens monotonically to the widest plan', () => {
  // index.js documents intensity 1–5 as 1/2/3/5/8 orthogonal axes, so the dial
  // must widen with the value and its maximum must not fall back to the default.
  const axes = [1, 2, 3, 4, 5].map((level) => intensityPlan(level).axes)
  for (let index = 1; index < axes.length; index += 1) {
    assert.ok(axes[index] > axes[index - 1], `intensity ${index + 1}: axes ${axes}`)
  }
  assert.ok(axes[4] >= axes[3], `intensity 5 must not be narrower than 4: axes ${axes}`)
  // FINDINGS.md F3 (fixed 23:27): regression guard for the level-5 off-by-one
  // that read past `[0,15,45,75,100]` and silently became expansionPlan(40).
  assert.deepEqual(intensityPlan(5), expansionPlan(100))
  assert.deepEqual(intensityPlan(9), expansionPlan(100)) // clamped to level 5
  assert.deepEqual(intensityPlan(0), intensityPlan(1)) // clamped to level 1
})

// ---------------------------------------------------------------------------
// estimateBudget
// ---------------------------------------------------------------------------

test('estimateBudget: positive, shaped, and formula-consistent', () => {
  const budget = estimateBudget({
    tasks: [{ brief: 'a'.repeat(300) }],
    workers: 2,
    expansion: 75,
  })
  assert.equal(budget.workers, 2)
  assert.equal(budget.tasks, 1)
  assert.equal(budget.probeAxes, 5) // expansionPlan(75)
  // 2 workers * (1200 + 300/3) + 1 task * 500 + 5 axes * 900 + integrate 5200
  assert.equal(budget.approx_tokens, 2 * (1200 + 100) + 500 + 5 * 900 + 5200)
  assert.ok(budget.approx_tokens > 0)
  assert.ok(estimateBudget({}).approx_tokens > 0)
  assert.ok(estimateBudget({ tasks: [], workers: 0, expansion: 0 }).approx_tokens > 0)
})

test('estimateBudget: non-decreasing across tasks, workers and expansion', () => {
  let previous = 0
  for (const expansion of [0, 1, 30, 31, 60, 61, 85, 86, 100]) {
    const value = estimateBudget({ tasks: tasksFor([1, 2, 3]), workers: 4, expansion }).approx_tokens
    assert.ok(value >= previous, `expansion ${expansion}: ${value} < ${previous}`)
    previous = value
  }

  previous = 0
  for (const workers of [1, 2, 3, 4, 8, 16, 99]) {
    const value = estimateBudget({ tasks: tasksFor([1, 2]), workers, expansion: 0 }).approx_tokens
    assert.ok(value >= previous, `workers ${workers}: ${value} < ${previous}`)
    previous = value
  }

  previous = 0
  for (let count = 0; count <= 6; count += 1) {
    const tasks = Array.from({ length: count }, () => ({ brief: 'x'.repeat(120) }))
    const value = estimateBudget({ tasks, workers: 2, expansion: 0 }).approx_tokens
    assert.ok(value >= previous, `${count} tasks: ${value} < ${previous}`)
    previous = value
  }

  const clamped = estimateBudget({ tasks: [], workers: 99, expansion: 0 })
  assert.equal(clamped.workers, 24) // estimateBudget clamps workers to 1..24
})

// ---------------------------------------------------------------------------
// makeRunId
// ---------------------------------------------------------------------------

test('makeRunId: prefix + 14-digit stamp + 4-char suffix, filesystem-safe', () => {
  const now = Date.UTC(2026, 0, 2, 3, 4, 5) // 2026-01-02T03:04:05.000Z
  const stamp = new Date(now).toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
  assert.equal(stamp.length, 14)
  assert.match(stamp, /^\d{14}$/)

  for (const random of [0, 0.000001, 0.5, 0.999999]) {
    const id = makeRunId('run', now, () => random)
    assert.match(id, new RegExp(`^run-${stamp}-[a-z0-9]{4}$`), `random ${random}: ${id}`)
    assert.equal(id.length, 'run-'.length + 14 + 1 + 4)
    assert.ok(!/[\\/:*?"<>|\s]/.test(id), `not filesystem-safe: ${id}`)
  }

  // base36 suffix is padded to exactly four characters.
  assert.match(makeRunId('run', now, () => 0.5), /-i000$/)
  assert.match(makeRunId('run', now, () => 0), /-0000$/)

  // 200 real draws keep the documented shape.
  for (let index = 0; index < 200; index += 1) {
    const id = makeRunId('div')
    assert.match(id, /^div-\d{14}-[a-z0-9]{4}$/, id)
    assert.ok(!/[\\/:*?"<>|\s]/.test(id), `not filesystem-safe: ${id}`)
  }
})

// ---------------------------------------------------------------------------
// packingCovers / truncate
// ---------------------------------------------------------------------------

test('packingCovers: detects missing, duplicated and extra ids', () => {
  const tasks = tasksFor([1, 1])
  const good = [
    { index: 0, taskIds: ['t1'], weight: 1 },
    { index: 1, taskIds: ['t2'], weight: 1 },
  ]
  assert.equal(packingCovers(tasks, good), true)
  assert.equal(packingCovers(tasks, [{ index: 0, taskIds: ['t1'], weight: 1 }]), false)
  assert.equal(
    packingCovers(tasks, [
      { index: 0, taskIds: ['t1', 't1'], weight: 2 },
      { index: 1, taskIds: ['t2'], weight: 1 },
    ]),
    false,
  )
  assert.equal(packingCovers(tasks, [...good, { index: 2, taskIds: ['t3'], weight: 1 }]), false)
})

test('truncate: hard cap including the ellipsis', () => {
  assert.equal(truncate('abcdef', 3), 'ab…')
  assert.equal(truncate('abc', 10), 'abc')
  assert.equal(truncate(undefined, 4), '')
  assert.equal(truncate('abcdef', 6), 'abcdef')
})

// ---------------------------------------------------------------------------
// progressOf / phaseOf — the sidebar progress board's numbers
// ---------------------------------------------------------------------------

test('progressOf: workers are 85%, integration is the last 15%', () => {
  assert.equal(progressOf({ totalWorkers: 4, settledWorkers: 0, integratorState: '', status: 'running' }), 0)
  assert.equal(progressOf({ totalWorkers: 4, settledWorkers: 2, integratorState: '', status: 'running' }), 43)
  assert.equal(progressOf({ totalWorkers: 4, settledWorkers: 4, integratorState: '', status: 'running' }), 85)
  assert.equal(progressOf({ totalWorkers: 4, settledWorkers: 4, integratorState: 'running', status: 'integrating' }), 90)
  assert.equal(progressOf({ totalWorkers: 4, settledWorkers: 4, integratorState: 'settled', status: 'completed' }), 100)
})

test('progressOf: terminal runs never linger above what they reached', () => {
  assert.equal(progressOf({ totalWorkers: 4, settledWorkers: 4, integratorState: 'settled', status: 'completed' }), 100)
  // A stopped run reports the worker share it actually reached, not 100.
  assert.equal(progressOf({ totalWorkers: 4, settledWorkers: 3, integratorState: 'stopped', status: 'stopped' }), 64)
  assert.equal(progressOf({ totalWorkers: 4, settledWorkers: 4, integratorState: '', status: 'failed' }), 85)
})

test('progressOf: clamps junk instead of emitting NaN or >100', () => {
  assert.equal(progressOf({ totalWorkers: 0, settledWorkers: 0, integratorState: '', status: 'running' }), 0)
  assert.equal(progressOf({ totalWorkers: 2, settledWorkers: 99, integratorState: '', status: 'running' }), 85)
  assert.equal(progressOf({}), 0)
  assert.equal(progressOf({ totalWorkers: 3, settledWorkers: 1, integratorState: 'settled', status: 'running' }), 100)
})

test('phaseOf: maps run status + integrator state to one stage', () => {
  assert.equal(phaseOf({ status: 'running', integratorState: '' }), 'workers')
  assert.equal(phaseOf({ status: 'integrating', integratorState: 'running' }), 'integrating')
  assert.equal(phaseOf({ status: 'completed', integratorState: 'settled' }), 'done')
  assert.equal(phaseOf({ status: 'failed', integratorState: '' }), 'failed')
  assert.equal(phaseOf({ status: 'stopped', integratorState: 'stopped' }), 'stopped')
  assert.equal(phaseOf({}), 'workers')
})

// ---------------------------------------------------------------------------

if (failures.length > 0) {
  console.error(`not ok plan.test.mjs — ${failures.length} of ${checks + failures.length} checks failed`)
  throw new Error(`plan.test.mjs: ${failures.length} check(s) failed: ${failures.map((item) => item.name).join(', ')}`)
}
console.log(`ok plan.test.mjs (${checks} checks)`)

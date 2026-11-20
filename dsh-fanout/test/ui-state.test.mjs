/**
 * ui-state.test.mjs — the progress-board projection in `lib/engine.js`.
 *
 * `uiState()` / `uiRun()` are called straight off the prototype with a stub
 * receiver: they only read a run object, so no Cordis ctx, store or live session
 * is needed. That keeps the exact shape the sidebar panel consumes under test.
 *
 *   node test/ui-state.test.mjs
 */
import assert from 'node:assert/strict'

import { FanoutEngine } from '../lib/engine.js'

let checks = 0
const failures = []

function test(name, fn) {
  try {
    fn()
    checks += 1
    console.log(`ok  ui-state · ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.error(`FAIL ui-state · ${name}`)
    console.error(error instanceof Error ? error.stack : String(error))
  }
}

function runFixture(overrides = {}) {
  return {
    id: 'run-20260101000000-aaaa',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_060_000,
    status: 'running',
    objective: 'Fan one request out into three asymmetric jobs',
    cwd: 'C:/w',
    integrateRequested: true,
    tasks: [
      { id: 't1', title: 'Heavy job', brief: '', weight: 4, scope: [] },
      { id: 't2', title: 'Light job', brief: '', weight: 1, scope: [] },
    ],
    workers: [
      { index: 0, taskIds: ['t1'], weight: 4, state: 'running', sessionId: 's0', summary: '', error: '' },
      { index: 1, taskIds: ['t2'], weight: 1, state: 'settled', sessionId: 's1', summary: 'done it', error: '' },
    ],
    integrator: undefined,
    estimate: { approx_tokens: 1234 },
    finalPath: '',
    error: '',
    ...overrides,
  }
}

const uiRun = (run) => FanoutEngine.prototype.uiRun.call({}, run)

/** `uiState()` delegates to `uiRun()`, so the receiver needs the real prototype. */
function receiverWith(runs) {
  const receiver = Object.create(FanoutEngine.prototype)
  receiver.runs = runs
  return receiver
}

test('uiRun: keeps every field the dock already reads', () => {
  const ui = uiRun(runFixture())
  assert.equal(ui.run_id, 'run-20260101000000-aaaa')
  assert.equal(ui.status, 'running')
  assert.equal(ui.total, 2)
  assert.equal(ui.settled, 1)
  assert.equal(ui.failed, 0)
  assert.equal(ui.estimate_tokens, 1234)
  assert.match(ui.objective, /three asymmetric jobs/)
  assert.equal(ui.updated_at, new Date(1_700_000_060_000).toISOString())
})

test('uiRun: adds the progress-board fields the panel reads', () => {
  const ui = uiRun(runFixture())
  assert.equal(ui.percent, 43)
  assert.equal(ui.phase, 'workers')
  assert.equal(ui.integrator_state, '')
  assert.equal(ui.integrate, true)
  assert.equal(ui.created_at, new Date(1_700_000_000_000).toISOString())
  assert.equal(ui.final_path, '')
  assert.equal(ui.error, undefined)
})

test('uiRun: each worker carries its own state and resolved task titles', () => {
  const ui = uiRun(runFixture())
  assert.equal(ui.worker_details.length, 2)
  assert.deepEqual(ui.worker_details[0], {
    index: 0,
    state: 'running',
    weight: 4,
    session_id: 's0',
    summary: '',
    error: undefined,
    tasks: [{ id: 't1', title: 'Heavy job', weight: 4 }],
  })
  assert.equal(ui.worker_details[1].tasks[0].title, 'Light job')
  assert.equal(ui.worker_details[1].summary, 'done it')
})

test('uiRun: an unknown task id degrades to the id, never undefined', () => {
  const run = runFixture({ tasks: [] })
  const ui = uiRun(run)
  assert.deepEqual(ui.worker_details[0].tasks, [{ id: 't1', title: 't1', weight: 0 }])
})

test('uiRun: integrator state drives phase and percent once workers settle', () => {
  const workers = [
    { index: 0, taskIds: ['t1'], weight: 1, state: 'settled', sessionId: 's0', summary: '', error: '' },
    { index: 1, taskIds: ['t2'], weight: 1, state: 'settled', sessionId: 's1', summary: '', error: '' },
  ]
  const integrating = uiRun(
    runFixture({ workers, status: 'integrating', integrator: { sessionId: 'i', state: 'running' } }),
  )
  assert.equal(integrating.phase, 'integrating')
  assert.equal(integrating.percent, 90)
  assert.equal(integrating.integrator_state, 'running')

  const done = uiRun(
    runFixture({
      workers,
      status: 'completed',
      integrator: { sessionId: 'i', state: 'settled' },
      finalPath: 'runs/x/final.md',
    }),
  )
  assert.equal(done.phase, 'done')
  assert.equal(done.percent, 100)
  assert.equal(done.final_path, 'runs/x/final.md')
})

test('uiRun: a half-built run object never throws', () => {
  const ui = uiRun({})
  assert.equal(ui.total, 0)
  assert.equal(ui.percent, 0)
  assert.equal(ui.phase, 'workers')
  assert.deepEqual(ui.worker_details, [])
  assert.equal(ui.objective, '')
})

test('uiRun: long summaries and objectives are bounded', () => {
  const ui = uiRun(
    runFixture({
      objective: 'x'.repeat(500),
      workers: [
        { index: 0, taskIds: [], weight: 1, state: 'settled', sessionId: 's', summary: 'y'.repeat(500), error: '' },
      ],
    }),
  )
  assert.equal(ui.objective.length, 160)
  assert.equal(ui.worker_details[0].summary.length, 160)
})

test('uiState: newest first, capped at 8, and names the active run', () => {
  const runs = new Map()
  for (let i = 0; i < 10; i += 1) {
    runs.set(`r${i}`, runFixture({ id: `r${i}`, createdAt: 1_000 + i, updatedAt: 2_000 + i }))
  }
  const state = FanoutEngine.prototype.uiState.call(receiverWith(runs))
  assert.equal(state.runs.length, 8)
  assert.equal(state.runs[0].run_id, 'r9')
  assert.equal(state.active_run_id, 'r9')
  assert.equal(state.runs[0].percent, 43)
})

test('uiState: no run at all yields an empty, non-throwing board', () => {
  const state = FanoutEngine.prototype.uiState.call(receiverWith(new Map()))
  assert.deepEqual(state.runs, [])
  assert.equal(state.active_run_id, undefined)
})

// ---------------------------------------------------------------------------

if (failures.length > 0) {
  console.error(`not ok ui-state.test.mjs — ${failures.length} of ${checks + failures.length} checks failed`)
  throw new Error(
    `ui-state.test.mjs: ${failures.length} check(s) failed: ${failures.map((item) => item.name).join(', ')}`,
  )
}
console.log(`ok ui-state.test.mjs (${checks} checks)`)

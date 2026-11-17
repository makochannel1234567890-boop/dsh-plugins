/**
 * prompts.test.mjs — bounded brief builders in `lib/prompts.js`.
 *
 * The security-relevant property under test is context discipline: a worker
 * brief carries the objective + only its own tasks, an integrator brief carries
 * only bounded digests, and a probe brief never sees the caller's proposal.
 *
 * Plain ESM + node:assert/strict. Run with: node prompts.test.mjs
 */
import assert from 'node:assert/strict'
import path from 'node:path'

import * as engineModule from '../lib/engine.js'
import * as promptsModule from '../lib/prompts.js'

const { DIVERGENCE_AXES, divergenceAxes, renderCallerDigest, renderIntegratorBrief, renderProbeBrief, renderWorkerBrief } =
  promptsModule

// `parseOptionLines` is exported by lib/engine.js today (DESIGN lists the parsing
// under the probe flow). Accept either home, but fail loudly if it disappears.
const parseOptionLines = promptsModule.parseOptionLines ?? engineModule.parseOptionLines

let checks = 0
const failures = []

function test(name, fn) {
  try {
    fn()
    checks += 1
    console.log(`ok  prompts · ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.error(`FAIL prompts · ${name}`)
    console.error(error instanceof Error ? error.stack : String(error))
  }
}

const RUN_ID = 'run-20261116130500-abcd'

/** A run record shaped like FanoutEngine.start()'s, without any live session. */
function makeRun(overrides = {}) {
  return {
    id: RUN_ID,
    objective: 'Unify the three reporting pipelines behind one contract without coupling the lanes.',
    tasks: [
      {
        id: 't1',
        title: 'Migrate billing export',
        brief: 'Move the billing CSV exporter onto the shared contract; keep its CLI flags.',
        weight: 3,
        scope: ['src/billing'],
      },
      {
        id: 't2',
        title: 'Add pipeline conformance tests',
        brief: 'Write conformance tests that every lane must pass.',
        weight: 2,
        scope: [],
      },
      {
        id: 't3',
        title: 'Document the shared contract',
        brief: 'Document the contract, its invariants and the migration order.',
        weight: 1,
        scope: ['docs'],
      },
    ],
    workers: [
      {
        index: 0,
        taskIds: ['t1'],
        weight: 3,
        sessionId: 'sess-worker-1',
        state: 'settled',
        digest: 'W1-DIGEST: billing exporter moved; 12 tests pass.',
        summary: 'billing exporter moved',
      },
      {
        index: 1,
        taskIds: ['t2'],
        weight: 2,
        sessionId: 'sess-worker-2',
        state: 'failed',
        digest: 'W2-DIGEST: conformance tests added, two lanes skipped.',
        summary: 'tests added',
      },
      {
        index: 2,
        taskIds: ['t3'],
        weight: 1,
        sessionId: 'sess-worker-3',
        state: 'settled',
        digest: '',
        summary: '',
      },
    ],
    integrator: { sessionId: 'sess-integrator', state: 'settled', summary: 'Merged; build green; one gap.' },
    verify: ['npm test', 'npm run build'],
    resultDigestChars: 1200,
    cwd: undefined,
    status: 'completed',
    finalPath: `.dsh-fanout/runs/${RUN_ID}/final.md`,
    runDir: `state-dir/runs/${RUN_ID}`,
    updatedAt: Date.UTC(2026, 10, 16, 4, 6, 0),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// renderWorkerBrief
// ---------------------------------------------------------------------------

test('renderWorkerBrief: objective, assigned titles, result path, isolation rules', () => {
  const run = makeRun()
  const brief = renderWorkerBrief(run, { index: 0, taskIds: ['t1', 't2'], weight: 5 })
  assert.ok(brief.includes(run.objective), 'objective is passed to the worker')
  assert.ok(brief.includes('Migrate billing export'), 'assigned task t1 title')
  assert.ok(brief.includes('Add pipeline conformance tests'), 'assigned task t2 title')
  assert.ok(!brief.includes('Document the shared contract'), 'unassigned tasks must not leak')
  assert.ok(brief.includes(`.dsh-fanout/runs/${RUN_ID}/results/worker-1.md`), 'worker-1 result path')
  assert.ok(brief.includes('<fanout_worker run='))
  assert.ok(brief.includes('</fanout_worker>'))
  assert.match(brief, /Isolation rules/)
  assert.ok(brief.includes('You do NOT have the parent conversation'))
  assert.ok(brief.includes('Other workers handle other slices'))
  assert.ok(brief.includes('Do not try to reconstruct it'))
  assert.ok(brief.includes('## Verification'))
  assert.ok(brief.includes('## Open issues'))
})

test('renderWorkerBrief: worker index drives the file name', () => {
  const run = makeRun()
  const second = renderWorkerBrief(run, { index: 1, taskIds: ['t3'], weight: 1 })
  assert.ok(second.includes(`.dsh-fanout/runs/${RUN_ID}/results/worker-2.md`))
  assert.ok(second.includes('worker="2"'))
  assert.ok(second.includes('Document the shared contract'))
  assert.ok(!second.includes('Migrate billing export'))
})

test('renderWorkerBrief: unknown task ids are ignored, not rendered as undefined', () => {
  const run = makeRun()
  const brief = renderWorkerBrief(run, { index: 0, taskIds: ['t1', 't99'], weight: 3 })
  assert.ok(brief.includes('Migrate billing export'))
  assert.ok(!brief.includes('undefined'))
  assert.ok(brief.includes('Your assignment (1 task)'))
})

test('renderWorkerBrief: cwd is prefixed to the result path', () => {
  const cwd = path.join('fake-workspace-root', 'project')
  const run = makeRun({ cwd })
  const brief = renderWorkerBrief(run, { index: 0, taskIds: ['t1'], weight: 3 })
  const relative = `.dsh-fanout/runs/${RUN_ID}/results/worker-1.md`
  assert.ok(brief.includes(`${cwd.replace(/[\\/]+$/, '')}/${relative}`))

  const trailing = makeRun({ cwd: `${cwd}${path.sep}` })
  const trailingBrief = renderWorkerBrief(trailing, { index: 0, taskIds: ['t1'], weight: 3 })
  assert.ok(!trailingBrief.includes(`${cwd}${path.sep}/${relative}`))
})

test('renderWorkerBrief: stays under 12k chars for a realistic run', () => {
  const realistic = makeRun({
    objective: 'O'.repeat(900),
    tasks: Array.from({ length: 6 }, (_, index) => ({
      id: `t${index + 1}`,
      title: `Task ${index + 1} with a descriptive but short name`,
      brief: 'B'.repeat(900),
      weight: 1,
      scope: ['src/a', 'src/b'],
    })),
  })
  // Worst realistic packing: all six tasks on one worker.
  const brief = renderWorkerBrief(realistic, {
    index: 0,
    taskIds: ['t1', 't2', 't3', 't4', 't5', 't6'],
    weight: 6,
  })
  assert.ok(brief.length < 12000, `worker brief is ${brief.length} chars (budget 12000)`)
  assert.ok(brief.includes('Task 6 with a descriptive but short name'))
})

test('renderWorkerBrief: objective is truncated at 1800 chars', () => {
  const run = makeRun({ objective: 'Z'.repeat(5000) })
  const brief = renderWorkerBrief(run, { index: 0, taskIds: ['t1'], weight: 1 })
  assert.ok(brief.includes('Z'.repeat(1799)))
  assert.ok(!brief.includes('Z'.repeat(1800)))
})

// ---------------------------------------------------------------------------
// renderIntegratorBrief
// ---------------------------------------------------------------------------

test('renderIntegratorBrief: every digest, verify commands, final path', () => {
  const run = makeRun()
  const brief = renderIntegratorBrief(run)
  assert.ok(brief.includes('W1-DIGEST'))
  assert.ok(brief.includes('W2-DIGEST'))
  assert.ok(brief.includes('sess-worker-1'))
  assert.ok(brief.includes('sess-worker-2'))
  assert.ok(brief.includes('### Worker 2 — failed'))
  assert.ok(brief.includes('1. npm test'))
  assert.ok(brief.includes('2. npm run build'))
  assert.ok(brief.includes(`.dsh-fanout/runs/${RUN_ID}/final.md`))
  assert.ok(brief.includes('<fanout_integrate run='))
  assert.ok(brief.includes('Do not claim a command passed unless you ran it'))
})

test('renderIntegratorBrief: falls back to discovering verify commands', () => {
  const run = makeRun({ verify: [] })
  const brief = renderIntegratorBrief(run)
  assert.ok(brief.includes('package.json scripts'))
  assert.ok(!brief.includes('1. npm test'))
})

test('renderIntegratorBrief: truncates each digest at run.resultDigestChars', () => {
  const run = makeRun({ resultDigestChars: 120 })
  run.workers = [
    {
      index: 0,
      taskIds: ['t1'],
      sessionId: 's1',
      state: 'settled',
      digest: 'A'.repeat(2000),
      summary: '',
    },
  ]
  const brief = renderIntegratorBrief(run)
  assert.ok(brief.includes(`${'A'.repeat(119)}…`), 'digest capped to limit-1 plus ellipsis')
  assert.ok(!brief.includes('A'.repeat(120)), 'digest must not exceed the configured limit')
  assert.ok(!brief.includes('A'.repeat(2000)), 'full digest must never reach the integrator')
})

test('renderIntegratorBrief: default digest cap is 1200 chars', () => {
  const run = makeRun({ resultDigestChars: undefined })
  run.workers = [
    { index: 0, taskIds: ['t1'], sessionId: 's1', state: 'settled', digest: 'B'.repeat(1500), summary: '' },
  ]
  const brief = renderIntegratorBrief(run)
  assert.ok(brief.includes('B'.repeat(1199)))
  assert.ok(!brief.includes('B'.repeat(1200)))
})

test('renderIntegratorBrief: a missing digest is marked explicitly', () => {
  const run = makeRun()
  run.workers = [
    { index: 0, taskIds: ['t1'], sessionId: 's1', state: 'failed', digest: '', summary: '' },
    { index: 1, taskIds: ['t2'], sessionId: 's2', state: 'settled', digest: 'HAVE-DIGEST', summary: '' },
  ]
  const brief = renderIntegratorBrief(run)
  assert.match(brief, /no digest/i)
  assert.match(brief, /missing/i)
  assert.ok(brief.includes('HAVE-DIGEST'))
})

// ---------------------------------------------------------------------------
// renderProbeBrief — the unanchored-context property
// ---------------------------------------------------------------------------

test('renderProbeBrief: never leaks the proposal, keeps the objective', () => {
  const secret = 'SECRET-PROPOSAL-9f4c2a17'
  const divergence = {
    id: 'div-20261116130500-wxyz',
    objective: 'Replace the ad-hoc export scripts with a declared pipeline contract.',
    proposal: `My current plan is ${secret} and it narrows the option space.`,
    constraints: ['no new runtime dependencies', 'Windows host'],
  }
  const axis = DIVERGENCE_AXES[0]
  const brief = renderProbeBrief(divergence, axis)

  assert.ok(!brief.includes(secret), 'proposal text must never reach a probe')
  assert.ok(!brief.includes('My current plan'), 'proposal framing must never reach a probe')
  assert.ok(brief.includes(divergence.objective), 'the objective is the probe input')
  assert.ok(brief.includes(axis.label))
  assert.ok(brief.includes(axis.ask))
  assert.ok(brief.includes('no new runtime dependencies'))
  assert.ok(brief.includes('Windows host'))
  assert.ok(brief.includes(`.dsh-fanout/divergence/${divergence.id}/${axis.id}.md`))
  assert.match(brief, /Do not assume any existing plan, proposal, or architecture/)
  assert.match(brief, /OPTION:/)
})

test('renderProbeBrief: long objective truncated at 2400 chars, proposal still absent', () => {
  const secret = 'SECRET-2b8e1d'
  const divergence = {
    id: 'div-20261116130500-wxyz',
    objective: 'P'.repeat(4000),
    proposal: secret,
    constraints: [],
  }
  const axis = DIVERGENCE_AXES[1]
  const brief = renderProbeBrief(divergence, axis)
  assert.ok(brief.includes('P'.repeat(2399)))
  assert.ok(!brief.includes('P'.repeat(2400)))
  assert.ok(!brief.includes(secret))
  assert.ok(brief.includes('（制約の明示なし）'))
})

test('divergenceAxes: 1..8 orthogonal lenses, never more than the table', () => {
  assert.equal(DIVERGENCE_AXES.length, 8)
  assert.equal(new Set(DIVERGENCE_AXES.map((axis) => axis.id)).size, 8)
  assert.equal(divergenceAxes(0).length, 1)
  assert.equal(divergenceAxes(1).length, 1)
  assert.equal(divergenceAxes(3).length, 3)
  assert.equal(divergenceAxes(5).length, 5)
  assert.equal(divergenceAxes(8).length, 8)
  assert.equal(divergenceAxes(99).length, 8)
  // FINDINGS.md F5 (fixed 23:27): non-finite input clamps to one lens instead
  // of silently returning an empty probe plan (`slice(0, NaN)` was []).
  assert.equal(divergenceAxes(Number.NaN).length, 1)
  assert.equal(divergenceAxes(undefined).length, 1)
})

// ---------------------------------------------------------------------------
// parseOptionLines
// ---------------------------------------------------------------------------

test('parseOptionLines: only OPTION lines, preamble ignored, capped at 4', () => {
  assert.equal(typeof parseOptionLines, 'function', 'parseOptionLines must be exported (lib/engine.js today)')
  const text = [
    'Here is my analysis: this preamble is not an option.',
    '- OPTION: Replace the pipeline with a declarative contract',
    'OPTION： Use the existing scheduler',
    '  option: Subtract the export step entirely',
    'Some prose in between.',
    'OPTION: Reuse the reporting library',
    '* OPTION: this fifth one must be dropped',
    'OPTION:',
  ].join('\r\n')
  assert.deepEqual(parseOptionLines(text), [
    'Replace the pipeline with a declarative contract',
    'Use the existing scheduler',
    'Subtract the export step entirely',
    'Reuse the reporting library',
  ])
  assert.deepEqual(parseOptionLines('no options here at all'), [])
  assert.deepEqual(parseOptionLines(undefined), [])
  assert.deepEqual(parseOptionLines('1. ordinary numbered list\n2. another line'), [])
})

test('parseOptionLines: caps each option at 200 chars', () => {
  const parsed = parseOptionLines(`OPTION: ${'x'.repeat(500)}`)
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].length, 200)
  assert.equal(parseOptionLines('OPTION:   ').length, 0)
})

// ---------------------------------------------------------------------------
// renderCallerDigest
// ---------------------------------------------------------------------------

test('renderCallerDigest: bounded even with huge digests', () => {
  const run = makeRun()
  run.workers = Array.from({ length: 8 }, (_, index) => ({
    index,
    taskIds: [`t${index + 1}`],
    sessionId: `s${index}`,
    state: index === 0 ? 'failed' : 'settled',
    digest: 'Z'.repeat(50000),
    summary: index === 0 ? 'worker 0 failed' : undefined,
  }))
  run.integrator = { summary: 'Q'.repeat(50000) }

  const digest = renderCallerDigest(run)
  assert.ok(digest.length < 8000, `caller digest is ${digest.length} chars`)
  assert.ok(!digest.includes('Z'.repeat(221)), 'per-worker digest must be truncated')
  assert.ok(!digest.includes('Q'.repeat(601)), 'integrator summary must be truncated')
  assert.ok(digest.includes(`run="${run.id}"`))
  assert.ok(digest.includes('7/8 settled'))
  assert.ok(digest.includes('[failed]'))
  assert.ok(digest.includes(`Final report: ${run.finalPath}`))
  assert.ok(digest.includes('do not restart the workers'))
})

test('renderCallerDigest: missing final report is marked', () => {
  // FINDINGS.md F4 (fixed 23:24): regression guard — `??` kept the empty string,
  // so the fallback never fired for a run that skipped integration.
  const run = makeRun({ finalPath: '' })
  const digest = renderCallerDigest(run)
  assert.ok(digest.includes('Final report: (not produced)'))
})

// ---------------------------------------------------------------------------

if (failures.length > 0) {
  console.error(`not ok prompts.test.mjs — ${failures.length} of ${checks + failures.length} checks failed`)
  throw new Error(
    `prompts.test.mjs: ${failures.length} check(s) failed: ${failures.map((item) => item.name).join(', ')}`,
  )
}
console.log(`ok prompts.test.mjs (${checks} checks)`)

/**
 * prompts2.test.mjs — the briefs and the caller digest.
 *
 * The briefs are contracts: if the marker, the ACCEPT line, or the VERDICT line
 * is missing from the prompt, a compliant model cannot answer and the engine
 * rejects honest work. The caller digest is the only thing the delegating
 * session sees, so it must never claim "finished" for a retryable failure.
 */

import assert from 'node:assert/strict'

import { renderCallerDigest, renderReviewBrief, renderTaskBrief } from '../lib/prompts2.js'

let checks = 0
function check(name, fn) {
  fn()
  checks += 1
  console.log(`ok  prompts2 · ${name}`)
}

const run = {
  id: 'run-test',
  cwd: 'C:/tmp/ws',
  objective: 'prove the gate',
  verify: ['node test.js'],
  resultDigestChars: 1200,
  integrateRequested: true,
  updatedAt: Date.UTC(2026, 10, 17, 10, 44, 18),
}

const task = {
  id: 't1',
  kind: 'implementation',
  title: 'greet',
  brief: 'create greet.js',
  weight: 1,
  deps: [],
  attempt: 1,
  attemptId: 't1-a1-abcd',
  state: 'completed',
  summary: 'done',
  digest: 'implemented',
  findings: [],
  contract: {
    objective: 'greet works',
    acceptance: ["greet('World') returns 'Hello, World!'"],
    verify: ['node test.js'],
    inScope: ['greet.js'],
    outOfScope: [],
  },
}

check('the worker brief carries the attempt marker, the result path and the ACCEPT contract', () => {
  const brief = renderTaskBrief(run, task, 't1-a1-abcd')
  assert.ok(brief.includes(`<!-- fanout-result task=t1 attempt=t1-a1-abcd -->`))
  assert.ok(brief.includes('.dsh-fanout/runs/run-test/results/t1-a1-abcd.md'))
  assert.ok(brief.includes('ACCEPT:'))
  assert.ok(brief.includes("greet('World') returns 'Hello, World!'"))
  assert.ok(brief.includes('CLOSED:'))
})

check('the worker brief names the expert lens the parent recorded, and omits the block otherwise', () => {
  const withLens = renderTaskBrief(run, { ...task, experts: ['engineering-code-reviewer'] }, 't1-a1-abcd')
  assert.ok(withLens.includes('Expert lenses this job was shaped with'))
  assert.ok(withLens.includes('engineering-code-reviewer'))
  const withoutLens = renderTaskBrief(run, task, 't1-a1-abcd')
  assert.ok(!withoutLens.includes('Expert lenses'))
})

check('the review brief carries the verdict protocol and the criteria to judge', () => {
  const reviewTask = { id: 'review-t1-r1', attempt: 1, round: 1 }
  const brief = renderReviewBrief(run, task, reviewTask, 'digest text')
  assert.ok(brief.includes('VERDICT: pass | needs_revision | reject'))
  assert.ok(brief.includes('FINDING:'))
  assert.ok(brief.includes("greet('World') returns 'Hello, World!'"))
  assert.ok(brief.includes('.dsh-fanout/runs/run-test/results/review-t1-r1-1.md'))
})

check('a failed digest is timestamped and tells the caller it is retryable', () => {
  const digest = renderCallerDigest({
    ...run,
    status: 'failed',
    tasks: [task],
    integrator: undefined,
    finalPath: '',
    runDir: 'C:/store/runs/run-test',
  })
  assert.ok(digest.includes('status="failed"'))
  assert.ok(digest.includes('As of: 2026-11-17T10:44:18.000Z'))
  assert.ok(digest.includes('retry'))
  assert.ok(!digest.includes('The orchestration is finished.'))
})

check('a completed digest says the orchestration is finished', () => {
  const digest = renderCallerDigest({
    ...run,
    status: 'completed',
    tasks: [task],
    integrator: { summary: 'all good' },
    finalPath: 'C:/tmp/ws/.dsh-fanout/runs/run-test/final.md',
    runDir: 'C:/store/runs/run-test',
  })
  assert.ok(digest.includes('status="completed"'))
  assert.ok(digest.includes('Final report: C:/tmp/ws/.dsh-fanout/runs/run-test/final.md'))
  assert.ok(digest.includes('The orchestration is finished.'))
})

check('a retried attempt is told why the previous one was rejected', () => {
  const retried = { ...task, attempt: 2, error: 'missing "<!-- fanout-result … -->" marker' }
  const brief = renderTaskBrief(run, retried, 't1-a2-efgh')
  assert.ok(brief.includes('Previous attempt was rejected'))
  assert.ok(brief.includes('missing'))
})

check('a retried review is told why the previous review was rejected', () => {
  const reviewTask = {
    id: 'review-t1-r1',
    attempt: 2,
    round: 1,
    error: 'missing "VERDICT: pass|needs_revision|reject"',
  }
  const brief = renderReviewBrief(run, task, reviewTask, 'digest text')
  assert.ok(brief.includes('Previous review attempt was rejected'))
})

console.log(`ok  prompts2.test.mjs (${checks} checks)`)

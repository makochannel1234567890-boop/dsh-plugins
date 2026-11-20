/**
 * gates.test.mjs — the line protocol that decides whether work can be accepted.
 */

import assert from 'node:assert/strict'

import {
  parseAttemptMarker,
  parseResult,
  parseReview,
  validateFinal,
  validateResult,
  validateReview,
} from '../lib/gates.js'

let checks = 0
function check(name, fn) {
  fn()
  checks += 1
  console.log(`ok  gates · ${name}`)
}

const RESULT = `<!-- fanout-result task=t1 attempt=t1-a1-abcd -->
# Task t1 — result
## Summary
implemented the slice
## What changed
- src/a.js: added the thing
## Verification
- \`node --test\` → 12 pass, exit 0
## Acceptance
- ACCEPT: the thing works | passed | node --test exit 0
## Changed paths
- src/a.js
## Closed findings
- CLOSED: F1
## Open issues
- none
`

check('parseResult reads the marker, summary, acceptance, closed findings and paths', () => {
  const parsed = parseResult(RESULT)
  assert.equal(parsed.marker.taskId, 't1')
  assert.equal(parsed.marker.attemptId, 't1-a1-abcd')
  assert.equal(parsed.summary, 'implemented the slice')
  assert.deepEqual(parsed.changedPaths, ['src/a.js'])
  assert.equal(parsed.verification.length, 1)
  assert.equal(parsed.acceptance[0].criterion, 'the thing works')
  assert.equal(parsed.acceptance[0].status, 'passed')
  assert.deepEqual(parsed.closed, ['F1'])
})

check('parseAttemptMarker tolerates whitespace and rejects unrelated comments', () => {
  assert.deepEqual(parseAttemptMarker('<!--  fanout-result  task=t2 attempt=t2-a3-x  -->'), {
    taskId: 't2',
    attemptId: 't2-a3-x',
  })
  assert.deepEqual(parseAttemptMarker('<!-- other -->'), { taskId: '', attemptId: '' })
})

check('validateResult accepts a matching attempt with answered criteria', () => {
  const verdict = validateResult(parseResult(RESULT), {
    taskId: 't1',
    attemptId: 't1-a1-abcd',
    acceptance: ['the thing works'],
    kind: 'work',
  })
  assert.deepEqual(verdict.problems, [])
  assert.equal(verdict.ok, true)
  assert.equal(verdict.stale, false)
})

check('a stale attempt is flagged and never accepted', () => {
  const verdict = validateResult(parseResult(RESULT), {
    taskId: 't1',
    attemptId: 't1-a2-zzzz',
    acceptance: ['the thing works'],
    kind: 'work',
  })
  assert.equal(verdict.ok, false)
  assert.equal(verdict.stale, true)
})

check('an unanswered acceptance criterion fails the result', () => {
  const verdict = validateResult(parseResult(RESULT), {
    taskId: 't1',
    attemptId: 't1-a1-abcd',
    acceptance: ['the thing works', 'nothing else broke'],
    kind: 'implementation',
  })
  assert.equal(verdict.ok, false)
  assert.ok(verdict.problems.some((problem) => problem.includes('nothing else broke')))
})

check('a repair must close every finding it was dispatched for', () => {
  const verdict = validateResult(parseResult(RESULT), {
    taskId: 't1',
    attemptId: 't1-a1-abcd',
    acceptance: [],
    kind: 'repair',
    sourceFindingIds: ['F1', 'F2'],
  })
  assert.equal(verdict.ok, false)
  assert.ok(verdict.problems.some((problem) => problem.includes('F2')))
})

check('parseReview reads verdict, acceptance and findings', () => {
  const review = parseReview(`VERDICT: needs_revision
ACCEPT: the thing works | failed | the command was never run
FINDING: F1 | high | no evidence for the claim | run node --test and attach output | src/a.js | 12
`)
  assert.equal(review.verdict, 'needs_revision')
  assert.equal(review.acceptance[0].status, 'failed')
  assert.equal(review.findings.length, 1)
  assert.equal(review.findings[0].id, 'F1')
  assert.equal(review.findings[0].severity, 'high')
  assert.equal(review.findings[0].line, 12)
})

check('a pass with an open finding is invalid', () => {
  const review = parseReview('VERDICT: pass\nFINDING: F1 | low | x | y\n')
  const checkResult = validateReview(review, { acceptance: [] })
  assert.equal(checkResult.ok, false)
  assert.ok(checkResult.problems.some((problem) => problem.includes('findings')))
})

check('needs_revision without a finding is invalid', () => {
  const review = parseReview('VERDICT: needs_revision\n')
  const verdict = validateReview(review, { acceptance: [] })
  assert.equal(verdict.ok, false)
})

check('a pass with zero findings but no criterion lines is accepted with warnings', () => {
  const review = parseReview('VERDICT: pass\nfindings: 0\n')
  const verdict = validateReview(review, { acceptance: ['works'], strictAcceptance: false })
  assert.equal(verdict.ok, true)
  assert.equal(verdict.warnings.length, 1)
  assert.equal(verdict.problems.length, 0)
})

check('strict mode rejects the same pass for missing criterion coverage', () => {
  const review = parseReview('VERDICT: pass\n')
  const verdict = validateReview(review, { acceptance: ['works'], strictAcceptance: true })
  assert.equal(verdict.ok, false)
  assert.ok(verdict.problems.some((problem) => problem.includes('works')))
})

check('a missing verdict is a contract violation, not a pass', () => {
  const verdict = validateReview(parseReview('looks fine to me'), { acceptance: [] })
  assert.equal(verdict.ok, false)
  assert.ok(verdict.problems.some((problem) => problem.includes('VERDICT')))
})

check('validateFinal requires the sections and a real command table', () => {
  const bad = validateFinal('# Fan-out final report\n## Outcome\nlooks good\n')
  assert.equal(bad.ok, false)
  assert.ok(bad.problems.some((problem) => problem.includes('Verification')))
  const good = validateFinal(`# Fan-out final report
## Outcome
The slice landed and the build passes; the mobile check is still unproven.
## Conflicts and how they were resolved
None.
## Verification
| command | exit code | evidence |
| --- | --- | --- |
| \`node --test\` | 0 | 54 checks pass |
## Remaining gaps
Mobile manual check.
## Files of record
src/a.js
`)
  assert.deepEqual(good.problems, [])
})

console.log(`ok  gates.test.mjs (${checks} checks)`)

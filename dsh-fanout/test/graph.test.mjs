/**
 * graph.test.mjs — task-graph rules (normalisation, DAG, review/repair splicing).
 *
 * Plain node, no framework: throw on failure, print one `ok` line per check.
 */

import assert from 'node:assert/strict'

import {
  attemptToken,
  insertRepair,
  insertReview,
  normalizeGraph,
  progressPercent,
  readyTasks,
  stateSummary,
  validateGraph,
} from '../lib/graph.js'

let checks = 0
function check(name, fn) {
  fn()
  checks += 1
  console.log(`ok  graph · ${name}`)
}

check('normalises tasks, bounds weights and defaults the quality contract', () => {
  const { tasks, problems, warnings } = normalizeGraph([
    { title: 'A', brief: 'do a', weight: 99 },
    { id: 'impl', title: 'B', brief: 'do b', kind: 'implementation', acceptance: ['B works'], verify: ['npm test'] },
  ])
  assert.deepEqual(problems, [])
  assert.equal(tasks.length, 2)
  assert.equal(tasks[0].weight, 8)
  assert.equal(tasks[1].kind, 'implementation')
  assert.deepEqual(tasks[1].contract.acceptance, ['B works'])
  assert.deepEqual(tasks[1].contract.verify, ['npm test'])
  assert.ok(warnings.every((item) => typeof item === 'string'))
})

check('rejects a quality task without a verify command', () => {
  const { problems } = normalizeGraph([
    { title: 'impl', brief: 'x', kind: 'implementation', acceptance: ['works'] },
  ])
  assert.ok(problems.some((problem) => problem.includes('verify command')), problems.join('; '))
})

check('rejects unknown dependencies and dependency cycles', () => {
  const unknown = normalizeGraph([{ title: 'a', brief: 'a', dependsOn: ['nope'] }])
  assert.ok(unknown.problems.some((problem) => problem.includes('unknown dependency')))
  const cyclic = normalizeGraph([
    { id: 'a', title: 'a', brief: 'a', dependsOn: ['b'] },
    { id: 'b', title: 'b', brief: 'b', dependsOn: ['a'] },
  ])
  assert.ok(cyclic.problems.some((problem) => problem.includes('cycle')), cyclic.problems.join('; '))
})

check('accepts 1-based dependency numbers and reports monotonic readiness', () => {
  const { tasks, problems } = normalizeGraph([
    { title: 'a', brief: 'a' },
    { title: 'b', brief: 'b', dependsOn: [1] },
  ])
  assert.deepEqual(problems, [])
  assert.deepEqual(tasks[1].deps, ['t1'])
  assert.deepEqual(readyTasks(tasks).map((task) => task.id), ['t1'])
  tasks[0].state = 'completed'
  assert.deepEqual(readyTasks(tasks).map((task) => task.id), ['t2'])
})

check('a review node depends on its source and a repair depends on the review', () => {
  const { tasks } = normalizeGraph([{ title: 'a', brief: 'a' }])
  const review = insertReview(tasks, 't1', 1)
  assert.equal(review.id, 'review-t1-r1')
  assert.deepEqual(review.deps, ['t1'])
  review.state = 'completed'
  review.findings = [{ id: 'F1' }, { id: 'F2' }]
  const repair = insertRepair(tasks, review.id, 1)
  assert.deepEqual(repair.deps, ['review-t1-r1'])
  assert.deepEqual(repair.sourceFindingIds, ['F1', 'F2'])
  assert.equal(repair.kind, 'repair')
})

check('review after a repair can depend on the repair instead of the source', () => {
  const { tasks } = normalizeGraph([{ title: 'a', brief: 'a' }])
  insertReview(tasks, 't1', 1).state = 'completed'
  const repair = insertRepair(tasks, 'review-t1-r1', 1)
  const second = insertReview(tasks, 't1', 2, repair.id)
  assert.deepEqual(second.deps, ['repair-t1-r1'])
})

check('expert lenses are normalised, deduped and inherited by review and repair', () => {
  const { tasks, problems } = normalizeGraph([
    {
      title: 'a',
      brief: 'a',
      experts: ['engineering-code-reviewer', ' engineering-code-reviewer ', 'design-ui-designer', 42, ''],
    },
  ])
  assert.deepEqual(problems, [])
  assert.deepEqual(tasks[0].experts, ['engineering-code-reviewer', 'design-ui-designer'])
  insertReview(tasks, 't1', 1).state = 'completed'
  const review = tasks.find((task) => task.id === 'review-t1-r1')
  const repair = insertRepair(tasks, 'review-t1-r1', 1)
  assert.deepEqual(review.experts, ['engineering-code-reviewer', 'design-ui-designer'])
  assert.deepEqual(repair.experts, ['engineering-code-reviewer', 'design-ui-designer'])
})

check('summary and progress: 85% for the graph, 15% for integration', () => {
  const { tasks } = normalizeGraph([{ title: 'a', brief: 'a' }, { title: 'b', brief: 'b' }])
  tasks[0].state = 'completed'
  const totals = stateSummary(tasks)
  assert.equal(totals.total, 2)
  assert.equal(totals.settled, 1)
  assert.equal(progressPercent(tasks, 'running'), 43)
  assert.equal(progressPercent(tasks, 'settled'), 58)
})

check('attempt tokens are stable and monotonic', () => {
  assert.equal(attemptToken('t1', 1), 't1-a1')
  assert.equal(attemptToken('t1', 2), 't1-a2')
})

check('validateGraph reports nothing for a valid graph', () => {
  const { tasks } = normalizeGraph([{ title: 'a', brief: 'a' }, { title: 'b', brief: 'b', dependsOn: ['t1'] }])
  assert.deepEqual(validateGraph(tasks).problems, [])
})

console.log(`ok  graph.test.mjs (${checks} checks)`)

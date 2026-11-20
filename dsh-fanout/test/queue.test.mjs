/**
 * queue.test.mjs — the single-queue rules: write claims, admission, appends.
 *
 * Plain node, no framework: throw on failure, print one `ok` line per check.
 */

import assert from 'node:assert/strict'

import { normalizeGraph } from '../lib/graph.js'
import {
  admit,
  appendTasks,
  claimsConflict,
  claimsOf,
  claimsOverlap,
  findQueueRun,
  normalizeClaim,
  queueView,
} from '../lib/queue.js'

let checks = 0
function check(name, fn) {
  fn()
  checks += 1
  console.log(`ok  queue · ${name}`)
}

function task(patch) {
  const { tasks } = normalizeGraph([{ title: patch.id ?? 'job', brief: 'b', ...patch }])
  return Object.assign(tasks[0], patch.state === undefined ? {} : { state: patch.state })
}

check('claims normalise separators, dot segments and case', () => {
  assert.equal(normalizeClaim('src\\render\\Terrain.ts'), 'src/render/terrain.ts')
  assert.equal(normalizeClaim('./src//render/'), 'src/render')
  assert.equal(normalizeClaim('src/render/../core/a.ts'), 'src/core/a.ts')
  assert.equal(normalizeClaim('   '), '')
  assert.equal(normalizeClaim(undefined), '')
})

check('claimsOf unions scope and inScope, sorted and de-duplicated', () => {
  const value = task({ id: 'a', scope: ['src/render'], inScope: ['src/render', 'tests/x.mjs'] })
  assert.deepEqual(claimsOf(value), ['src/render', 'tests/x.mjs'])
  assert.deepEqual(claimsOf(task({ id: 'b' })), [])
})

check('overlap is prefix-aware, not a bare string prefix', () => {
  assert.equal(claimsOverlap('src/render', 'src/render/terrain.ts'), true)
  assert.equal(claimsOverlap('src/render', 'src/render'), true)
  assert.equal(claimsOverlap('src/foo', 'src/foobar'), false)
  assert.equal(claimsOverlap('src', 'tests'), false)
})

check('claimsConflict names the path and the holder', () => {
  const hit = claimsConflict(['src/render'], ['src/render/terrain.ts'])
  assert.equal(hit.path, 'src/render/terrain.ts')
  assert.equal(claimsConflict(['src'], ['tests']), undefined)
})

check('a second task claiming the same path is deferred, not started', () => {
  const first = task({ id: 'a', scope: ['src/render'], state: 'running' })
  const second = task({ id: 'b', scope: ['src/render/terrain.ts'] })
  const plan = admit([second], { running: [first], limit: 4 })
  assert.deepEqual(plan.admitted, [])
  assert.equal(plan.deferred.length, 1)
  assert.equal(plan.deferred[0].reason, 'write-scope')
  assert.deepEqual(plan.deferred[0].blockedBy, ['a'])
  assert.equal(plan.deferred[0].path, 'src/render/terrain.ts')
})

check('disjoint claims start together', () => {
  const first = task({ id: 'a', scope: ['src/render'], state: 'running' })
  const second = task({ id: 'b', scope: ['src/sim'] })
  const third = task({ id: 'c', scope: ['docs'] })
  const plan = admit([second, third], { running: [first], limit: 4 })
  assert.deepEqual(plan.admitted.map((item) => item.id), ['b', 'c'])
  assert.deepEqual(plan.deferred, [])
})

check('two ready tasks with one shared path are serialised by the same plan', () => {
  const a = task({ id: 'a', scope: ['src/shared.ts'] })
  const b = task({ id: 'b', scope: ['src/shared.ts'] })
  const plan = admit([a, b], { limit: 4 })
  assert.deepEqual(plan.admitted.map((item) => item.id), ['a'])
  assert.deepEqual(plan.deferred[0].blockedBy, ['a'])
})

check('the concurrency limit is reported separately from a scope wait', () => {
  const plan = admit([task({ id: 'a' }), task({ id: 'b' })], { limit: 1 })
  assert.deepEqual(plan.admitted.map((item) => item.id), ['a'])
  assert.equal(plan.deferred[0].reason, 'concurrency-limit')
})

check('undeclared work keeps running in parallel unless serialisation is asked for', () => {
  const plan = admit([task({ id: 'a' }), task({ id: 'b' })], { limit: 4 })
  assert.equal(plan.admitted.length, 2)
  const strict = admit([task({ id: 'a' }), task({ id: 'b' })], { limit: 4, serializeUnclaimed: true })
  assert.equal(strict.admitted.length, 1)
  assert.equal(strict.deferred[0].reason, 'write-scope')
})

check('appendTasks keeps existing ids and lets new work depend on the live queue', () => {
  const existing = normalizeGraph([{ title: 'first', brief: 'x', scope: ['src/a.ts'] }]).tasks
  existing.scope = []
  existing[0].scope = ['src/a.ts']
  const result = appendTasks(existing, [
    { title: 'second', brief: 'y', scope: ['src/b.ts'], dependsOn: ['t1'] },
    { id: 't1', title: 'collides with t1', brief: 'z' },
  ])
  assert.deepEqual(result.problems, [])
  assert.equal(result.tasks.length, 3)
  assert.equal(result.added[0].id, 't2')
  assert.deepEqual(result.added[0].deps, ['t1'])
  assert.equal(result.added[1].id, 't3', 'an id already in use must not be reused')
  assert.deepEqual(result.tasks[0].scope, ['src/a.ts'])
})

check('appendTasks is atomic: a cycle leaves the queue untouched', () => {
  const existing = normalizeGraph([{ id: 'a', title: 'a', brief: 'a' }]).tasks
  const before = JSON.stringify(existing)
  const result = appendTasks(existing, [
    { id: 'b', title: 'b', brief: 'b', dependsOn: ['a'] },
    { id: 'a', title: 'dup', brief: 'dup', dependsOn: ['b'] },
  ])
  assert.equal(JSON.stringify(existing), before, 'the existing queue must not be mutated')
  const cyclic = appendTasks(normalizeGraph([{ id: 'a', title: 'a', brief: 'a', dependsOn: [] }]).tasks, [
    { id: 'b', title: 'b', brief: 'b', dependsOn: ['b'] },
  ])
  assert.ok(cyclic.problems.some((problem) => problem.includes('cannot depend on itself')), cyclic.problems.join('; '))
})

check('appendTasks rejects a quality contract that cannot be verified', () => {
  const existing = normalizeGraph([{ title: 'a', brief: 'a' }]).tasks
  const result = appendTasks(existing, [{ title: 'impl', brief: 'b', kind: 'implementation', acceptance: ['works'] }])
  assert.equal(result.added.length, 0)
  assert.ok(result.problems.some((problem) => problem.includes('verify command')), result.problems.join('; '))
})

check('appendTasks refuses to exceed the queue cap', () => {
  const existing = normalizeGraph(Array.from({ length: 24 }, (_, index) => ({ title: `t${index}`, brief: 'b' }))).tasks
  const result = appendTasks(existing, [{ title: 'one more', brief: 'b' }])
  assert.equal(result.tasks.length, 24)
  assert.ok(result.problems.some((problem) => problem.includes('capped')))
})

check('queueView shows the blocked task, the holder path and undeclared work', () => {
  const tasks = normalizeGraph([
    { id: 'a', title: 'a', brief: 'a', scope: ['src/render'] },
    { id: 'b', title: 'b', brief: 'b', scope: ['src/render/terrain.ts'] },
    { id: 'c', title: 'c', brief: 'c' },
  ]).tasks
  tasks[0].state = 'running'
  const view = queueView(tasks)
  assert.deepEqual(view.running, ['a'])
  assert.deepEqual(view.ready, ['c'])
  assert.deepEqual(view.scope_blocked, [{ id: 'b', blocked_by: ['a'], path: 'src/render/terrain.ts' }])
  assert.deepEqual(view.unclaimed, ['c'])
  assert.ok(view.hint.length > 0)
})

check('findQueueRun picks the newest live run for the workspace and nothing else', () => {
  const runs = [
    { id: 'old', status: 'running', cwd: 'C:\\w\\repo', createdAt: 1 },
    { id: 'new', status: 'running', cwd: 'C:\\w\\repo\\', createdAt: 9 },
    { id: 'other', status: 'running', cwd: 'C:\\w\\elsewhere', createdAt: 99 },
    { id: 'done', status: 'completed', cwd: 'C:\\w\\repo', createdAt: 50 },
    { id: 'paused', status: 'paused', cwd: 'c:/w/repo', createdAt: 5 },
  ]
  assert.equal(findQueueRun(runs, 'C:\\w\\repo').id, 'new')
  assert.equal(findQueueRun(runs, '/unknown'), undefined)
  assert.equal(findQueueRun([], 'C:\\w\\repo'), undefined)
})

check('a run with a narrower workspace path is not the queue of a sibling directory', () => {
  const runs = [{ id: 'deep', status: 'running', cwd: '/w/repo/sub', createdAt: 3 }]
  assert.equal(findQueueRun(runs, '/w/repo'), undefined)
  assert.equal(findQueueRun(runs, '/w/repo/sub').id, 'deep')
})

console.log(`ok  queue.test.mjs (${checks} checks)`)

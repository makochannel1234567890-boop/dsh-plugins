/**
 * lib/worktree — the Host face behind the panel's only checkout control.
 *
 * The rules under test keep one owner honest: an unmounted service is reported
 * as unavailable (never as a branch), the base ref is trimmed and bounded, and
 * the service's own failure message survives instead of becoming "failed".
 */

import assert from 'node:assert/strict'

import { checkoutSummary, createWorktreeFace } from '../lib/worktree.js'

let checks = 0
function test(name, run) {
  run()
  checks += 1
  void name
}
async function testAsync(name, run) {
  await run()
  checks += 1
  void name
}

const logged = []
const log = (message) => logged.push(String(message))
const AGENT = { id: 'session-1' }

function ctxWith({ agents, worktrees } = {}) {
  return {
    get(name) {
      if (name === 'agents') return agents
      if (name === 'worktrees') return worktrees
      return undefined
    },
  }
}

const registryOf = () => ({ get: (id) => (id === AGENT.id ? AGENT : undefined) })

function serviceOf(record) {
  const calls = []
  return {
    calls,
    async create(agent, options) {
      calls.push({ agent, options })
      if (record instanceof Error) throw record
      return record
    },
  }
}

const RECORD = {
  path: 'C:/repo/.agents/worktrees/dsh-1a2b3c4d-9e0f',
  branch: 'dsh-1a2b3c4d-9e0f',
  baseCommit: 'a'.repeat(40),
  repositoryRoot: 'C:/repo',
}

test('status reports an unmounted service as unavailable', () => {
  const face = createWorktreeFace(ctxWith(), log)
  assert.deepEqual(face.status(), { ok: true, available: false })
})

test('status reports an available service', () => {
  const face = createWorktreeFace(ctxWith({ worktrees: serviceOf(RECORD) }), log)
  assert.deepEqual(face.status(), { ok: true, available: true })
})

test('an empty session id is refused before any service lookup', async () => {
  const face = createWorktreeFace(ctxWith(), log)
  assert.deepEqual(await face.create('', ''), { ok: false, error: 'session-id-required' })
})

test('a missing agents registry is a named error', async () => {
  const face = createWorktreeFace(ctxWith({ worktrees: serviceOf(RECORD) }), log)
  assert.deepEqual(await face.create(AGENT.id, ''), { ok: false, error: 'agents-unavailable' })
})

test('a session with no live agent is refused', async () => {
  const face = createWorktreeFace(ctxWith({ agents: { get: () => undefined }, worktrees: serviceOf(RECORD) }), log)
  assert.deepEqual(await face.create('other', ''), { ok: false, error: 'no-live-agent' })
})

test('a missing service is a named error, not a checkout', async () => {
  const face = createWorktreeFace(ctxWith({ agents: registryOf() }), log)
  assert.deepEqual(await face.create(AGENT.id, 'main'), { ok: false, error: 'worktree-unavailable' })
})

await testAsync('create forwards a trimmed base ref and returns the record', async () => {
  const service = serviceOf(RECORD)
  const face = createWorktreeFace(ctxWith({ agents: registryOf(), worktrees: service }), log)
  const result = await face.create(AGENT.id, '  main  ')
  assert.deepEqual(result, {
    ok: true,
    branch: RECORD.branch,
    path: RECORD.path,
    baseCommit: RECORD.baseCommit,
    repositoryRoot: RECORD.repositoryRoot,
  })
  assert.equal(service.calls.length, 1)
  assert.equal(service.calls[0].agent, AGENT)
  assert.deepEqual(service.calls[0].options, { from: 'main' })
})

await testAsync('an empty base ref asks the service for HEAD', async () => {
  const service = serviceOf(RECORD)
  const face = createWorktreeFace(ctxWith({ agents: registryOf(), worktrees: service }), log)
  await face.create(AGENT.id, '   ')
  assert.deepEqual(service.calls[0].options, {})
})

await testAsync('the base ref is bounded', async () => {
  const service = serviceOf(RECORD)
  const face = createWorktreeFace(ctxWith({ agents: registryOf(), worktrees: service }), log)
  await face.create(AGENT.id, 'x'.repeat(500))
  assert.equal(service.calls[0].options.from.length, 200)
})

await testAsync('the service failure message survives', async () => {
  const service = serviceOf(new Error("fatal: a branch named 'dsh-1a2b' already exists"))
  const face = createWorktreeFace(ctxWith({ agents: registryOf(), worktrees: service }), log)
  const result = await face.create(AGENT.id, '')
  assert.equal(result.ok, false)
  assert.match(result.error, /already exists/)
  assert.ok(logged.some(line => line.includes('worktree create failed')), 'the fault is logged')
})

await testAsync('an empty service result is an explicit error', async () => {
  const face = createWorktreeFace(ctxWith({ agents: registryOf(), worktrees: serviceOf(null) }), log)
  assert.deepEqual(await face.create(AGENT.id, ''), { ok: false, error: 'worktree-empty-result' })
})

test('checkout summaries ignore junk and clip nothing they cannot read', () => {
  const summary = checkoutSummary({ branch: 'b', path: '/p' })
  assert.deepEqual(summary, { branch: 'b', path: '/p', baseCommit: '', repositoryRoot: '' })
  assert.equal(checkoutSummary(null), null)
  assert.equal(checkoutSummary('nope'), null)
})

console.log(`worktree: ${checks} checks`)

/**
 * lib/team — the Host face behind the panel's only Team switch and task board.
 *
 * The rules under test are the ones that keep the panel honest: a missing
 * service or a stale Session id becomes a named error rather than a silent
 * "off", a throwing service never escapes as a render fault, and task views are
 * copied, bounded, and stripped of fields the board does not render.
 */

import assert from 'node:assert/strict'

import { createTeamFace, MAX_TASKS, taskSummary } from '../lib/team.js'

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

/** A Context stand-in: only the two lazily resolved services exist. */
function ctxWith({ agents, team } = {}) {
  return {
    get(name) {
      if (name === 'agents') return agents
      if (name === 'agentTeams') return team
      return undefined
    },
  }
}

function registryOf(agent) {
  return { get: (id) => (id === AGENT.id ? agent : undefined) }
}

function teamServiceOf({ enabled = false, tasks = [] } = {}) {
  const calls = []
  return {
    calls,
    isEnabled: () => enabled,
    listTasks: () => tasks,
    async setEnabled(agent, next) {
      calls.push({ agent, next })
    },
  }
}

test('an empty session id is refused before any service lookup', () => {
  const face = createTeamFace(ctxWith(), log)
  assert.deepEqual(face.read(''), { ok: false, error: 'session-id-required' })
  assert.deepEqual(face.read(undefined), { ok: false, error: 'session-id-required' })
})

test('a missing agents registry is a named error, not an off state', () => {
  const face = createTeamFace(ctxWith({ team: teamServiceOf() }), log)
  assert.deepEqual(face.read(AGENT.id), { ok: false, error: 'agents-unavailable' })
})

test('a session without a live agent is reported as such', () => {
  const face = createTeamFace(ctxWith({ agents: registryOf(undefined), team: teamServiceOf() }), log)
  assert.deepEqual(face.read('other-session'), { ok: false, error: 'no-live-agent' })
})

test('a missing agentTeams service is a named error', () => {
  const face = createTeamFace(ctxWith({ agents: registryOf(AGENT) }), log)
  assert.deepEqual(face.read(AGENT.id), { ok: false, error: 'team-unavailable' })
})

test('read reports the selection and the current board', () => {
  const tasks = [
    { id: 't1', subject: 'Scaffold', status: 'in_progress', ownerName: 'lead', ownerId: 's1', ready: true, blockedBy: [] },
    { id: 't2', subject: 'Tests', status: 'pending', ownerName: '', ownerId: undefined, ready: false, blockedBy: ['t1', 't9'] },
  ]
  const face = createTeamFace(ctxWith({ agents: registryOf(AGENT), team: teamServiceOf({ enabled: true, tasks }) }), log)
  const view = face.read(AGENT.id)
  assert.equal(view.ok, true)
  assert.equal(view.enabled, true)
  assert.deepEqual(view.tasks, [
    { id: 't1', subject: 'Scaffold', status: 'in_progress', owner: 'lead', ownerId: 's1', ready: true, blocked: 0 },
    { id: 't2', subject: 'Tests', status: 'pending', owner: '', ownerId: '', ready: false, blocked: 2 },
  ])
})

test('the board is capped and junk entries are dropped', () => {
  const tasks = [{ id: 'bad' }]
  for (let i = 0; i < MAX_TASKS + 25; i += 1) tasks.push({ id: `t${i}`, subject: `task ${i}`, status: 'pending' })
  tasks.push(null, 'nope', 42)
  const face = createTeamFace(ctxWith({ agents: registryOf(AGENT), team: teamServiceOf({ tasks }) }), log)
  const view = face.read(AGENT.id)
  assert.equal(view.ok, true)
  assert.equal(view.tasks.length, MAX_TASKS)
  assert.equal(view.tasks[0].id, 'bad')
  assert.equal(view.tasks[0].status, 'pending')
})

test('a throwing service is contained as team-read-failed', () => {
  const team = {
    isEnabled() { throw new Error('boom') },
    listTasks() { return [] },
    async setEnabled() {},
  }
  const face = createTeamFace(ctxWith({ agents: registryOf(AGENT), team }), log)
  assert.deepEqual(face.read(AGENT.id), { ok: false, error: 'team-read-failed' })
  assert.ok(logged.some(line => line.includes('team read failed')), 'the fault is logged')
})

await testAsync('setEnabled persists through the service', async () => {
  const team = teamServiceOf()
  const face = createTeamFace(ctxWith({ agents: registryOf(AGENT), team }), log)
  assert.deepEqual(await face.setEnabled(AGENT.id, true), { ok: true, enabled: true })
  assert.equal(team.calls.length, 1)
  assert.equal(team.calls[0].agent, AGENT)
  assert.equal(team.calls[0].next, true)
})

await testAsync('setEnabled normalizes a non-true value to false', async () => {
  const team = teamServiceOf()
  const face = createTeamFace(ctxWith({ agents: registryOf(AGENT), team }), log)
  assert.deepEqual(await face.setEnabled(AGENT.id, 'yes'), { ok: true, enabled: false })
  assert.equal(team.calls[0].next, false)
})

await testAsync('a rejected persistence is reported, never swallowed', async () => {
  const team = {
    isEnabled: () => false,
    listTasks: () => [],
    async setEnabled() { throw new Error('persist failed') },
  }
  const face = createTeamFace(ctxWith({ agents: registryOf(AGENT), team }), log)
  assert.deepEqual(await face.setEnabled(AGENT.id, true), { ok: false, error: 'team-write-failed' })
  assert.ok(logged.some(line => line.includes('setEnabled failed')), 'the fault is logged')
})

test('task summaries clip long labels and tolerate missing arrays', () => {
  const long = 'x'.repeat(400)
  const summary = taskSummary({ id: 't1', subject: long, ownerName: long })
  assert.equal(summary.subject.length, 200)
  assert.ok(summary.subject.endsWith('…'))
  assert.equal(summary.blocked, 0)
  assert.equal(taskSummary(null), null)
  assert.equal(taskSummary('nope'), null)
})

console.log(`team: ${checks} checks`)

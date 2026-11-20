import assert from 'node:assert/strict'
import test from 'node:test'

import {
  autoResumeTargets,
  buildResumePlan,
  collectTargets,
  indexFanoutRuns,
  sessionsOfUnfinishedRuns,
  KIND_FANOUT_CALLER,
  KIND_FANOUT_INTEGRATOR,
  KIND_FANOUT_REVIEW,
  KIND_FANOUT_WORKER,
  KIND_PLAIN,
} from '../lib/resume-plan.js'

// The two sessions that actually stayed down on this machine.
const CALLER = 'session-4f68a0b0-96f8-488c-b50b-e94e881760ac'
const WORKER = 'session-2bcfa281-55d2-4c7b-82be-ed8c1684e5a8'

const runs = [
  {
    id: 'run-caller-1',
    status: 'stopped',
    objective: 'UE build check',
    cwd: 'C:\\UE',
    callerSessionId: CALLER,
    sessions: [{ id: 'session-worker-in-caller-run', role: 'task', taskId: 't1', attemptId: 't1-a1', state: 'settled' }],
  },
  {
    id: 'run-worker-1',
    status: 'failed',
    objective: 'UE level audit',
    cwd: 'C:\\UE',
    callerSessionId: 'session-someone-else',
    sessions: [{ id: WORKER, role: 'task', taskId: 't2', attemptId: 't2-a1-92b9', state: 'settled', cause: 'turn-end' }],
  },
]

test('a worker is classified with its run, task and attempt', () => {
  const index = indexFanoutRuns(runs)
  const entry = index.get(WORKER)
  assert.equal(entry.kind, KIND_FANOUT_WORKER)
  assert.equal(entry.runId, 'run-worker-1')
  assert.equal(entry.taskId, 't2')
  assert.equal(entry.attemptId, 't2-a1-92b9')
})

test('a caller keeps every run it started', () => {
  const index = indexFanoutRuns(
    [
      runs[0],
      { ...runs[0], id: 'run-caller-2', sessions: [] },
      { ...runs[0], id: 'run-caller-3', sessions: [] },
    ],
  )
  const entry = index.get(CALLER)
  assert.equal(entry.kind, KIND_FANOUT_CALLER)
  assert.deepEqual(entry.runIds, ['run-caller-1', 'run-caller-2', 'run-caller-3'])
})

test('review and integrator roles are distinguished from workers', () => {
  const index = indexFanoutRuns([
    {
      id: 'run-x',
      status: 'running',
      sessions: [
        { id: 's-review', role: 'review' },
        { id: 's-integrator', role: 'integrator' },
      ],
    },
  ])
  assert.equal(index.get('s-review').kind, KIND_FANOUT_REVIEW)
  assert.equal(index.get('s-integrator').kind, KIND_FANOUT_INTEGRATOR)
})

test('a session that is both caller and worker is treated as the worker', () => {
  const index = indexFanoutRuns([
    { id: 'run-a', status: 'running', callerSessionId: 's-both', sessions: [] },
    { id: 'run-b', status: 'running', callerSessionId: 's-other', sessions: [{ id: 's-both', role: 'task' }] },
  ])
  const entry = index.get('s-both')
  assert.equal(entry.kind, KIND_FANOUT_WORKER)
  assert.equal(entry.runId, 'run-b')
})

test('workers resume before callers, which resume before plain sessions', () => {
  const { plan } = buildResumePlan({
    sessions: [
      { sessionId: CALLER, running: false },
      { sessionId: WORKER, running: false },
      { sessionId: 'session-plain', running: false },
    ],
    runs,
    targetIds: [CALLER, WORKER, 'session-plain'],
  })
  assert.deepEqual(
    plan.map((item) => item.kind),
    [KIND_FANOUT_WORKER, KIND_FANOUT_CALLER, KIND_PLAIN],
  )
})

test('running, invisible, subagent and excluded sessions are skipped with a reason', () => {
  const { plan, skipped } = buildResumePlan({
    sessions: [
      { sessionId: 's-running', running: true },
      { sessionId: 's-sub', running: false, origin: 'subagent' },
      { sessionId: 's-excluded', running: false },
      { sessionId: 's-ok', running: false },
    ],
    runs: [],
    targetIds: ['s-running', 's-sub', 's-excluded', 's-ok', 's-missing', ''],
    excludeIds: ['s-excluded'],
  })
  assert.deepEqual(plan.map((item) => item.sessionId), ['s-ok'])
  const reasons = Object.fromEntries(skipped.map((item) => [item.sessionId, item.reason]))
  assert.deepEqual(reasons, {
    's-running': 'already-running',
    's-sub': 'subagent',
    's-excluded': 'excluded',
    's-missing': 'not-visible',
  })
})

test('subagents can be included explicitly', () => {
  const { plan } = buildResumePlan({
    sessions: [{ sessionId: 's-sub', running: false, origin: 'subagent' }],
    runs: [],
    targetIds: ['s-sub'],
    includeSubagents: true,
  })
  assert.equal(plan.length, 1)
})

test('targets merge both stop records plus the journal without duplicates', () => {
  const targets = collectTargets({
    running: ['a', 'b'],
    risky: ['b', 'c'],
    stoppedByBus: ['c', 'd'],
    stoppedByBundle: ['d', 'a', ''],
  })
  assert.deepEqual(targets, ['a', 'b', 'c', 'd'])
})

test('the plan carries the caller cwd so a supervisor can be started there', () => {
  const { plan } = buildResumePlan({
    sessions: [{ sessionId: CALLER, running: false, cwd: 'C:\\UE' }],
    runs,
    targetIds: [CALLER],
  })
  assert.equal(plan[0].cwd, 'C:\\UE')
  assert.equal(plan[0].objective, 'UE build check')
})

test('sessions of an unfinished run are candidates even without a stop record', () => {
  const members = sessionsOfUnfinishedRuns(
    [
      { id: 'run-stopped', status: 'stopped', createdAt: 1000, callerSessionId: CALLER, sessions: [{ id: WORKER }] },
      { id: 'run-failed', status: 'failed', createdAt: 1000, callerSessionId: 'session-x', sessions: [] },
      { id: 'run-done', status: 'completed', createdAt: 1000, callerSessionId: 'session-y', sessions: [{ id: 's-done' }] },
      { id: 'run-running', status: 'running', createdAt: 1000, callerSessionId: 'session-z', sessions: [] },
    ],
    { now: 2000, maxAgeMs: 60_000 },
  )
  assert.deepEqual(members, [WORKER, CALLER, 'session-x'])
})

test('settled and cancelled run members are not revived, but the caller is', () => {
  const members = sessionsOfUnfinishedRuns(
    [
      {
        id: 'run-dead',
        status: 'failed',
        createdAt: 1000,
        callerSessionId: CALLER,
        sessions: [
          { id: 's-settled', role: 'task', state: 'settled', cause: 'turn-end' },
          { id: 's-cancelled', role: 'task', state: 'cancelled' },
          { id: WORKER, role: 'task', state: 'running' },
        ],
      },
    ],
    { now: 2000, maxAgeMs: 60_000 },
  )
  assert.deepEqual(members, [WORKER, CALLER])
})

test('includeSettled restores the whole-run behaviour for a deliberate sweep', () => {
  const members = sessionsOfUnfinishedRuns(
    [
      {
        id: 'run-dead',
        status: 'failed',
        createdAt: 1000,
        callerSessionId: CALLER,
        sessions: [{ id: 's-settled', role: 'task', state: 'settled' }],
      },
    ],
    { now: 2000, maxAgeMs: 60_000, includeSettled: true },
  )
  assert.deepEqual(members, ['s-settled', CALLER])
})

test('the incident shape: a dead run with 20 settled workers contributes nothing but its caller', () => {
  const workers = Array.from({ length: 20 }, (_, index) => ({
    id: `session-worker-${index}`,
    role: 'task',
    taskId: `t${index}`,
    state: 'settled',
    cause: 'turn-end',
  }))
  const members = sessionsOfUnfinishedRuns(
    [{ id: 'run-20261118222937-kvnn', status: 'failed', createdAt: 1000, updatedAt: 1000, callerSessionId: CALLER, sessions: workers }],
    { now: 2000, maxAgeMs: 60_000 },
  )
  assert.deepEqual(members, [CALLER])
})

test('an unfinished run older than the window is not revived', () => {
  const members = sessionsOfUnfinishedRuns(
    [{ id: 'run-old', status: 'failed', createdAt: 1, sessions: [{ id: 's-old' }] }],
    { now: 10_000_000, maxAgeMs: 60_000 },
  )
  assert.deepEqual(members, [])
})

test('run members join the target set last, deduped', () => {
  const targets = collectTargets({
    running: ['a'],
    stoppedByBundle: ['a'],
    runMembers: ['b', 'a', 'c'],
  })
  assert.deepEqual(targets, ['a', 'b', 'c'])
})

test('a plain restart with nothing interrupted does not revive old run members', () => {
  const { targets, interrupted, runMembers } = autoResumeTargets({
    running: [],
    risky: [],
    stoppedByBus: [],
    stoppedByBundle: [],
    runs: [
      {
        id: 'run-old',
        status: 'failed',
        createdAt: 1000,
        updatedAt: 1000,
        callerSessionId: CALLER,
        sessions: [{ id: WORKER, role: 'task', state: 'running' }],
      },
    ],
    maxRunAgeMs: 60_000,
    now: 2000,
  })
  assert.deepEqual(targets, [])
  assert.equal(interrupted, 0)
  assert.equal(runMembers, 0)
})

test('an interrupted session brings the unfinished-run members with it', () => {
  const { targets, interrupted, runMembers } = autoResumeTargets({
    running: ['session-running'],
    risky: [],
    stoppedByBus: [],
    stoppedByBundle: [],
    runs: [
      {
        id: 'run-x',
        status: 'failed',
        createdAt: 1000,
        updatedAt: 1000,
        callerSessionId: CALLER,
        sessions: [{ id: WORKER, role: 'task', state: 'running' }],
      },
    ],
    maxRunAgeMs: 60_000,
    now: 2000,
  })
  assert.deepEqual(targets, ['session-running', WORKER, CALLER])
  assert.equal(interrupted, 1)
  assert.equal(runMembers, 2)
})

test('a fresh stop record is enough to start an automatic sweep', () => {
  const { targets, interrupted } = autoResumeTargets({
    running: [],
    risky: [],
    stoppedByBus: ['session-stopped'],
    stoppedByBundle: [],
    runs: [],
    maxRunAgeMs: 60_000,
    now: 2000,
  })
  assert.deepEqual(targets, ['session-stopped'])
  assert.equal(interrupted, 1)
})



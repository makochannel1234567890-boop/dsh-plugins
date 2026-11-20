import assert from 'node:assert/strict'
import test from 'node:test'

import { classifyBoot, KIND_CLEAN, KIND_CRASH, KIND_FOREIGN_PROFILE, KIND_NONE, KIND_STALE } from '../lib/detect.js'

const NOW = 1_800_000_000_000

function journal(overrides = {}) {
  return {
    schema: 1,
    bootId: 'boot-1',
    pid: 4242,
    profile: 'desktop',
    startedAt: NOW - 600_000,
    heartbeatAt: NOW - 30_000,
    clean: false,
    riskySessions: ['session-a'],
    runningSessions: ['session-a', 'session-b'],
    fanoutRuns: ['run-1'],
    ...overrides,
  }
}

test('missing journal is a first run, not a crash', () => {
  const decision = classifyBoot(undefined, { now: NOW })
  assert.equal(decision.kind, KIND_NONE)
})

test('malformed journal is ignored instead of guessed at', () => {
  assert.equal(classifyBoot('nope', { now: NOW }).kind, KIND_NONE)
  assert.equal(classifyBoot({ pid: 1 }, { now: NOW }).kind, KIND_NONE)
})

test('a recorded clean shutdown is not a crash', () => {
  const decision = classifyBoot(journal({ clean: true, exitReason: 'plugin-unload' }), { now: NOW })
  assert.equal(decision.kind, KIND_CLEAN)
  assert.match(decision.reason, /plugin-unload/)
})

test('dirty shutdown is a crash and carries the observed activity', () => {
  const decision = classifyBoot(journal(), { now: NOW })
  assert.equal(decision.kind, KIND_CRASH)
  assert.deepEqual(decision.risky, ['session-a'])
  assert.deepEqual(decision.running, ['session-a', 'session-b'])
  assert.deepEqual(decision.runs, ['run-1'])
  assert.equal(decision.crashId, `boot-1@${NOW - 30_000}`)
  assert.equal(decision.supervised, true)
})

test('a crash with nothing running must not spawn an empty supervisor', () => {
  const decision = classifyBoot(
    journal({ riskySessions: [], runningSessions: [], fanoutRuns: [] }),
    { now: NOW },
  )
  assert.equal(decision.kind, KIND_CRASH)
  assert.equal(decision.supervised, false)
})

test('a journal from another profile is never acted on', () => {
  const decision = classifyBoot(journal({ clean: false }), { now: NOW, profile: 'other-profile' })
  assert.equal(decision.kind, KIND_FOREIGN_PROFILE)
})

test('a journal older than the horizon is reported but not acted on', () => {
  const decision = classifyBoot(journal({ heartbeatAt: NOW - 10 * 24 * 60 * 60 * 1000 }), {
    now: NOW,
    maxAgeMs: 7 * 24 * 60 * 60 * 1000,
  })
  assert.equal(decision.kind, KIND_STALE)
})

test('duplicate and malformed ids collapse', () => {
  const decision = classifyBoot(
    journal({ riskySessions: ['a', 'a', '', 7, { sessionId: 'b' }, null], runningSessions: ['a'] }),
    { now: NOW },
  )
  assert.deepEqual(decision.risky, ['a', 'b'])
})

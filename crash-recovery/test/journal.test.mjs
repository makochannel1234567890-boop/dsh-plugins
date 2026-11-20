import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { CrashJournal } from '../lib/journal.js'

function tempJournal() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'crash-recovery-'))
  return { dir, journal: new CrashJournal(dir), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('a started journal is not clean and is readable by the next boot', () => {
  const { journal, cleanup } = tempJournal()
  try {
    const state = journal.start({ profile: 'desktop' })
    assert.equal(state.clean, false)
    const previous = journal.readPrevious()
    assert.equal(previous.bootId, state.bootId)
    assert.equal(previous.pid, process.pid)
    assert.equal(previous.profile, 'desktop')
    assert.equal(previous.clean, false)
  } finally {
    cleanup()
  }
})

test('markClean records why the process stopped', () => {
  const { journal, cleanup } = tempJournal()
  try {
    journal.start({})
    journal.markClean('plugin-unload')
    const previous = journal.readPrevious()
    assert.equal(previous.clean, true)
    assert.equal(previous.exitReason, 'plugin-unload')
    assert.ok(previous.exitedAt > 0)
  } finally {
    cleanup()
  }
})

test('the supervisor slot is exclusive across racing boots', () => {
  const { journal, cleanup } = tempJournal()
  try {
    journal.start({})
    const first = journal.claimSupervisor({ crashId: 'boot-1@100' })
    assert.equal(first.claimed, true)
    const second = new CrashJournal(journal.dir).claimSupervisor({ crashId: 'boot-1@100' })
    assert.equal(second.claimed, false)
    assert.equal(second.existing.crashId, 'boot-1@100')
  } finally {
    cleanup()
  }
})

test('releasing the slot lets a retry claim it again', () => {
  const { journal, cleanup } = tempJournal()
  try {
    journal.start({})
    journal.claimSupervisor({ crashId: 'c1' })
    journal.clearClaim()
    assert.equal(existsSync(journal.claimFile), false)
    assert.equal(journal.claimSupervisor({ crashId: 'c1' }).claimed, true)
  } finally {
    cleanup()
  }
})

test('beat refreshes the heartbeat and dedupes the observed sets', () => {
  const { journal, cleanup } = tempJournal()
  try {
    journal.start({})
    const before = journal.state.heartbeatAt
    journal.beat({ runningSessions: ['a', 'a', 'b'], fanoutRuns: ['r1'], supervisorSessionId: 'sup-1' })
    assert.ok(journal.state.heartbeatAt >= before)
    assert.deepEqual(journal.state.runningSessions, ['a', 'b'])
    assert.deepEqual(journal.state.fanoutRuns, ['r1'])
    assert.equal(journal.state.supervisorSessionId, 'sup-1')
  } finally {
    cleanup()
  }
})

test('a risky tool call is recorded once per session', () => {
  const { journal, cleanup } = tempJournal()
  try {
    journal.start({})
    journal.markRisky('session-a', 'desktop_type')
    journal.markRisky('session-a', 'desktop_key')
    journal.markRisky('', 'power_action')
    assert.deepEqual(journal.state.riskySessions, ['session-a'])
  } finally {
    cleanup()
  }
})

test('the ledger appends one JSON line per event', () => {
  const { journal, cleanup } = tempJournal()
  try {
    journal.start({})
    journal.record({ event: 'crash-detected', crashId: 'c1' })
    journal.record({ event: 'resume', resumed: 2 })
    const lines = readFileSync(journal.ledgerFile, 'utf8').trim().split('\n')
    assert.equal(lines.length, 2)
    assert.equal(JSON.parse(lines[0]).event, 'crash-detected')
    assert.equal(JSON.parse(lines[1]).resumed, 2)
    assert.ok(JSON.parse(lines[1]).at > 0)
  } finally {
    cleanup()
  }
})

test('recentResumes lists sessions a previous boot already re-prompted, newest first', () => {
  const { journal, cleanup } = tempJournal()
  try {
    journal.start({})
    journal.record({ event: 'resume', resumed: [{ sessionId: 'session-a' }, { sessionId: 'session-b' }] })
    journal.record({ event: 'resume-start', plan: [{ id: 'session-c', kind: 'fanout-worker' }, { id: 'session-d' }] })
    const recent = journal.recentResumes(30 * 60 * 1000)
    assert.deepEqual(recent.sessionIds, ['session-c', 'session-d', 'session-a', 'session-b'])
    assert.equal(recent.count, 2)
    assert.ok(recent.at > 0)
  } finally {
    cleanup()
  }
})

test('recentResumes ignores records older than the cooldown window', () => {
  const { journal, cleanup } = tempJournal()
  try {
    journal.start({})
    journal.record({ event: 'resume', plan: [{ id: 'session-old' }] })
    const afterWindow = Date.now() + 60 * 60 * 1000
    const recent = journal.recentResumes(30 * 60 * 1000, afterWindow)
    assert.deepEqual(recent.sessionIds, [])
    assert.equal(recent.count, 0)
    assert.equal(recent.at, 0)
  } finally {
    cleanup()
  }
})

test('a missing ledger is not an error for recentResumes', () => {
  const { journal, cleanup } = tempJournal()
  try {
    const recent = journal.recentResumes()
    assert.deepEqual(recent.sessionIds, [])
  } finally {
    cleanup()
  }
})

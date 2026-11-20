import { test } from 'node:test'
import assert from 'node:assert/strict'

import { controlTool } from '../index.js'

const SELF = 'session-self-0000'

/**
 * 実ハーネス抜きで stop / stop_all / resume_all の安全弁を検証する。
 */
function harness({ running = [], record = { sessionIds: [] } } = {}) {
  const cancelled = []
  const prompted = []
  const saved = []
  const controller = {
    async list() {
      return {
        items: running.map((entry) => ({
          sessionId: entry.id,
          running: entry.running !== false,
          cwd: 'C:\\work',
          origin: 'user',
        })),
      }
    },
    cancel({ sessionId }) {
      cancelled.push(sessionId)
    },
    async prompt(request) {
      prompted.push(request.sessionId)
    },
  }
  const ctx = { get: (name) => (name === 'sessionController' ? controller : undefined) }
  const store = {
    config: { allowControl: true, resumePrompt: 'resume now' },
    async loadControl() {
      return record
    },
    async saveControl(next) {
      saved.push(next)
    },
  }
  const tool = controlTool(ctx, store)
  return {
    cancelled,
    prompted,
    saved,
    run: (args) => tool.execute(args, { agent: { id: SELF } }),
  }
}

const A = { id: 'session-aaaaaaaa-1111-2222', running: true }
const B = { id: 'session-bbbbbbbb-3333-4444', running: true }

test('stop_all は confirm が無ければ拒否し、1件も止めない', async () => {
  const h = harness({ running: [A, B] })
  const result = await h.run({ action: 'stop_all' })
  assert.equal(result.ok, false)
  assert.equal(result.refused, true)
  assert.equal(result.code, 'STOP_ALL_NOT_CONFIRMED')
  assert.equal(h.cancelled.length, 0)
})

test('stop_all は reason が短すぎると拒否する', async () => {
  const h = harness({ running: [A] })
  const result = await h.run({ action: 'stop_all', confirm: 'STOP_ALL_SESSIONS', reason: 'x' })
  assert.equal(result.code, 'STOP_ALL_NO_REASON')
  assert.equal(h.cancelled.length, 0)
})

test('stop_all は confirm と reason が揃ったときだけ実行し、記録に理由を残す', async () => {
  const h = harness({ running: [A, B] })
  const result = await h.run({
    action: 'stop_all',
    confirm: 'STOP_ALL_SESSIONS',
    reason: 'ユーザー承認済みの一斉停止',
  })
  assert.equal(result.ok, true)
  assert.deepEqual(h.cancelled, [A.id, B.id])
  assert.equal(h.saved.at(-1).lastReason, 'ユーザー承認済みの一斉停止')
})

test('stop は対象の sessionIds が無いと拒否する', async () => {
  const h = harness({ running: [A, B] })
  const result = await h.run({ action: 'stop', reason: '理由は十分に長い' })
  assert.equal(result.code, 'SESSION_STOP_NO_TARGETS')
  assert.equal(h.cancelled.length, 0)
})

test('stop は reason が無いと拒否する', async () => {
  const h = harness({ running: [A] })
  const result = await h.run({ action: 'stop', sessionIds: [A.id] })
  assert.equal(result.code, 'SESSION_STOP_NO_REASON')
  assert.equal(h.cancelled.length, 0)
})

test('stop は指定したセッションだけを止める（最小権限）', async () => {
  const h = harness({ running: [A, B] })
  const result = await h.run({
    action: 'stop',
    sessionIds: ['aaaaaaaa-111'],
    reason: 'このセッションだけ止める',
  })
  assert.equal(result.ok, true)
  assert.deepEqual(h.cancelled, [A.id])
  assert.equal(result.stopped.length, 1)
})

test('stop の dryRun は何も止めずに対象を返す', async () => {
  const h = harness({ running: [A, B] })
  const result = await h.run({ action: 'stop', sessionIds: [A.id], reason: '確認のための下見だけ', dryRun: true })
  assert.equal(result.dryRun, true)
  assert.equal(result.wouldStop.length, 1)
  assert.equal(h.cancelled.length, 0)
})

test('stop は見えない id だけなら拒否する', async () => {
  const h = harness({ running: [A] })
  const result = await h.run({ action: 'stop', sessionIds: ['zzzzzzzz'], reason: '理由は十分に長い' })
  assert.equal(result.code, 'SESSION_STOP_NOT_FOUND')
  assert.equal(h.cancelled.length, 0)
})

test('resume_all は sessionIds で絞れ、絞った分だけ記録から外す', async () => {
  const record = { sessionIds: [A.id, B.id] }
  const h = harness({ record })
  const result = await h.run({ action: 'resume_all', sessionIds: ['aaaaaaaa-111'] })
  assert.equal(result.ok, true)
  assert.deepEqual(h.prompted, [A.id])
  assert.deepEqual(h.saved.at(-1).sessionIds, [B.id])
})

test('resume_all は残りを保持する（記録を空にしない）', async () => {
  const record = { sessionIds: [A.id] }
  const h = harness({ record })
  await h.run({ action: 'resume_all' })
  assert.deepEqual(h.prompted, [A.id])
  assert.deepEqual(h.saved.at(-1).sessionIds, [])
})

test('list は読み取りだけで、停止記録を返す', async () => {
  const record = { sessionIds: [B.id], stoppedAt: 123 }
  const h = harness({ running: [A], record })
  const result = await h.run({ action: 'list' })
  assert.equal(result.ok, true)
  assert.equal(result.running.length, 1)
  assert.deepEqual(result.stoppedByBus, ['bbbbbbbb-333'])
  assert.equal(h.cancelled.length, 0)
})

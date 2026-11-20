import assert from 'node:assert/strict'
import test from 'node:test'

import { buildResumePrompt, buildSupervisorBrief } from '../lib/prompts.js'
import {
  KIND_FANOUT_CALLER,
  KIND_FANOUT_INTEGRATOR,
  KIND_FANOUT_REVIEW,
  KIND_FANOUT_WORKER,
  KIND_PLAIN,
} from '../lib/resume-plan.js'

const worker = {
  kind: KIND_FANOUT_WORKER,
  sessionId: 'session-2bcfa281-55d2-4c7b-82be-ed8c1684e5a8',
  runId: 'run-20261117114638-z7l3',
  runIds: ['run-20261117114638-z7l3'],
  runStatus: 'failed',
  objective: 'UE レベル監査',
  cwd: 'C:\\UE',
  taskId: 't2',
  attemptId: 't2-a1-92b9',
}

const caller = {
  kind: KIND_FANOUT_CALLER,
  sessionId: 'session-4f68a0b0-96f8-488c-b50b-e94e881760ac',
  runId: 'run-20261117120137-6iyy',
  runIds: ['run-20261117120137-6iyy', 'run-20261117120158-v94q', 'run-20261117120658-ch9g'],
  runStatus: 'stopped',
  objective: 'UE ビルドとデプロイ',
  cwd: 'C:\\UE',
  taskId: '',
  attemptId: '',
}

test('every prompt says this is a crash recovery and forbids replaying the hung call', () => {
  for (const entry of [worker, caller, { ...worker, kind: KIND_PLAIN }]) {
    const text = buildResumePrompt(entry)
    assert.match(text, /クラッシュ復旧/)
    assert.match(text, /同じコマンドをそのまま撃ち直さず/)
    assert.match(text, /share_progress/)
  }
})

test('a worker gets its run, task and attempt, plus the no-redo rule', () => {
  const text = buildResumePrompt(worker)
  assert.match(text, /run-20261117114638-z7l3/)
  assert.match(text, /t2-a1-92b9/)
  assert.match(text, /やり直さない/)
  assert.match(text, /fanout_control でラン全体を操作しない/)
})

test('a caller is told to inspect status and not to start new runs', () => {
  const text = buildResumePrompt(caller)
  assert.match(text, /fanout_status/)
  assert.match(text, /fanout_control action="resume"/)
  assert.match(text, /新しい fanout_start はしない/)
  assert.match(text, /run-20261117120158-v94q/)
})

test('review and integrator prompts never authorise code edits by themselves', () => {
  const review = buildResumePrompt({ ...worker, kind: KIND_FANOUT_REVIEW })
  assert.match(review, /新しいコード変更はしない/)
  const integrator = buildResumePrompt({ ...worker, kind: KIND_FANOUT_INTEGRATOR })
  assert.match(integrator, /終了コードの表/)
})

test('a plain session is pointed at its working directory', () => {
  const text = buildResumePrompt({ ...worker, kind: KIND_PLAIN, cwd: 'C:\\UE' })
  assert.match(text, /C:\\\\UE|C:\\UE/)
})

test('the report path is threaded into the prompt when supplied', () => {
  const text = buildResumePrompt(worker, { reportPath: '/tmp/report.md' })
  assert.match(text, /\/tmp\/report\.md/)
})

test('the supervisor brief names the crash, the plan and the report file', () => {
  const brief = buildSupervisorBrief({
    crashAt: 1_800_000_000_000,
    reportPath: '/tmp/recovery.md',
    observed: { risky: ['session-a'], running: ['session-a'], fanoutRuns: ['run-1'] },
    planPreview: [{ sessionId: 'session-a', kind: KIND_FANOUT_WORKER, runId: 'run-1' }],
  })
  assert.match(brief, /復旧を監督する唯一のセッション/)
  assert.match(brief, /\/tmp\/recovery\.md/)
  assert.match(brief, /session-a/)
  assert.match(brief, /run-1/)
  assert.match(brief, /新しい fanout_start はしない/)
  assert.match(brief, /破壊的操作/)
})

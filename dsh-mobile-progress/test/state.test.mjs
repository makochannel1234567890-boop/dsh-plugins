import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildUrls,
  clamp,
  cleanUserRequest,
  extractMessageText,
  normalizeStatus,
  normalizeStepStatus,
  normalizeSteps,
  percentFromSteps,
  truncate,
} from '../index.js'

test('clamp keeps values inside the range', () => {
  assert.equal(clamp(5, 0, 10), 5)
  assert.equal(clamp(-3, 0, 10), 0)
  assert.equal(clamp(42, 0, 10), 10)
})

test('truncate only shortens long text and marks the cut', () => {
  assert.equal(truncate('short', 10), 'short')
  assert.equal(truncate('abcdefghij', 5), 'abcd…')
  assert.equal(truncate('   padded  ', 20), 'padded')
  assert.equal(truncate(null, 5), '')
})

test('normalizeStepStatus accepts the common aliases', () => {
  assert.equal(normalizeStepStatus('completed'), 'done')
  assert.equal(normalizeStepStatus('in-progress'), 'in_progress')
  assert.equal(normalizeStepStatus('ACTIVE'), 'in_progress')
  assert.equal(normalizeStepStatus('pending'), 'pending')
  assert.equal(normalizeStepStatus(undefined), 'pending')
})

test('normalizeStatus falls back for unknown values', () => {
  assert.equal(normalizeStatus('done'), 'done')
  assert.equal(normalizeStatus('busy'), 'working')
  assert.equal(normalizeStatus('weird'), 'idle')
  assert.equal(normalizeStatus('weird', 'working'), 'working')
})

test('percentFromSteps derives a stable percentage', () => {
  assert.equal(percentFromSteps([]), null)
  assert.equal(percentFromSteps(undefined), null)
  assert.equal(
    percentFromSteps([
      { status: 'done' },
      { status: 'done' },
      { status: 'in_progress' },
      { status: 'pending' },
    ]),
    63,
  )
  assert.equal(percentFromSteps([{ status: 'done' }, { status: 'done' }]), 100)
  assert.equal(percentFromSteps([{ status: 'pending' }]), 0)
})

test('normalizeSteps filters empty text, caps it, and normalizes status', () => {
  const steps = normalizeSteps([
    { content: 'Design the schema', status: 'completed' },
    { text: '', status: 'pending' },
    null,
    { title: `  ${'x'.repeat(300)}  `, status: 'active' },
  ])
  assert.equal(steps.length, 2)
  assert.equal(steps[0].text, 'Design the schema')
  assert.equal(steps[0].status, 'done')
  assert.equal(steps[1].status, 'in_progress')
  assert.ok(steps[1].text.length <= 160)
})

test('extractMessageText joins text blocks and skips reasoning', () => {
  const text = extractMessageText(
    [
      { type: 'text', text: '第一段落' },
      { type: 'reasoning', text: 'internal' },
      { type: 'text', text: 'second' },
    ],
    100,
  )
  assert.equal(text, '第一段落 second')
  assert.equal(extractMessageText(undefined), '')
})

test('cleanUserRequest keeps human text and drops injected context', () => {
  assert.equal(cleanUserRequest('プラグインを作って'), 'プラグインを作って')
  assert.equal(
    cleanUserRequest('Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n...'),
    '',
  )
  assert.equal(
    cleanUserRequest('依頼です\n\nCurrent runtime context. This snapshot supersedes earlier runtime-context snapshots.\n...'),
    '依頼です',
  )
  assert.equal(cleanUserRequest('（dsh-session-bus）一斉停止が解除されました。'), '')
  assert.equal(cleanUserRequest('依頼です\n\n### セッション間の進捗共有\n- [abc] ...'), '依頼です')
  assert.equal(
    cleanUserRequest(
      'Time sampled while preparing turn 2, step 23: 2026-11-16T23:02:18+09:00\nBrowser time zone for this request: unavailable.',
    ),
    '',
  )
  assert.equal(
    cleanUserRequest('<system-reminder>\nA skill is a reusable set of task-specific instructions.'),
    '',
  )
  assert.equal(
    cleanUserRequest('background job pwsh-1234 (pwsh: ...) finished [status: completed, exit code: 0].'),
    '',
  )
})

test('buildUrls exposes the LAN address and localhost, with an optional token', () => {
  const urls = buildUrls({
    host: '0.0.0.0',
    port: 8790,
    accessToken: '',
    interfaces: ['192.168.1.32', '169.254.1.1'],
  })
  assert.deepEqual(urls, ['http://192.168.1.32:8790/', 'http://127.0.0.1:8790/'])

  const withToken = buildUrls({
    host: '0.0.0.0',
    port: 9000,
    accessToken: 'a b&c',
    interfaces: ['10.0.0.5'],
  })
  assert.equal(withToken[0], 'http://10.0.0.5:9000/?k=a%20b%26c')

  const localOnly = buildUrls({
    host: '127.0.0.1',
    port: 8790,
    accessToken: '',
    interfaces: ['192.168.1.32'],
  })
  assert.deepEqual(localOnly, ['http://127.0.0.1:8790/'])
})

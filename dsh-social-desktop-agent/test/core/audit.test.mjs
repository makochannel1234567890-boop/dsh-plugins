import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createAuditLog } from '../../lib/core/audit.js'

const dir = mkdtempSync(join(tmpdir(), 'dsd-audit-'))
after(() => rmSync(dir, { recursive: true, force: true }))

const FIXED = '2026-01-01T00:00:00.000Z'
const clock = () => FIXED

function tempFile(name) {
  return join(dir, name)
}

test('appends exactly { ts, scope, kind, target, result, reason } with injected time', () => {
  const file = tempFile('roundtrip.jsonl')
  const audit = createAuditLog({ file, now: clock })
  const returned = audit.append({
    scope: 'browse.read',
    kind: 'navigate',
    target: 'https://example.com/',
    result: 'allow',
    reason: 'allowed',
  })
  assert.deepEqual(Object.keys(returned), ['ts', 'scope', 'kind', 'target', 'result', 'reason'])
  const rows = audit.readAll()
  assert.equal(rows.length, 1)
  assert.deepEqual(rows[0], {
    ts: FIXED,
    scope: 'browse.read',
    kind: 'navigate',
    target: 'https://example.com/',
    result: 'allow',
    reason: 'allowed',
  })
})

test('the file is append-only JSONL: one line per entry, order preserved', () => {
  const file = tempFile('append-only.jsonl')
  const audit = createAuditLog({ file, now: clock })
  audit.append({ scope: 'browse.read', kind: 'navigate', target: 'a', result: 'allow', reason: 'allowed' })
  audit.append({ scope: 'browse.read', kind: 'click', target: 'b', result: 'deny', reason: 'SCOPE_DENIED: no' })
  const lines = readFileSync(file, 'utf8').trim().split('\n')
  assert.equal(lines.length, 2)
  assert.equal(JSON.parse(lines[0]).target, 'a')
  assert.equal(JSON.parse(lines[1]).target, 'b')
  assert.deepEqual(audit.readAll().map((row) => row.result), ['allow', 'deny'])
})

test('a deny record survives a round trip and stays a deny', () => {
  const file = tempFile('deny.jsonl')
  const audit = createAuditLog({ file, now: clock })
  audit.append({ scope: 'app.launch', kind: 'launch', target: 'evil.exe', result: 'deny', reason: 'TARGET_DENIED: nope' })
  const rows = audit.readAll()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].result, 'deny')
  assert.match(rows[0].reason, /^TARGET_DENIED/)
})

test('reading a log that was never written returns an empty list', () => {
  const audit = createAuditLog({ file: tempFile('missing.jsonl'), now: clock })
  assert.deepEqual(audit.readAll(), [])
})

test('malformed or blank lines are skipped instead of breaking readAll', () => {
  const file = tempFile('corrupt.jsonl')
  const audit = createAuditLog({ file, now: clock })
  audit.append({ scope: 'browse.read', kind: 'navigate', target: 'ok', result: 'allow', reason: 'allowed' })
  appendFileSync(file, 'not json\n\n{"partial":true}\n', 'utf8')
  const rows = audit.readAll()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].target, 'ok')
})

test('object targets and newlines are flattened into a single safe line', () => {
  const file = tempFile('flatten.jsonl')
  const audit = createAuditLog({ file, now: clock })
  audit.append({
    scope: 'browse.read',
    kind: 'navigate',
    target: { url: 'https://example.com/\nforged: true' },
    result: 'allow',
    reason: 'allowed',
  })
  const raw = readFileSync(file, 'utf8')
  assert.equal(raw.trim().split('\n').length, 1)
  const row = audit.readAll()[0]
  assert.match(row.target, /forged: true/)
  assert.doesNotMatch(row.target, /\n/)
})

test('an unexpected result value is recorded as deny (fail closed)', () => {
  const audit = createAuditLog({ now: clock })
  audit.append({ scope: 'browse.read', kind: 'navigate', target: 'x', result: 'maybe', reason: 'r' })
  assert.equal(audit.readAll()[0].result, 'deny')
})

test('without a file the log stays in memory', () => {
  const audit = createAuditLog({ now: clock })
  audit.append({ scope: 'os.power', kind: 'power', target: 'restart', result: 'deny', reason: 'CONFIRM_REQUIRED: token' })
  const rows = audit.readAll()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].ts, FIXED)
})

test('parent directories are created for a nested audit path', () => {
  const file = join(dir, 'nested', 'deeper', 'audit.jsonl')
  const audit = createAuditLog({ file, now: clock })
  audit.append({ scope: 'browse.read', kind: 'navigate', target: 'ok', result: 'allow', reason: 'allowed' })
  assert.equal(audit.readAll().length, 1)
})

test('existing content is preserved when a log is reopened', () => {
  const file = tempFile('reopen.jsonl')
  writeFileSync(file, `${JSON.stringify({ ts: FIXED, scope: 'browse.read', kind: 'navigate', target: 'old', result: 'allow', reason: 'allowed' })}\n`, 'utf8')
  const audit = createAuditLog({ file, now: clock })
  audit.append({ scope: 'browse.read', kind: 'navigate', target: 'new', result: 'allow', reason: 'allowed' })
  assert.deepEqual(audit.readAll().map((row) => row.target), ['old', 'new'])
})

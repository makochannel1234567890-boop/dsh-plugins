import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'

import {
  extractAssistantText,
  findWorkspace,
  loadWorkspaces,
  parseWorkspaceFile,
  validatePrompt,
} from '../lib/workspaces.js'

/** Ledger paths are plain strings; slashes are irrelevant to every assertion. */
const DEFAULT_PATH = 'C:/Users/user/Documents/default-workspace'
const PROJ_PATH = 'C:/Users/user/Desktop/proj'

/** A ledger with two workspaces, defaulted to the first. */
function ledger() {
  return {
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, defaultWorkspaceId: 'ws-a' },
    tables: {
      workspaces: {
        'ws-a': {
          path: DEFAULT_PATH,
          title: 'default-workspace',
          sessionIds: ['s1', 's2'],
          createdAt: '2026-10-05T11:21:24.628Z',
          updatedAt: '2026-10-05T11:21:24.659Z',
        },
        'ws-b': {
          path: PROJ_PATH,
          title: '',
          sessionIds: [],
          createdAt: '2026-10-06T00:00:00.000Z',
          updatedAt: '2026-10-07T08:00:00.000Z',
        },
      },
    },
  }
}

test('parseWorkspaceFile reads the ledger into a flat list', () => {
  const { workspaces, defaultWorkspaceId } = parseWorkspaceFile(JSON.stringify(ledger()))
  assert.equal(defaultWorkspaceId, 'ws-a')
  assert.equal(workspaces.length, 2)
  const [first, second] = workspaces
  assert.equal(first.id, 'ws-a')
  assert.equal(first.title, 'default-workspace')
  assert.equal(first.path, DEFAULT_PATH)
  assert.equal(first.sessionCount, 2)
  assert.equal(first.updatedAt, Date.parse('2026-10-05T11:21:24.659Z'))
  // No title — the folder name stands in, from a backslash path as the Host writes it.
  assert.equal(second.title, 'proj')
  assert.equal(second.sessionCount, 0)
})

test('parseWorkspaceFile never throws on unusable input', () => {
  for (const raw of [undefined, null, '', '   ', '{not json', '[]', 'null', '42', '"text"']) {
    assert.deepEqual(parseWorkspaceFile(raw), { workspaces: [], defaultWorkspaceId: null })
  }
})

test('parseWorkspaceFile tolerates a missing tables block', () => {
  assert.deepEqual(parseWorkspaceFile(JSON.stringify({ global: { defaultWorkspaceId: 'x' } })), {
    workspaces: [],
    defaultWorkspaceId: 'x',
  })
  assert.deepEqual(parseWorkspaceFile(JSON.stringify({ tables: {} })), {
    workspaces: [],
    defaultWorkspaceId: null,
  })
  assert.deepEqual(parseWorkspaceFile(JSON.stringify({ tables: { workspaces: [] } })), {
    workspaces: [],
    defaultWorkspaceId: null,
  })
})

test('parseWorkspaceFile drops entries without a usable path', () => {
  const raw = JSON.stringify({
    tables: {
      workspaces: {
        good: { path: String.raw`C:\work\good`, title: 'Good' },
        'no-path': { title: 'No path' },
        'empty-path': { path: '   ', title: 'Empty' },
        'numeric-path': { path: 42, title: 'Number' },
        'not-an-object': 'nope',
      },
    },
  })
  const { workspaces } = parseWorkspaceFile(raw)
  assert.deepEqual(
    workspaces.map((item) => item.id),
    ['good'],
  )
  // A Windows path arrives as written, not re-normalized.
  assert.equal(workspaces[0].path, String.raw`C:\work\good`)
  // ...and the fallback title is its last segment.
  assert.equal(workspaces[0].title, 'Good')
})

test('parseWorkspaceFile normalizes updatedAt and ignores bad timestamps', () => {
  const raw = JSON.stringify({
    tables: {
      workspaces: {
        numeric: { path: 'C:/a', updatedAt: 1700000000000 },
        iso: { path: 'C:/b', updatedAt: '2026-01-02T03:04:05.000Z' },
        garbage: { path: 'C:/c', updatedAt: 'not a date' },
        missing: { path: 'C:/d' },
        wrongType: { path: 'C:/e', updatedAt: { at: 1 } },
      },
    },
  })
  const byId = new Map(parseWorkspaceFile(raw).workspaces.map((item) => [item.id, item.updatedAt]))
  assert.equal(byId.get('numeric'), 1700000000000)
  assert.equal(byId.get('iso'), Date.parse('2026-01-02T03:04:05.000Z'))
  assert.equal(byId.get('garbage'), 0)
  assert.equal(byId.get('missing'), 0)
  assert.equal(byId.get('wrongType'), 0)
})

test('parseWorkspaceFile keeps defaultWorkspaceId only when it is a string', () => {
  const raw = JSON.stringify({ global: { defaultWorkspaceId: 7 }, tables: { workspaces: {} } })
  assert.equal(parseWorkspaceFile(raw).defaultWorkspaceId, null)
})

test('findWorkspace prefers the id over the path', () => {
  const { workspaces } = parseWorkspaceFile(JSON.stringify(ledger()))
  const found = findWorkspace(workspaces, { workspaceId: 'ws-b', cwd: DEFAULT_PATH })
  assert.equal(found.id, 'ws-b')
})

test('findWorkspace matches a path regardless of drive case, slashes and trailing separator', () => {
  const { workspaces } = parseWorkspaceFile(JSON.stringify(ledger()))
  const candidates = [
    PROJ_PATH,
    'c:/users/user/desktop/proj',
    'C:/Users/user/Desktop/proj/',
    String.raw`C:\Users\user\Desktop\proj`,
    String.raw`c:\users\user\desktop\proj`,
    'c:\\users\\user\\desktop\\proj\\',
    'C:\\Users\\user\\Desktop\\proj',
  ]
  for (const cwd of candidates) {
    assert.equal(findWorkspace(workspaces, { cwd })?.id, 'ws-b', `cwd: ${cwd}`)
  }
})

test('findWorkspace returns undefined when nothing matches', () => {
  const { workspaces } = parseWorkspaceFile(JSON.stringify(ledger()))
  assert.equal(findWorkspace(workspaces, { workspaceId: 'missing' }), undefined)
  assert.equal(findWorkspace(workspaces, { cwd: 'C:/elsewhere' }), undefined)
  assert.equal(findWorkspace(workspaces, {}), undefined)
  assert.equal(findWorkspace(undefined, { workspaceId: 'ws-a' }), undefined)
  // An explicit id the ledger no longer knows must not fall back to the path:
  // starting a session in another folder is worse than an error.
  assert.equal(findWorkspace(workspaces, { workspaceId: 'gone', cwd: PROJ_PATH }), undefined)
})

test('validatePrompt trims and reports the empty case', () => {
  assert.deepEqual(validatePrompt('  hello  '), { ok: true, text: 'hello' })
  assert.deepEqual(validatePrompt(''), { ok: false, code: 'prompt_required' })
  assert.deepEqual(validatePrompt('   '), { ok: false, code: 'prompt_required' })
  assert.deepEqual(validatePrompt(undefined), { ok: false, code: 'prompt_required' })
  assert.deepEqual(validatePrompt(42), { ok: true, text: '42' })
})

test('validatePrompt keeps the 8000 character boundary and rejects 8001', () => {
  const atLimit = 'a'.repeat(8000)
  assert.deepEqual(validatePrompt(atLimit), { ok: true, text: atLimit })
  assert.deepEqual(validatePrompt('a'.repeat(8001)), { ok: false, code: 'prompt_too_long' })
  // Trimming happens before the length decision.
  assert.deepEqual(validatePrompt(`  ${atLimit}  `), { ok: true, text: atLimit })
  assert.deepEqual(validatePrompt('abcd', { maxChars: 4 }), { ok: true, text: 'abcd' })
  assert.deepEqual(validatePrompt('abcde', { maxChars: 4 }), { ok: false, code: 'prompt_too_long' })
  // Multi-byte text counts as characters, not UTF-16 code units.
  assert.deepEqual(validatePrompt('あ'.repeat(8000)), { ok: true, text: 'あ'.repeat(8000) })
})

test('extractAssistantText joins text blocks and skips reasoning and tool blocks', () => {
  const content = [
    { type: 'reasoning', text: 'internal thinking' },
    { type: 'text', text: '第一段落' },
    { type: 'tool-call', toolName: 'bash', input: { cmd: 'ls' } },
    { type: 'text', text: 'second' },
    { type: 'text', text: '   ' },
  ]
  assert.deepEqual(extractAssistantText(content), { text: '第一段落\n\nsecond', truncated: false })
  assert.deepEqual(extractAssistantText(undefined), { text: '', truncated: false })
  assert.deepEqual(extractAssistantText([]), { text: '', truncated: false })
  assert.deepEqual(extractAssistantText([{ type: 'reasoning', text: 'only thoughts' }]), {
    text: '',
    truncated: false,
  })
})

test('extractAssistantText cuts long results with an ellipsis and flags it', () => {
  const content = [{ type: 'text', text: 'abcdefghij' }]
  assert.deepEqual(extractAssistantText(content, { maxChars: 10 }), { text: 'abcdefghij', truncated: false })
  assert.deepEqual(extractAssistantText(content, { maxChars: 5 }), { text: 'abcd…', truncated: true })
  assert.equal(extractAssistantText(content, { maxChars: 5 }).text.length, 5)
})

test('loadWorkspaces reports a missing ledger instead of throwing', async () => {
  const missing = Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' })
  assert.deepEqual(
    await loadWorkspaces('C:/nowhere/workspace.json', {
      readFile: async () => {
        throw missing
      },
      existsSync: () => false,
    }),
    { workspaces: [], defaultWorkspaceId: null, error: 'not_found' },
  )

  const denied = Object.assign(new Error('EACCES'), { code: 'EACCES' })
  assert.deepEqual(
    await loadWorkspaces('C:/locked/workspace.json', {
      readFile: async () => {
        throw denied
      },
      existsSync: () => false,
    }),
    { workspaces: [], defaultWorkspaceId: null, error: 'read_failed' },
  )
})

test('loadWorkspaces sorts newest first, caps the list and marks missing folders', async () => {
  const raw = JSON.stringify({
    global: { defaultWorkspaceId: 'ws-a' },
    tables: {
      workspaces: {
        'ws-old': { path: 'C:/work/old', title: 'old', updatedAt: '2026-01-01T00:00:00.000Z' },
        'ws-new': { path: 'C:/work/new', title: 'new', updatedAt: '2026-03-01T00:00:00.000Z' },
        'ws-mid': { path: 'C:/work/mid', title: 'mid', updatedAt: '2026-02-01T00:00:00.000Z' },
      },
    },
  })
  const seen = []
  const loaded = await loadWorkspaces('ledger.json', {
    readFile: async () => raw,
    existsSync: (file) => {
      seen.push(file)
      return file.endsWith('new')
    },
    maxItems: 2,
  })
  assert.equal(loaded.error, null)
  assert.equal(loaded.defaultWorkspaceId, 'ws-a')
  assert.deepEqual(
    loaded.workspaces.map((item) => item.id),
    ['ws-new', 'ws-mid'],
  )
  // Every entry is probed, including the one the cap drops.
  assert.deepEqual(seen, ['C:/work/old', 'C:/work/new', 'C:/work/mid'])
  assert.equal(loaded.workspaces[0].exists, true)
  assert.equal(loaded.workspaces[1].exists, false)
})

test('loadWorkspaces defaults to the DSH storage ledger', async () => {
  let received = null
  const loaded = await loadWorkspaces(undefined, {
    readFile: async (file) => {
      received = file
      return '{"tables":{"workspaces":{}}}'
    },
    existsSync: () => false,
  })
  assert.equal(received, path.join(os.homedir(), '.dsh', 'storages', 'workspace.json'))
  assert.deepEqual(loaded, { workspaces: [], defaultWorkspaceId: null, error: null })
})

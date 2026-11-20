/**
 * Workspace ledger helpers for dsh-mobile-progress.
 *
 * The phone page lets the user pick a workspace and send a prompt, which turns
 * into a new DSH session in that directory. Everything needed for that decision
 * is a pure function kept out of `index.js`, so it can be unit-tested without a
 * Harness host:
 *
 *  1. Read `~/.dsh/storages/workspace.json` into a small list
 *     (`parseWorkspaceFile`, `loadWorkspaces`) and never throw on a broken file.
 *  2. Match the id or the path the phone sent (`findWorkspace`).
 *  3. Guard the prompt and fold the final assistant message into display text
 *     (`validatePrompt`, `extractAssistantText`).
 *
 * The ledger shape this module understands:
 *
 *     {
 *       global: { defaultWorkspaceId: string },
 *       tables: {
 *         workspaces: {
 *           [id]: { path, title, sessionIds, createdAt, updatedAt },
 *         },
 *       },
 *     }
 *
 * The ledger is owned by the Host. This module only reads it.
 *
 * @module dsh-mobile-progress/lib/workspaces
 */

import { existsSync as fsExistsSync, promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Workspace list length the API returns when no cap is given. */
const DEFAULT_MAX_ITEMS = 50

/** Prompt length cap; the phone's textarea is far smaller than this. */
const DEFAULT_PROMPT_CHARS = 8000

/** Assistant result length cap; longer results are cut for the phone. */
const DEFAULT_RESULT_CHARS = 4000

/** A plain object (not an array, not null). */
function asObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null
}

/** `updatedAt` as a number of milliseconds; anything unusable becomes 0. */
function toTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Date.parse(value.trim())
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
}

/** Compare key for a directory: resolved, no trailing separator, lower-case. */
function pathKey(value) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (trimmed.length === 0) return ''
  let resolved
  try {
    // Windows-style on every platform: the ledger is written by the Host, and
    // drive-letter case plus `\\` vs `/` must not decide a match.
    resolved = path.win32.resolve(trimmed)
  } catch {
    resolved = trimmed
  }
  let stripped = resolved.replace(/[\\/]+$/, '')
  // `C:` alone means "the current directory of that drive"; keep it a root.
  if (stripped.length === 2 && stripped.endsWith(':')) stripped += '\\'
  if (stripped.length === 0) stripped = resolved
  return stripped.toLowerCase()
}

/** Code-point length, so a surrogate pair counts as one character. */
function charLength(text) {
  return [...text].length
}

/** A positive integer cap, or the fallback when the config value is unusable. */
function resolveLimit(value, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number) || number < 1) return fallback
  return Math.floor(number)
}

/** A non-negative integer count, or the fallback (0 is a valid count). */
function resolveCount(value, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0) return fallback
  return Math.trunc(number)
}

/** Default ledger location inside the DSH storage directory. */
function defaultLedgerFile() {
  return path.join(os.homedir(), '.dsh', 'storages', 'workspace.json')
}

/**
 * Parse the raw workspace ledger.
 *
 * Tolerant by design: a missing, broken or unexpected file yields an empty
 * list instead of an exception, because the phone page must still load.
 *
 * @param {string|Buffer|undefined} raw JSON text (already-parsed objects work too)
 * @returns {{workspaces: Array<{id: string, title: string, path: string, updatedAt: number, sessionCount: number}>, defaultWorkspaceId: string|null}}
 */
export function parseWorkspaceFile(raw) {
  const result = { workspaces: [], defaultWorkspaceId: null }

  let parsed = null
  try {
    if (raw instanceof Uint8Array) {
      parsed = JSON.parse(Buffer.from(raw).toString('utf8'))
    } else if (typeof raw === 'string') {
      if (raw.trim().length === 0) return result
      parsed = JSON.parse(raw)
    } else if (asObject(raw) !== null) {
      parsed = raw
    } else {
      return result
    }
  } catch {
    return result
  }

  const root = asObject(parsed)
  if (root === null) return result

  const globalTable = asObject(root.global)
  if (globalTable !== null && typeof globalTable.defaultWorkspaceId === 'string') {
    result.defaultWorkspaceId = globalTable.defaultWorkspaceId
  }

  const tables = asObject(root.tables)
  const workspaceTable = tables === null ? null : asObject(tables.workspaces)
  if (workspaceTable === null) return result

  for (const [id, entry] of Object.entries(workspaceTable)) {
    const item = asObject(entry)
    if (item === null) continue
    const workspacePath = typeof item.path === 'string' ? item.path.trim() : ''
    if (workspacePath.length === 0) continue
    const rawTitle = typeof item.title === 'string' ? item.title.trim() : ''
    result.workspaces.push({
      id,
      // An untitled workspace is still usable, so fall back to the folder name.
      title: rawTitle.length > 0 ? rawTitle : path.win32.basename(workspacePath),
      path: workspacePath,
      updatedAt: toTimestamp(item.updatedAt),
      sessionCount: Array.isArray(item.sessionIds) ? item.sessionIds.length : 0,
    })
  }

  return result
}

/**
 * Find the workspace the phone asked for.
 *
 * A given `workspaceId` is authoritative: when it is present but unknown the
 * result is `undefined` rather than "some other directory", because starting a
 * session in the wrong folder is worse than an error. `cwd` is only consulted
 * when no id was sent, and is compared ignoring drive-letter case, a trailing
 * separator and `/` versus `\`.
 *
 * @param {Array<{id: string, path: string}>} workspaces
 * @param {{workspaceId?: string, cwd?: string}} [query]
 * @returns {{id: string, title: string, path: string, updatedAt: number, sessionCount: number}|undefined}
 */
export function findWorkspace(workspaces, { workspaceId, cwd } = {}) {
  const list = Array.isArray(workspaces) ? workspaces : []
  const wantedId = typeof workspaceId === 'string' ? workspaceId.trim() : ''
  if (wantedId.length > 0) {
    return list.find((item) => item !== null && typeof item === 'object' && item.id === wantedId)
  }
  const wantedPath = pathKey(cwd)
  if (wantedPath.length === 0) return undefined
  return list.find((item) => item !== null && typeof item === 'object' && pathKey(item.path) === wantedPath)
}

/**
 * Validate a prompt typed on the phone.
 *
 * The text is trimmed; an over-long prompt is rejected, never silently cut,
 * so the user knows their message was not shortened.
 *
 * @param {unknown} text
 * @param {{maxChars?: number}} [options]
 * @returns {{ok: true, text: string}|{ok: false, code: 'prompt_required'|'prompt_too_long'}}
 */
export function validatePrompt(text, { maxChars = DEFAULT_PROMPT_CHARS } = {}) {
  const value = text === undefined || text === null ? '' : String(text).trim()
  if (value.length === 0) return { ok: false, code: 'prompt_required' }
  const limit = resolveLimit(maxChars, DEFAULT_PROMPT_CHARS)
  if (charLength(value) > limit) return { ok: false, code: 'prompt_too_long' }
  return { ok: true, text: value }
}

/**
 * Fold an assistant message's content blocks into the text the phone shows.
 *
 * Only `type: 'text'` blocks count; reasoning and tool blocks stay out of the
 * result. Blocks are separated by a blank line, and anything past `maxChars`
 * is cut with an ellipsis so the payload stays small.
 *
 * @param {unknown} content the `content` array of an `assistant/message` event
 * @param {{maxChars?: number}} [options]
 * @returns {{text: string, truncated: boolean}}
 */
export function extractAssistantText(content, { maxChars = DEFAULT_RESULT_CHARS } = {}) {
  const blocks = []
  if (Array.isArray(content)) {
    for (const item of content) {
      if (item === null || typeof item !== 'object') continue
      if (item.type !== 'text') continue
      if (typeof item.text !== 'string') continue
      const text = item.text.trim()
      if (text.length > 0) blocks.push(text)
    }
  }
  const joined = blocks.join('\n\n').trim()
  if (joined.length === 0) return { text: '', truncated: false }
  const limit = resolveLimit(maxChars, DEFAULT_RESULT_CHARS)
  if (charLength(joined) > limit) {
    const cut = [...joined].slice(0, Math.max(0, limit - 1)).join('')
    return { text: `${cut}…`, truncated: true }
  }
  return { text: joined, truncated: false }
}

/**
 * Read the workspace ledger for the HTTP API.
 *
 * Never throws: a missing file is `not_found`, any other read problem is
 * `read_failed`, and both come back with an empty list so the page can render
 * an explanation. Each entry carries `exists`, answered from the local disk, so
 * the phone can grey out a workspace that was moved or deleted.
 *
 * @param {string} [file] ledger path; defaults to `~/.dsh/storages/workspace.json`
 * @param {{readFile?: Function, existsSync?: Function, maxItems?: number}} [options]
 * @returns {Promise<{workspaces: Array<{id: string, title: string, path: string, updatedAt: number, sessionCount: number, exists: boolean}>, defaultWorkspaceId: string|null, error: string|null}>}
 */
export async function loadWorkspaces(file, { readFile, existsSync, maxItems = DEFAULT_MAX_ITEMS } = {}) {
  const target = typeof file === 'string' && file.trim().length > 0 ? file : defaultLedgerFile()
  const reader = typeof readFile === 'function' ? readFile : (ledger) => fsp.readFile(ledger, 'utf8')
  const probe = typeof existsSync === 'function' ? existsSync : fsExistsSync

  let raw
  try {
    raw = await reader(target, 'utf8')
  } catch (error) {
    const code = error !== null && typeof error === 'object' && error.code === 'ENOENT' ? 'not_found' : 'read_failed'
    return { workspaces: [], defaultWorkspaceId: null, error: code }
  }

  const parsed = parseWorkspaceFile(raw)
  const limit = resolveCount(maxItems, DEFAULT_MAX_ITEMS)
  const workspaces = parsed.workspaces
    .map((item) => ({ ...item, exists: probeExists(probe, item.path) }))
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, limit)

  return { workspaces, defaultWorkspaceId: parsed.defaultWorkspaceId, error: null }
}

/** `existsSync` as a boolean; a throwing probe just means "unknown". */
function probeExists(probe, file) {
  try {
    return probe(file) === true
  } catch {
    return false
  }
}

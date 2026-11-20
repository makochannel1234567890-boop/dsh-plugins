/**
 * Append-only JSONL audit trail.
 *
 * One line per decision, never rewritten. Entries are normalised to exactly
 * `{ ts, scope, kind, target, result, reason }`; `ts` comes from the injected
 * `now` function so tests are deterministic. Strings and objects are
 * flattened into one line, so a target containing newlines cannot forge an
 * extra record.
 *
 * Without a `file` the log lives in memory for the lifetime of the process
 * (useful for tests and for a plugin running read-only).
 *
 * @module dsh-social-desktop-agent/lib/core/audit
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'

const MAX_FIELD_CHARS = 2000

function readTimestamp(clock) {
  let value
  try {
    value = clock()
  } catch {
    return new Date().toISOString()
  }
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString()
  if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  return new Date().toISOString()
}

function flatten(value) {
  if (value === null || value === undefined) return ''
  let text
  if (typeof value === 'string') {
    text = value
  } else {
    try {
      text = JSON.stringify(value)
    } catch {
      text = String(value)
    }
  }
  const singleLine = String(text ?? '').replace(/[\r\n\t]+/g, ' ')
  return singleLine.length > MAX_FIELD_CHARS ? `${singleLine.slice(0, MAX_FIELD_CHARS)}…` : singleLine
}

function normalizeEntry(entry, clock) {
  const source = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : {}
  return {
    ts: readTimestamp(clock),
    scope: flatten(source.scope),
    kind: flatten(source.kind),
    target: flatten(source.target),
    // Anything that is not an explicit allow is recorded as a deny.
    result: source.result === 'allow' ? 'allow' : 'deny',
    reason: flatten(source.reason),
  }
}

function parseLine(line) {
  const text = line.trim()
  if (text.length === 0) return null
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  // Only complete records we wrote ourselves count; arbitrary JSON is skipped.
  if (typeof parsed.ts !== 'string' || parsed.ts.length === 0) return null
  if (parsed.result !== 'allow' && parsed.result !== 'deny') return null
  return {
    ts: typeof parsed.ts === 'string' ? parsed.ts : '',
    scope: typeof parsed.scope === 'string' ? parsed.scope : '',
    kind: typeof parsed.kind === 'string' ? parsed.kind : '',
    target: typeof parsed.target === 'string' ? parsed.target : '',
    result: parsed.result === 'allow' ? 'allow' : 'deny',
    reason: typeof parsed.reason === 'string' ? parsed.reason : '',
  }
}

/**
 * @param {{ file?: string|null, now?: () => (Date|number|string) }} [options]
 * @returns {{ append(entry: object): object, readAll(): object[] }}
 */
export function createAuditLog({ file = null, now } = {}) {
  const clock = typeof now === 'function' ? now : () => new Date()
  const targetFile = typeof file === 'string' && file.trim().length > 0 ? file.trim() : null
  const memory = []

  function append(entry) {
    const record = normalizeEntry(entry, clock)
    if (targetFile) {
      mkdirSync(dirname(targetFile), { recursive: true })
      appendFileSync(targetFile, `${JSON.stringify(record)}\n`, 'utf8')
    } else {
      memory.push(record)
    }
    return record
  }

  function readAll() {
    if (!targetFile) return memory.map((record) => ({ ...record }))
    if (!existsSync(targetFile)) return []
    const raw = readFileSync(targetFile, 'utf8')
    const records = []
    for (const line of raw.split('\n')) {
      const record = parseLine(line)
      if (record) records.push(record)
    }
    return records
  }

  return { append, readAll }
}

/**
 * One-time confirmation tokens (used for `os.power`).
 *
 * A caller first asks for a token bound to one concrete action, shows the
 * human what will happen, and only then passes the token back through the
 * policy. Tokens are single-use, expire after a TTL (5 minutes by default) and
 * are compared by canonical action JSON — key order and token fields are
 * ignored, so passing the whole action back (including `confirmToken`) works.
 *
 * A failed comparison (wrong token, expired, already used, different action)
 * returns false and leaves a still-valid token untouched; success consumes it.
 *
 * @module dsh-social-desktop-agent/lib/core/confirm
 */

import { randomUUID } from 'node:crypto'

export const DEFAULT_CONFIRM_TTL_MS = 5 * 60 * 1000

/** Fields that carry the proof itself and must not affect the comparison. */
const TOKEN_FIELDS = Object.freeze(['confirmToken', 'confirmationToken', 'token', 'confirmation', 'confirm'])

function canonicalValue(value, seen) {
  if (value === null) return 'null'
  if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol') return 'null'
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null'
  if (typeof value === 'bigint') return JSON.stringify(String(value))
  if (typeof value !== 'object') return JSON.stringify(value)
  if (seen.has(value)) return '"[circular]"'
  seen.add(value)
  let out
  if (Array.isArray(value)) {
    out = `[${value.map((item) => canonicalValue(item, seen)).join(',')}]`
  } else {
    const keys = Object.keys(value).sort()
    out = `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalValue(value[key], seen)}`).join(',')}}`
  }
  seen.delete(value)
  return out
}

/** Stable JSON for deep equality of plain actions (object keys sorted). */
export function stableStringify(value) {
  return canonicalValue(value, new Set())
}

/** Remove proof fields, then serialise. */
export function canonicalAction(action) {
  if (!action || typeof action !== 'object' || Array.isArray(action)) {
    return stableStringify({ value: action ?? null })
  }
  const copy = { ...action }
  for (const key of TOKEN_FIELDS) delete copy[key]
  return stableStringify(copy)
}

function makeClock(now) {
  const source = typeof now === 'function' ? now : () => Date.now()
  return () => {
    let value
    try {
      value = source()
    } catch {
      return Date.now()
    }
    if (value instanceof Date) return value.getTime()
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string') {
      const parsed = Date.parse(value)
      if (Number.isFinite(parsed)) return parsed
    }
    return Date.now()
  }
}

/**
 * @param {{ now?: () => (Date|number|string), ttlMs?: number }} [options]
 * @returns {{ request(action: object): string, consume(token: string, action: object): boolean, peek(token: string, action: object): boolean, ttlMs: number }}
 */
export function createConfirmGate({ now, ttlMs } = {}) {
  const clock = makeClock(now)
  const ttl = typeof ttlMs === 'number' && Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : DEFAULT_CONFIRM_TTL_MS
  const pending = new Map()

  function prune(timestamp) {
    for (const [token, record] of pending) {
      if (record.expiresAt <= timestamp) pending.delete(token)
    }
  }

  function lookup(token, action) {
    if (typeof token !== 'string' || token.length === 0) return null
    const timestamp = clock()
    prune(timestamp)
    const record = pending.get(token)
    if (!record) return null
    if (record.expiresAt <= timestamp) {
      pending.delete(token)
      return null
    }
    if (record.actionKey !== canonicalAction(action)) return null
    return record
  }

  function request(action) {
    if (!action || typeof action !== 'object' || Array.isArray(action)) {
      throw new TypeError('confirm.request(action) requires a plain action object')
    }
    const timestamp = clock()
    prune(timestamp)
    const token = randomUUID()
    pending.set(token, {
      actionKey: canonicalAction(action),
      createdAt: timestamp,
      expiresAt: timestamp + ttl,
      used: false,
    })
    return token
  }

  function peek(token, action) {
    return lookup(token, action) !== null
  }

  function consume(token, action) {
    const record = lookup(token, action)
    if (!record) return false
    record.used = true
    pending.delete(token)
    return true
  }

  return { request, consume, peek, ttlMs: ttl }
}

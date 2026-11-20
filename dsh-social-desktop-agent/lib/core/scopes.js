/**
 * Scope catalogue and normalisation for dsh-social-desktop-agent.
 *
 * Scopes are ordered from least to most invasive, but they are granted
 * *exactly*: enabling `browse.interact` does not silently enable
 * `browse.read`, and nothing implies `os.power`. Least privilege is the
 * default — an omitted value enables `browse.read` only, while an explicit
 * empty list enables nothing.
 *
 * Unknown names never throw and never grant anything. A typo therefore fails
 * closed (the action is denied) instead of partially widening the grant.
 *
 * @module dsh-social-desktop-agent/lib/core/scopes
 */

/** Least → most invasive. Frozen so callers cannot reorder the policy. */
export const SCOPE_ORDER = Object.freeze([
  'browse.read',
  'browse.interact',
  'social.write',
  'app.launch',
  'os.power',
])

/** Enabled when the caller does not say otherwise. */
export const DEFAULT_SCOPES = Object.freeze(['browse.read'])

const SCOPE_RANK = new Map(SCOPE_ORDER.map((scope, index) => [scope, index]))

/**
 * Canonicalise one scope name. Returns null for anything not in SCOPE_ORDER.
 * @param {unknown} value
 * @returns {string|null}
 */
export function normalizeScope(value) {
  if (typeof value !== 'string') return null
  const key = value.trim().toLowerCase()
  return SCOPE_RANK.has(key) ? key : null
}

/** @param {unknown} value */
export function isKnownScope(value) {
  return normalizeScope(value) !== null
}

function normalizeScopeList(values) {
  const accepted = new Set()
  for (const value of values) {
    const scope = normalizeScope(value)
    if (scope) accepted.add(scope)
  }
  return SCOPE_ORDER.filter((scope) => accepted.has(scope))
}

/**
 * Normalise the configured scope grant.
 *
 * Accepts a scope string, an array (or Set) of them, a function returning any
 * of those, or `undefined`/`null` for the default. The result is a fresh,
 * deduplicated array in SCOPE_ORDER order. Unknown entries are dropped.
 *
 * @param {string|string[]|Set<string>|(() => unknown)|null|undefined} input
 * @returns {string[]}
 */
export function resolveScopes(input) {
  if (input === undefined || input === null) return [...DEFAULT_SCOPES]
  if (typeof input === 'string') return normalizeScopeList([input])
  if (Array.isArray(input)) return normalizeScopeList(input)
  if (input instanceof Set) return normalizeScopeList(input)
  if (typeof input === 'function') return resolveScopes(input())
  return []
}

/**
 * True when `scope` is explicitly enabled by `input`.
 * @param {unknown} input
 * @param {string} scope
 */
export function hasScope(input, scope) {
  const wanted = normalizeScope(scope)
  if (!wanted) return false
  return resolveScopes(input).includes(wanted)
}

/**
 * Scopes NOT enabled by `input`, in SCOPE_ORDER order (handy for status text).
 * @param {unknown} input
 * @returns {string[]}
 */
export function deniedScopes(input) {
  const enabled = new Set(resolveScopes(input))
  return SCOPE_ORDER.filter((scope) => !enabled.has(scope))
}

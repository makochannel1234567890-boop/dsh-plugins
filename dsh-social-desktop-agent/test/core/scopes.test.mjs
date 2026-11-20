import test from 'node:test'
import assert from 'node:assert/strict'

import {
  SCOPE_ORDER,
  DEFAULT_SCOPES,
  normalizeScope,
  isKnownScope,
  resolveScopes,
  hasScope,
  deniedScopes,
} from '../../lib/core/scopes.js'

test('SCOPE_ORDER lists the five scopes from least to most invasive', () => {
  assert.deepEqual([...SCOPE_ORDER], ['browse.read', 'browse.interact', 'social.write', 'app.launch', 'os.power'])
  assert.ok(Object.isFrozen(SCOPE_ORDER))
})

test('normalizeScope is case/space tolerant and rejects unknown names', () => {
  assert.equal(normalizeScope(' Browse.Read '), 'browse.read')
  assert.equal(normalizeScope('OS.POWER'), 'os.power')
  assert.equal(normalizeScope('browse.write'), null)
  assert.equal(normalizeScope(42), null)
  assert.equal(normalizeScope(null), null)
  assert.equal(isKnownScope('app.launch'), true)
  assert.equal(isKnownScope('everything'), false)
})

test('omitted/null scope input defaults to browse.read only', () => {
  assert.deepEqual(resolveScopes(undefined), [...DEFAULT_SCOPES])
  assert.deepEqual(resolveScopes(null), ['browse.read'])
})

test('an explicit empty grant enables nothing', () => {
  assert.deepEqual(resolveScopes([]), [])
  assert.deepEqual(resolveScopes(''), [])
})

test('strings, arrays and Sets are normalised, deduplicated and ordered', () => {
  assert.deepEqual(resolveScopes('os.power'), ['os.power'])
  assert.deepEqual(resolveScopes(['os.power', 'browse.read', 'browse.read']), ['browse.read', 'os.power'])
  assert.deepEqual(resolveScopes(new Set(['app.launch', 'browse.interact'])), ['browse.interact', 'app.launch'])
})

test('unknown entries are dropped (a typo grants nothing extra)', () => {
  assert.deepEqual(resolveScopes(['browse.read', 'browse.write', 'root', 7, null]), ['browse.read'])
})

test('resolveScopes returns a fresh array and does not mutate its input', () => {
  const input = ['browse.read']
  const output = resolveScopes(input)
  output.push('os.power')
  assert.deepEqual(input, ['browse.read'])
  assert.deepEqual(resolveScopes(input), ['browse.read'])
})

test('a function source is resolved on every call (runtime promotion)', () => {
  let grant = ['browse.read']
  assert.deepEqual(resolveScopes(() => grant), ['browse.read'])
  grant = ['browse.read', 'os.power']
  assert.deepEqual(resolveScopes(() => grant), ['browse.read', 'os.power'])
})

test('hasScope and deniedScopes follow exact membership', () => {
  assert.equal(hasScope(['browse.read'], 'browse.read'), true)
  assert.equal(hasScope(['browse.read'], 'browse.interact'), false)
  assert.equal(hasScope(['os.power'], 'os.power'), true)
  assert.deepEqual(deniedScopes(['browse.read']), ['browse.interact', 'social.write', 'app.launch', 'os.power'])
  assert.deepEqual(deniedScopes([]), [...SCOPE_ORDER])
})

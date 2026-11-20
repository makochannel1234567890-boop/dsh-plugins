import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createConfirmGate,
  canonicalAction,
  DEFAULT_CONFIRM_TTL_MS,
} from '../../lib/core/confirm.js'

const START = Date.parse('2026-01-01T00:00:00.000Z')

function makeClock(start = START) {
  let current = start
  return {
    now: () => current,
    advance: (ms) => {
      current += ms
    },
  }
}

function action(overrides = {}) {
  return { scope: 'os.power', kind: 'power', target: 'restart', ...overrides }
}

test('a requested token can be consumed once for the same action', () => {
  const gate = createConfirmGate({ now: makeClock().now })
  const requested = action()
  const token = gate.request(requested)
  assert.equal(typeof token, 'string')
  assert.ok(token.length > 0)
  assert.equal(gate.peek(token, requested), true)
  assert.equal(gate.consume(token, requested), true)
})

test('a token cannot be reused', () => {
  const gate = createConfirmGate({ now: makeClock().now })
  const requested = action()
  const token = gate.request(requested)
  assert.equal(gate.consume(token, requested), true)
  assert.equal(gate.consume(token, requested), false)
  assert.equal(gate.peek(token, requested), false)
})

test('a token expires after the TTL and stops working immediately after', () => {
  const clock = makeClock()
  const gate = createConfirmGate({ now: clock.now, ttlMs: 1000 })
  const requested = action()
  const token = gate.request(requested)
  clock.advance(999)
  assert.equal(gate.peek(token, requested), true)
  clock.advance(1)
  assert.equal(gate.consume(token, requested), false)
})

test('the default TTL is five minutes', () => {
  assert.equal(DEFAULT_CONFIRM_TTL_MS, 5 * 60 * 1000)
  const clock = makeClock()
  const gate = createConfirmGate({ now: clock.now })
  const requested = action()
  const token = gate.request(requested)
  clock.advance(5 * 60 * 1000 - 1)
  assert.equal(gate.peek(token, requested), true)
  clock.advance(1)
  assert.equal(gate.peek(token, requested), false)
})

test('a token issued for one action does not authorise another', () => {
  const gate = createConfirmGate({ now: makeClock().now })
  const restart = action({ target: 'restart' })
  const token = gate.request(restart)
  assert.equal(gate.consume(token, action({ target: 'shutdown' })), false)
  // A mismatch does not burn the token: the intended action still works.
  assert.equal(gate.consume(token, restart), true)
})

test('unknown and empty tokens are refused', () => {
  const gate = createConfirmGate({ now: makeClock().now })
  assert.equal(gate.consume('nope', action()), false)
  assert.equal(gate.consume('', action()), false)
  assert.equal(gate.consume(null, action()), false)
})

test('action comparison ignores key order and the token field itself', () => {
  const gate = createConfirmGate({ now: makeClock().now })
  const requested = { scope: 'os.power', kind: 'power', target: 'shutdown' }
  const token = gate.request(requested)
  const reordered = { target: 'shutdown', kind: 'power', scope: 'os.power', confirmToken: token }
  assert.equal(gate.consume(token, reordered), true)
})

test('canonicalAction strips proof fields and stringifies deterministically', () => {
  assert.equal(
    canonicalAction({ scope: 'os.power', target: 'restart', confirmToken: 'abc' }),
    canonicalAction({ target: 'restart', scope: 'os.power' }),
  )
  assert.equal(canonicalAction('restart'), canonicalAction('restart'))
  assert.notEqual(canonicalAction('restart'), canonicalAction('shutdown'))
})

test('request rejects a non-object action', () => {
  const gate = createConfirmGate({ now: makeClock().now })
  assert.throws(() => gate.request(null), TypeError)
  assert.throws(() => gate.request('restart'), TypeError)
})

import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createKillSwitch,
  isKillSwitchActive,
  resolveKillSwitchFile,
  KILL_SWITCH_ENV,
  KILL_SWITCH_FILE_ENV,
} from '../../lib/core/killswitch.js'

const dir = mkdtempSync(join(tmpdir(), 'dsd-kill-'))
after(() => rmSync(dir, { recursive: true, force: true }))

test('DSH_KILL_SWITCH=1 trips the switch', () => {
  const gate = createKillSwitch({ env: { [KILL_SWITCH_ENV]: '1' } })
  assert.equal(gate.trip(), true)
  assert.equal(gate.active(), true)
  assert.match(String(gate.reason()), /DSH_KILL_SWITCH=1/)
  assert.equal(gate.snapshot().source, 'env')
})

test('an absent or non-1 value leaves the switch alone', () => {
  assert.equal(createKillSwitch({ env: {} }).trip(), false)
  assert.equal(createKillSwitch({ env: { [KILL_SWITCH_ENV]: '0' } }).trip(), false)
  assert.equal(createKillSwitch({ env: { [KILL_SWITCH_ENV]: 'true' } }).trip(), false)
  assert.equal(createKillSwitch({ env: {} }).reason(), null)
})

test('the kill-switch file trips the switch while it exists', () => {
  const file = join(dir, 'KILL')
  const gate = createKillSwitch({ file, env: {} })
  assert.equal(gate.trip(), false)
  writeFileSync(file, 'stop', 'utf8')
  assert.equal(gate.trip(), true)
  assert.equal(gate.reason(), file)
  unlinkSync(file)
  assert.equal(gate.trip(), false)
})

test('the file is re-read on every call, so tripping is live', () => {
  const file = join(dir, 'LIVE-KILL')
  const gate = createKillSwitch({ file, env: {} })
  assert.equal(gate.trip(), false)
  writeFileSync(file, '', 'utf8')
  assert.equal(gate.trip(), true)
})

test('DSH_KILL_SWITCH_FILE supplies a default path', () => {
  const file = join(dir, 'ENV-KILL')
  assert.equal(resolveKillSwitchFile({ env: { [KILL_SWITCH_FILE_ENV]: file } }), file)
  writeFileSync(file, '', 'utf8')
  const gate = createKillSwitch({ env: { [KILL_SWITCH_FILE_ENV]: file } })
  assert.equal(gate.trip(), true)
  assert.equal(gate.snapshot().source, 'file')
})

test('an explicit file wins over the environment path', () => {
  const explicit = join(dir, 'EXPLICIT')
  assert.equal(
    resolveKillSwitchFile({ file: explicit, env: { [KILL_SWITCH_FILE_ENV]: join(dir, 'IGNORED') } }),
    explicit,
  )
  assert.equal(resolveKillSwitchFile({ env: {} }), null)
})

test('isKillSwitchActive is a one-shot convenience check', () => {
  assert.equal(isKillSwitchActive({ env: { [KILL_SWITCH_ENV]: '1' } }), true)
  assert.equal(isKillSwitchActive({ env: {} }), false)
})

test('snapshot reports the resolved state and file', () => {
  const file = join(dir, 'SNAPSHOT')
  const gate = createKillSwitch({ file, env: {} })
  assert.deepEqual(gate.snapshot(), { active: false, source: null, detail: null, file })
})

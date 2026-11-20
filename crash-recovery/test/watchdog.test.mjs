import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { decide, hasHostCrashReport, relaunchCommand } from '../bin/watchdog.mjs'

const NOW = 1_800_000_000_000
const DESKTOP_EXE = 'C:\\Users\\user\\AppData\\Local\\Programs\\DeepSeek Harness\\DeepSeek Harness.exe'
const DESKTOP_ARGV = [
  'C:\\Users\\user\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\index.js',
  'C:\\Users\\user\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar\\dsh',
  'C:\\Users\\user\\.dsh\\profiles\\desktop',
]

function options(overrides = {}) {
  return {
    staleMs: 120_000,
    maxRelaunch: 1,
    cooldownMs: 60 * 60 * 1000,
    requireCrashReport: true,
    crashLogDir: '',
    ...overrides,
  }
}

function journal(overrides = {}) {
  return {
    bootId: 'boot-1',
    pid: 999_999,
    clean: false,
    exitReason: '',
    heartbeatAt: NOW - 300_000,
    startedAt: NOW - 600_000,
    relaunch: { execPath: DESKTOP_EXE, argv: DESKTOP_ARGV, cwd: 'C:\\tmp' },
    ...overrides,
  }
}

test('a clean journal stops the watchdog', () => {
  const decision = decide({ journal: journal({ clean: true, exitReason: 'process-exit' }), budget: {}, options: options(), now: NOW, alive: false })
  assert.equal(decision.action, 'stop')
})

test('a live pid is watched, never relaunched', () => {
  const decision = decide({ journal: journal(), budget: {}, options: options(), now: NOW, alive: true })
  assert.equal(decision.action, 'watch')
})

test('an unclean exit without a host crash report is treated as a user quit', () => {
  const decision = decide({
    journal: journal(),
    budget: {},
    options: options(),
    now: NOW,
    alive: false,
    hostCrashReport: false,
  })
  assert.equal(decision.action, 'stop')
  assert.match(decision.reason, /normal quit/u)
})

test('an unclean exit with a host crash report relaunches the desktop shell alone', () => {
  const decision = decide({
    journal: journal(),
    budget: {},
    options: options(),
    now: NOW,
    alive: false,
    hostCrashReport: true,
  })
  assert.equal(decision.action, 'relaunch')
  assert.deepEqual(decision.command.argv, [], 'replaying the headless Host argv must not happen')
  assert.equal(decision.command.execPath, DESKTOP_EXE)
})

test('a plain node relaunch replays its recorded argv', () => {
  const command = relaunchCommand({
    relaunch: { execPath: 'C:\\Program Files\\nodejs\\node.exe', argv: ['C:\\dsh\\lib\\bin.js', 'web'], cwd: 'C:\\tmp' },
  })
  assert.deepEqual(command.argv, ['C:\\dsh\\lib\\bin.js', 'web'])
})

test('a crashed boot is only relaunched once', () => {
  const first = journal()
  const crashId = `${first.bootId}@${first.heartbeatAt}`
  const decision = decide({
    journal: first,
    budget: { relaunches: [{ at: NOW - 1000, crashId }] },
    options: options(),
    now: NOW,
    alive: false,
    hostCrashReport: true,
  })
  assert.equal(decision.action, 'give-up')
})

test('hasHostCrashReport distinguishes a host crash log from a renderer log', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-watchdog-'))
  try {
    assert.equal(hasHostCrashReport(dir, NOW), false)
    const renderer = path.join(dir, 'crash-2026-01-01T00-00-00-000Z-renderer.log')
    writeFileSync(renderer, 'killed\n')
    utimesSync(renderer, new Date(NOW), new Date(NOW))
    assert.equal(hasHostCrashReport(dir, NOW), false, 'a killed renderer on quit is not a host crash')
    const host = path.join(dir, 'crash-2026-01-01T00-00-00-000Z-host.log')
    writeFileSync(host, 'heap out of memory\n')
    utimesSync(host, new Date(NOW), new Date(NOW))
    assert.equal(hasHostCrashReport(dir, NOW), true)
    assert.equal(hasHostCrashReport('', NOW), undefined, 'no directory configured means the guard is off')
    assert.equal(hasHostCrashReport(path.join(dir, 'missing'), NOW), undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

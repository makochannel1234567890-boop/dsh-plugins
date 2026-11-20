/**
 * File-backed liveness journal for dsh-crash-recovery.
 *
 * `live.json` is the only thing that survives an unexpected exit, so it has to
 * be written with data a *next* process can trust without help from this one:
 * the boot id, the pid, how to relaunch, and which sessions were doing
 * something risky when we last looked.
 *
 * `markClean` uses synchronous writes on purpose: it also runs from a
 * `process.on('exit')` hook, where nothing asynchronous gets a chance to land.
 *
 * @module dsh-crash-recovery/lib/journal
 */

import { appendFileSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'

export const JOURNAL_SCHEMA = 1

export function defaultStoreDir() {
  return path.join(os.homedir(), '.dsh', 'storages', 'crash-recovery')
}

export class CrashJournal {
  constructor(storeDir) {
    this.dir = path.resolve(storeDir)
    this.liveFile = path.join(this.dir, 'live.json')
    this.claimFile = path.join(this.dir, 'supervisor-claim.json')
    this.ledgerFile = path.join(this.dir, 'recoveries.jsonl')
    this.reportDir = path.join(this.dir, 'reports')
    this.state = undefined
  }

  ensure() {
    mkdirSync(this.dir, { recursive: true })
    mkdirSync(this.reportDir, { recursive: true })
  }

  /** Journal of the previous process, or undefined when there is none. */
  readPrevious() {
    try {
      const text = readFileSync(this.liveFile, 'utf8')
      const parsed = JSON.parse(text)
      return parsed !== null && typeof parsed === 'object' ? parsed : undefined
    } catch {
      return undefined
    }
  }

  readClaim() {
    try {
      const parsed = JSON.parse(readFileSync(this.claimFile, 'utf8'))
      return parsed !== null && typeof parsed === 'object' ? parsed : undefined
    } catch {
      return undefined
    }
  }

  /**
   * Reserve the single supervisor slot for one crash.
   *
   * `wx` makes this atomic across processes: the loser of two racing boots
   * gets EEXIST and must not spawn a second supervisor.
   *
   * @param {{ crashId: string, sessionId?: string, at?: number }} claim
   * @returns {{ claimed: boolean, reason?: string, existing?: any }}
   */
  claimSupervisor(claim) {
    this.ensure()
    const body = {
      crashId: claim.crashId,
      sessionId: claim.sessionId ?? '',
      at: claim.at ?? Date.now(),
      pid: process.pid,
    }
    try {
      writeFileSync(this.claimFile, `${JSON.stringify(body, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
      return { claimed: true }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      return { claimed: false, reason: 'another boot already claimed the supervisor', existing: this.readClaim() }
    }
  }

  /** Release the slot only when this boot failed to use it. */
  clearClaim() {
    try {
      unlinkSync(this.claimFile)
    } catch {
      // Already gone: nothing to release.
    }
  }

  /**
   * Start this boot's journal.
   *
   * @param {{ profile?: string, relaunch?: object, heartbeatAt?: number }} init
   */
  start(init = {}) {
    this.ensure()
    const now = Date.now()
    this.state = {
      schema: JOURNAL_SCHEMA,
      bootId: randomUUID(),
      pid: process.pid,
      profile: init.profile ?? '',
      startedAt: now,
      heartbeatAt: now,
      clean: false,
      exitedAt: 0,
      exitReason: '',
      relaunch: init.relaunch ?? {},
      riskySessions: [],
      runningSessions: [],
      fanoutRuns: [],
      supervisorSessionId: '',
      recoveries: 0,
    }
    this.write()
    return this.state
  }

  write() {
    if (this.state === undefined) return
    const target = this.liveFile
    const tmp = `${target}.tmp`
    try {
      writeFileSync(tmp, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8')
      renameSync(tmp, target)
    } catch {
      // The journal must never take the host down.
    }
  }

  /** Refresh the heartbeat and, when supplied, the observed activity sets. */
  beat(observed) {
    if (this.state === undefined) return
    this.state.heartbeatAt = Date.now()
    if (observed !== undefined) {
      if (Array.isArray(observed.runningSessions)) this.state.runningSessions = dedupe(observed.runningSessions)
      if (Array.isArray(observed.riskySessions)) this.state.riskySessions = dedupe(observed.riskySessions)
      if (Array.isArray(observed.fanoutRuns)) this.state.fanoutRuns = dedupe(observed.fanoutRuns)
      if (typeof observed.supervisorSessionId === 'string' && observed.supervisorSessionId.length > 0) {
        this.state.supervisorSessionId = observed.supervisorSessionId
      }
    }
    this.write()
  }

  markRisky(sessionId, toolName) {
    if (this.state === undefined) return
    if (typeof sessionId !== 'string' || sessionId.length === 0) return
    if (this.state.riskySessions.includes(sessionId)) return
    this.state.riskySessions = [...this.state.riskySessions, sessionId]
    this.state.lastRiskyTool = typeof toolName === 'string' ? toolName : ''
    this.state.riskyAt = Date.now()
    this.write()
  }

  /** Synchronous: safe from `process.on('exit')`. */
  markClean(reason) {
    if (this.state === undefined) return
    this.state.clean = true
    this.state.exitedAt = Date.now()
    this.state.exitReason = typeof reason === 'string' ? reason : 'unknown'
    this.state.heartbeatAt = this.state.exitedAt
    try {
      writeFileSync(this.liveFile, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8')
    } catch {
      // Best effort only.
    }
  }

  record(entry) {
    this.ensure()
    try {
      appendFileSync(this.ledgerFile, `${JSON.stringify({ ...entry, at: Date.now() })}\n`, 'utf8')
    } catch {
      // Diagnostics must never break the host.
    }
  }

  /**
   * Session ids a previous boot already tried to resume, newest first.
   *
   * A crash-loop is not hypothetical: resuming a large batch of sessions was
   * observed to push this host past its V8 heap limit about four minutes after
   * boot, three times in a row. The next boot must therefore be able to see
   * that these prompts were already sent, and skip them instead of sending the
   * same burst again.
   *
   * Reads only the ledger tail, so a long history stays cheap.
   *
   * @param {number} [withinMs] - only records newer than this count.
   * @param {number} [now]
   * @returns {{ sessionIds: string[], at: number, count: number }}
   */
  recentResumes(withinMs = 30 * 60 * 1000, now = Date.now()) {
    const cutoff = now - Math.max(0, withinMs)
    const sessionIds = []
    const seen = new Set()
    let latest = 0
    let count = 0
    let text = ''
    try {
      text = readFileSync(this.ledgerFile, 'utf8')
    } catch {
      return { sessionIds, at: 0, count: 0 }
    }
    if (text.length > 262144) text = text.slice(-262144)
    const lines = text.split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim()
      if (line.length === 0) continue
      let entry
      try {
        entry = JSON.parse(line)
      } catch {
        // The first line of a sliced tail can be a fragment; skip it.
        continue
      }
      if (entry === null || typeof entry !== 'object') continue
      if (entry.event !== 'resume' && entry.event !== 'resume-start') continue
      const at = typeof entry.at === 'number' && Number.isFinite(entry.at) ? entry.at : 0
      if (at < cutoff) continue
      count++
      if (at > latest) latest = at
      const planned = Array.isArray(entry.plan) ? entry.plan.map((item) => item?.id) : []
      const resumed = Array.isArray(entry.resumed) ? entry.resumed.map((item) => item?.sessionId) : []
      for (const id of [...planned, ...resumed]) {
        if (typeof id !== 'string' || id.length === 0 || seen.has(id)) continue
        seen.add(id)
        sessionIds.push(id)
      }
    }
    return { sessionIds, at: latest, count }
  }

  reportPath(label) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    return path.join(this.reportDir, `${stamp}-${label}.md`)
  }
}

function dedupe(values) {
  const seen = new Set()
  const out = []
  for (const value of values) {
    if (typeof value !== 'string' || value.length === 0 || seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}

/**
 * What a watchdog needs to relaunch this exact Harness.
 *
 * @param {string[]} argv
 * @param {{ profile?: string }} [extra]
 */
export function relaunchInfo(argv, extra = {}) {
  return {
    execPath: process.execPath,
    argv: Array.isArray(argv) ? argv.slice(1) : [],
    cwd: process.cwd(),
    profile: extra.profile ?? '',
  }
}

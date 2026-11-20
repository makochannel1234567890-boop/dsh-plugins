/**
 * dsh-crash-recovery — Host half.
 *
 * What this fixes: the sessions that operate the PC directly (desktop_*,
 * power_action, app_launch) can stop the whole Harness. When that happens the
 * process disappears without running any cleanup, every in-flight turn is lost,
 * and — observed twice on this machine — two `C:\UE` sessions stayed down for
 * hours even after a manual resume, because a fanout worker and a fanout caller
 * cannot reconstruct their own brief from a bare "please continue".
 *
 * So recovery has three parts:
 *   1. a liveness journal that survives the crash and says what was running,
 *   2. exactly ONE supervisor session that reconciles the run graph,
 *   3. a role-aware resume sweep for every session the crash stopped.
 *
 * Runs entirely on the next boot: a dead process cannot restart itself. The
 * optional `bin/watchdog.mjs` covers relaunching DSH itself.
 *
 * @module dsh-crash-recovery
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import v8 from 'node:v8'

import { classifyBoot, KIND_CRASH } from './lib/detect.js'
import { CrashJournal, defaultStoreDir, relaunchInfo } from './lib/journal.js'
import { autoResumeTargets, buildResumePlan, collectTargets, indexFanoutRuns } from './lib/resume-plan.js'
import { buildResumePrompt, buildSupervisorBrief } from './lib/prompts.js'

export const name = 'crash-recovery'

/** The tool registry is the hard dependency; session services are resolved lazily. */
export const inject = ['tools']

const SECTION_NAME = 'tool:crash-recovery'
const SECTION_ORDER = 2560

/**
 * Tools that can take the process down with them. The default set is the one
 * this machine actually observed: the desktop/social agent plus app launching.
 */
const DEFAULT_RISKY_TOOLS = [
  'power_action',
  'app_launch',
  'desktop_click',
  'desktop_type',
  'desktop_key',
  'desktop_move',
  'desktop_focus',
  'desktop_observe',
  'browse_open',
  'browse_click',
  'browse_type',
  'browse_scroll',
  'browse_close',
]

const PROMPT_SECTION = `## Crash recovery (dsh-crash-recovery)

This profile survives an unexpected Harness exit. A journal records what was
running; after a crash exactly one supervisor session reconciles the affected
fanout runs and writes a recovery report, and then the sessions the crash
stopped are resumed with a role-aware prompt (a fanout worker gets its run,
task and attempt; a caller gets the runs it started; a plain session is told to
read the on-disk state first).

The sweep is deliberately small: a few sessions per boot, paced, never the same
session twice within the cooldown window, and it stops itself while the host
heap is close to its limit. Resuming a large batch at once once took the host
down (20 workers, 4 GiB heap, repeated OOM); do not raise
\`maxSessionsPerSweep\` without measuring memory.

- \`crash_recovery_status\` reports the last crash decision, the journal, the stop
  records from session-bus, the resume plan that would run, and the cooldown /
  heap guard state.
- \`crash_recovery_resume\` runs that plan. It is a dry run unless \`dryRun:false\`.

Never replay a tool call that timed out before a crash: re-derive its result from
the files instead. Resuming a fanout worker does not resume the whole run — that
is the caller's \`fanout_control\` job.`

function log(...args) {
  try {
    console.log('[crash-recovery]', ...args)
  } catch {
    // Logging must never break the host loop.
  }
}

function clampInt(value, fallback, min, max) {
  const parsed = Number.isFinite(value) ? Math.floor(value) : fallback
  return Math.min(max, Math.max(min, parsed))
}

function clampFloat(value, fallback, min, max) {
  const parsed = Number.isFinite(value) ? value : fallback
  return Math.min(max, Math.max(min, parsed))
}

/** Share of the V8 heap limit already in use; 0 when the limit is unknown. */
function heapUsedRatio() {
  const limit = v8.getHeapStatistics().heap_size_limit
  if (!Number.isFinite(limit) || limit <= 0) return 0
  return process.memoryUsage().heapUsed / limit
}

function delay(ms) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve()
}

function resolveConfig(raw) {
  const config = raw !== null && typeof raw === 'object' ? raw : {}
  const risky = Array.isArray(config.riskyTools)
    ? config.riskyTools.filter((item) => typeof item === 'string' && item.length > 0)
    : DEFAULT_RISKY_TOOLS
  return {
    enabled: config.enabled !== false,
    storeDir:
      typeof config.storeDir === 'string' && config.storeDir.trim().length > 0
        ? config.storeDir.trim()
        : defaultStoreDir(),
    fanoutStoreDir:
      typeof config.fanoutStoreDir === 'string' && config.fanoutStoreDir.trim().length > 0
        ? config.fanoutStoreDir.trim()
        : path.join(os.homedir(), '.dsh', 'storages', 'fanout'),
    sessionBusStoreDir:
      typeof config.sessionBusStoreDir === 'string' && config.sessionBusStoreDir.trim().length > 0
        ? config.sessionBusStoreDir.trim()
        : path.join(os.homedir(), '.dsh', 'storages', 'session-bus'),
    heartbeatMs: clampInt(config.heartbeatMs, 15000, 5000, 300000),
    maxJournalAgeMs: clampInt(config.maxJournalAgeMs, 7 * 24 * 60 * 60 * 1000, 60000, 90 * 24 * 60 * 60 * 1000),
    supervise: config.supervise !== false,
    superviseAlways: config.superviseAlways === true,
    resumeOnRecovery: config.resumeOnRecovery !== false,
    resumeDelayMs: clampInt(config.resumeDelayMs, 8000, 0, 600000),
    supervisorTimeoutMs: clampInt(config.supervisorTimeoutMs, 900000, 60000, 7200000),
    verifyDelayMs: clampInt(config.verifyDelayMs, 4000, 0, 120000),
    includeSubagents: config.includeSubagents === true,
    /**
     * Deliberately small. Each resumed session starts a full agent turn and
     * keeps its transcript alive; a sweep of 20 workers grew this host to its
     * 4 GiB V8 limit ~4 minutes after boot, and every boot repeated it.
     */
    maxSessionsPerSweep: clampInt(config.maxSessionsPerSweep, 3, 1, 100),
    /** Wait between two resume prompts so the heap is not spiked in one burst. */
    resumeGapMs: clampInt(config.resumeGapMs, 8000, 0, 300000),
    /**
     * Do not auto-resume a session that was already resumed this recently: if
     * that prompt is what preceded the crash, sending it again only repeats it.
     * An explicit `crash_recovery_resume` with `sessionIds` bypasses this.
     */
    resumeCooldownMs: clampInt(config.resumeCooldownMs, 30 * 60 * 1000, 0, 24 * 60 * 60 * 1000),
    /** Stop the sweep before this share of the V8 heap limit is used. */
    resumeMemoryGuardRatio: clampFloat(config.resumeMemoryGuardRatio, 0.75, 0.3, 0.98),
    /** Members of a run older than this are not auto-resumed (12 hours). */
    maxRunAgeMs: clampInt(config.maxRunAgeMs, 12 * 60 * 60 * 1000, 60000, 90 * 24 * 60 * 60 * 1000),
    riskyTools: risky,
    resumePromptSuffix:
      typeof config.resumePromptSuffix === 'string' && config.resumePromptSuffix.trim().length > 0
        ? config.resumePromptSuffix.trim()
        : '',
    injectPrompt: config.injectPrompt !== false,
  }
}

const JSON_OUTPUT = {
  schema: { type: 'object' },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
}

/**
 * Tool results must be lossless JSON: `undefined`, NaN and friends break the
 * round trip. Normalising here keeps every branch of the two tools safe.
 */
function plain(value) {
  return JSON.parse(JSON.stringify(value ?? null))
}

// ---------------------------------------------------------------------------
// Read-only helpers over the neighbouring plugins' state
// ---------------------------------------------------------------------------

function readJsonFile(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined
  } catch {
    return undefined
  }
}

/** Every fanout run on disk, newest first. Read-only: fanout owns these files. */
function readFanoutRuns(fanoutStoreDir, limit = 60) {
  const runsDir = path.join(fanoutStoreDir, 'runs')
  let names = []
  try {
    names = readdirSync(runsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return []
  }
  const runs = []
  for (const name of names.slice(-limit * 2)) {
    const run = readJsonFile(path.join(runsDir, name, 'run.json'))
    if (run !== undefined && typeof run.id === 'string') runs.push(run)
  }
  runs.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
  return runs.slice(0, limit)
}

/**
 * Both stop records, because the two bundles write different shapes to
 * different files and resuming only one of them loses half the sessions.
 *
 * A stop record is only about the restart that followed it. The records on this
 * machine were three days old (`control-run.json` from 2026-11-16) and still
 * named 11 sessions, which every boot then tried to resume again. Records older
 * than `maxAgeMs` are therefore ignored; a record without a timestamp cannot be
 * trusted either.
 *
 * @param {string} sessionBusStoreDir
 * @param {{ now?: number, maxAgeMs?: number }} [options]
 */
function readStopRecords(sessionBusStoreDir, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  const maxAgeMs = Number.isFinite(options.maxAgeMs) ? options.maxAgeMs : 12 * 60 * 60 * 1000
  const fresh = (stamp) => {
    const at = Number(stamp)
    if (!Number.isFinite(at) || at <= 0) return false
    return maxAgeMs <= 0 || now - at <= maxAgeMs
  }
  const tool = readJsonFile(path.join(sessionBusStoreDir, 'control.json'))
  const bundle = readJsonFile(path.join(sessionBusStoreDir, 'control-run.json'))
  const toolFresh = tool !== undefined && fresh(tool.stoppedAt ?? tool.at)
  const bundleFresh = bundle !== undefined && fresh(bundle.finishedAt ?? bundle.resumeAt ?? bundle.startedAt)
  const stoppedByBus =
    toolFresh && Array.isArray(tool.sessionIds)
      ? tool.sessionIds.filter((id) => typeof id === 'string' && id.length > 0)
      : []
  const stoppedByBundle =
    bundleFresh && Array.isArray(bundle.stopped)
      ? bundle.stopped
          .map((entry) => (typeof entry === 'string' ? entry : entry?.sessionId))
          .filter((id) => typeof id === 'string' && id.length > 0)
      : []
  return {
    stoppedByBus,
    stoppedByBundle,
    controlAgeMs: toolFresh ? Math.max(0, now - Number(tool.stoppedAt ?? tool.at)) : undefined,
    runAgeMs: bundleFresh ? Math.max(0, now - Number(bundle.finishedAt ?? bundle.resumeAt ?? bundle.startedAt)) : undefined,
  }
}

function isSubagent(summary) {
  return summary?.origin === 'subagent'
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export function apply(ctx, rawConfig = {}) {
  const settings = resolveConfig(rawConfig)
  if (!settings.enabled) {
    log('disabled by config')
    return
  }

  const journal = new CrashJournal(settings.storeDir)
  const profile = typeof process.env.DSH_PROFILE === 'string' ? process.env.DSH_PROFILE : ''
  const previous = journal.readPrevious()
  const decision = classifyBoot(previous, { profile, maxAgeMs: settings.maxJournalAgeMs })
  const startedAt = Date.now()
  journal.start({
    profile,
    relaunch: relaunchInfo(process.argv, { profile }),
    heartbeatAt: startedAt,
  })
  log(`journal started (previous: ${decision.kind} — ${decision.reason})`)

  let disposed = false
  let supervisorTimer
  let heartbeatTimer
  let lastDecision = decision
  const state = {
    supervisorSessionId: '',
    supervisorStartedAt: 0,
    supervisorSettledAt: 0,
    resume: undefined,
    bootedAt: startedAt,
  }

  // -------------------------------------------------------------------------
  // Graceful-exit recording: any of these may be the last thing that runs.
  // -------------------------------------------------------------------------
  const markClean = (reason) => {
    journal.markClean(reason)
  }
  process.once('exit', () => markClean('process-exit'))
  process.once('beforeExit', () => markClean('before-exit'))

  const controller = () => {
    const service = ctx.get('sessionController')
    if (service === undefined) return undefined
    if (typeof service.create !== 'function' || typeof service.prompt !== 'function') return undefined
    return service
  }

  const listSessions = async () => {
    const service = controller()
    if (service === undefined || typeof service.list !== 'function') return []
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), 20000)
    try {
      const listed = await service.list({}, abort.signal)
      return Array.isArray(listed?.items) ? listed.items : []
    } catch (error) {
      log(`list sessions failed: ${String(error?.message ?? error)}`)
      return []
    } finally {
      clearTimeout(timer)
    }
  }

  const promptSession = async (sessionId, text, tag) => {
    const service = controller()
    if (service === undefined) throw new Error('sessionController is unavailable')
    const abort = new AbortController()
    await service.prompt(
      {
        requestId: `crash-recovery-${tag}-${randomUUID()}`,
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: settings.resumePromptSuffix ? `${text}\n\n${settings.resumePromptSuffix}` : text }],
        clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
      abort.signal,
    )
  }

  /** Read the world once: sessions, runs, stop records, candidate targets. */
  const observe = async () => {
    const [sessions, runs] = await Promise.all([
      listSessions(),
      Promise.resolve(readFanoutRuns(settings.fanoutStoreDir)),
    ])
    const records = readStopRecords(settings.sessionBusStoreDir, { maxAgeMs: settings.maxRunAgeMs })
    return { sessions, runs, records }
  }

  const buildPlan = (observed, targetIds, excludeIds) =>
    buildResumePlan({
      sessions: observed.sessions,
      runs: observed.runs,
      targetIds,
      excludeIds,
      includeSubagents: settings.includeSubagents,
    })

  // -------------------------------------------------------------------------
  // Resume sweep
  // -------------------------------------------------------------------------

  /**
   * Send the role-aware resume prompt to every planned session.
   *
   * The sweep is deliberately conservative: it is bounded
   * (`maxSessionsPerSweep`), paced (`resumeGapMs`), it skips sessions a recent
   * boot already resumed (`resumeCooldownMs`), and it stops itself while the
   * V8 heap is close to its limit (`resumeMemoryGuardRatio`). Resuming a batch
   * of 20 fanout workers in one burst took the host down three times in a row,
   * so every one of these limits is a guard against that shape of failure.
   *
   * @param {{ dryRun?: boolean, sessionIds?: string[], reason?: string }} request
   */
  const runResume = async (request = {}) => {
    const observed = await observe()
    const records = observed.records
    const explicit = Array.isArray(request.sessionIds)
      ? request.sessionIds.filter((id) => typeof id === 'string' && id.length > 0)
      : []
    const auto = explicit.length === 0
    const autoTargets = auto
      ? autoResumeTargets({
          running: previous?.runningSessions,
          risky: previous?.riskySessions,
          stoppedByBus: records.stoppedByBus,
          stoppedByBundle: records.stoppedByBundle,
          runs: observed.runs,
          maxRunAgeMs: settings.maxRunAgeMs,
        })
      : undefined
    const targets = auto ? autoTargets.targets : explicit

    // A session this boot (or the boot before) already tried to resume is not
    // re-prompted automatically: if that prompt is what came right before the
    // exit, repeating it only rebuilds the crash loop. An explicit
    // `crash_recovery_resume { sessionIds }` always wins over the cooldown.
    const cooling =
      auto && settings.resumeCooldownMs > 0
        ? new Set(journal.recentResumes(settings.resumeCooldownMs).sessionIds)
        : new Set()
    const cooledDown = []
    const candidates = targets.filter((id) => {
      if (!cooling.has(id)) return true
      cooledDown.push({ sessionId: id, reason: 'recently-resumed' })
      return false
    })

    const excludeIds = [state.supervisorSessionId].filter((id) => typeof id === 'string' && id.length > 0)
    const { plan, skipped } = buildPlan(observed, candidates, excludeIds)
    const limited = plan.slice(0, settings.maxSessionsPerSweep)
    const truncated = Math.max(0, plan.length - limited.length)
    const reportPath = journal.reportPath('resume')

    if (request.dryRun !== false) {
      return plain({
        ok: true,
        dryRun: true,
        reason: request.reason ?? 'dry-run',
        targets: candidates.length,
        interrupted: autoTargets?.interrupted ?? candidates.length,
        runMembers: autoTargets?.runMembers ?? 0,
        plan: limited,
        skipped,
        cooledDown,
        truncated,
        heapUsedRatio: Number(heapUsedRatio().toFixed(3)),
        reportPath,
        note:
          auto && autoTargets?.interrupted === 0
            ? 'Nothing was interrupted at the crash and no fresh stop record exists: the automatic sweep is empty.'
            : 'Pass dryRun:false to send these prompts.',
      })
    }

    if (limited.length === 0) {
      const empty = {
        ok: true,
        dryRun: false,
        at: Date.now(),
        requested: 0,
        interrupted: autoTargets?.interrupted ?? 0,
        runMembers: autoTargets?.runMembers ?? 0,
        resumed: [],
        failed: [],
        deferred: [],
        skipped,
        cooledDown,
        truncated,
        heapUsedRatio: Number(heapUsedRatio().toFixed(3)),
        reportPath,
        note: 'Nothing to resume: the exit did not interrupt a session and no fresh stop record exists.',
      }
      state.resume = empty
      journal.record({
        event: 'resume-skipped',
        reason: auto ? 'nothing-interrupted' : 'empty-plan',
        interrupted: empty.interrupted,
        runMembers: empty.runMembers,
      })
      return plain(empty)
    }

    journal.record({
      event: 'resume-start',
      reason: request.reason ?? 'manual',
      plan: limited.map((item) => ({ id: item.sessionId, kind: item.kind })),
      heapUsedRatio: Number(heapUsedRatio().toFixed(3)),
    })

    const resumed = []
    const failed = []
    const deferred = []
    for (let index = 0; index < limited.length; index++) {
      const ratio = heapUsedRatio()
      if (ratio >= settings.resumeMemoryGuardRatio) {
        for (const rest of limited.slice(index)) {
          deferred.push({ sessionId: rest.sessionId, kind: rest.kind, reason: 'memory-pressure' })
        }
        log(`resume sweep stopped: heap ${Number((ratio * 100).toFixed(1))}% of the V8 limit`)
        break
      }
      if (index > 0) await delay(settings.resumeGapMs)
      const entry = limited[index]
      try {
        await promptSession(entry.sessionId, buildResumePrompt(entry, { reportPath }), entry.kind)
        resumed.push({ sessionId: entry.sessionId, kind: entry.kind })
        log(`resumed ${entry.kind} ${entry.sessionId}`)
      } catch (error) {
        failed.push({ sessionId: entry.sessionId, error: String(error?.message ?? error) })
        log(`resume failed ${entry.sessionId}: ${String(error?.message ?? error)}`)
      }
    }

    // Verify on the live list: "accepted" is not "running".
    if (settings.verifyDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, settings.verifyDelayMs))
    const after = await listSessions()
    const runningNow = new Set(after.filter((item) => item.running === true).map((item) => item.sessionId))
    const verified = resumed.map((item) => ({
      sessionId: item.sessionId,
      kind: item.kind,
      running: runningNow.has(item.sessionId),
    }))

    const result = {
      ok: failed.length === 0,
      dryRun: false,
      at: Date.now(),
      requested: limited.length,
      interrupted: autoTargets?.interrupted ?? 0,
      runMembers: autoTargets?.runMembers ?? 0,
      resumed: verified,
      failed,
      deferred,
      skipped,
      cooledDown,
      truncated,
      heapUsedRatio: Number(heapUsedRatio().toFixed(3)),
      runningCount: verified.filter((item) => item.running).length,
      reportPath,
      note:
        verified.length > 0 && verified.every((item) => item.running)
          ? 'All prompted sessions are running.'
          : 'accepted prompt does not prove the turn started; check crash_recovery_status after a few seconds.',
    }
    state.resume = result
    journal.record({ event: 'resume', ...result, plan: limited.map((item) => ({ id: item.sessionId, kind: item.kind })) })
    return plain(result)
  }

  // -------------------------------------------------------------------------
  // Supervisor
  // -------------------------------------------------------------------------

  const finishRecovery = async (reason) => {
    state.supervisorSettledAt = Date.now()
    journal.beat({ supervisorSessionId: state.supervisorSessionId })
    log(`supervisor settled (${reason}); starting resume sweep`)
    if (!settings.resumeOnRecovery) {
      journal.record({ event: 'resume-skipped', reason })
      return
    }
    if (settings.resumeDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, settings.resumeDelayMs))
    if (disposed) return
    try {
      await runResume({ dryRun: false, reason: `after-supervisor:${reason}` })
    } catch (error) {
      log(`resume sweep failed: ${String(error?.message ?? error)}`)
      journal.record({ event: 'resume-sweep-failed', error: String(error?.message ?? error) })
    }
  }

  const armSupervisorWatch = (sessionId) => {
    state.supervisorSessionId = sessionId
    state.supervisorStartedAt = Date.now()
    journal.beat({ supervisorSessionId: sessionId })
    supervisorTimer = setTimeout(() => {
      if (disposed) return
      log('supervisor did not settle in time; continuing to the resume sweep')
      void finishRecovery('timeout')
    }, settings.supervisorTimeoutMs)
    if (typeof supervisorTimer.unref === 'function') supervisorTimer.unref()
  }

  const spawnSupervisor = async (crash, observed) => {
    const service = controller()
    if (service === undefined || typeof service.create !== 'function') {
      log('no sessionController.create; skipping the supervisor session')
      return undefined
    }
    const reportPath = journal.reportPath('recovery')
    const crashTargets = autoResumeTargets({
      running: crash.running,
      risky: crash.risky,
      stoppedByBus: observed.records.stoppedByBus,
      stoppedByBundle: observed.records.stoppedByBundle,
      runs: observed.runs,
      maxRunAgeMs: settings.maxRunAgeMs,
    })
    const { plan } = buildPlan(observed, crashTargets.targets, [])
    const cwd = plan.find((item) => item.cwd && existsSync(item.cwd))?.cwd ?? process.cwd()
    const created = await service.create({ cwd })
    const sessionId = created?.sessionId
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      log('sessionController.create returned no sessionId')
      return undefined
    }
    const brief = buildSupervisorBrief({
      crashAt: Number(previous?.heartbeatAt),
      reportPath,
      observed: { risky: crash.risky, running: crash.running, fanoutRuns: crash.runs },
      planPreview: plan.slice(0, 12).map((item) => ({ sessionId: item.sessionId, kind: item.kind, runId: item.runId })),
    })
    await promptSession(sessionId, brief, 'supervisor')
    armSupervisorWatch(sessionId)
    journal.record({ event: 'supervisor-spawned', sessionId, crashId: crash.crashId, reportPath })
    log(`supervisor ${sessionId} spawned (report ${reportPath})`)
    return sessionId
  }

  // -------------------------------------------------------------------------
  // Crash handling on boot
  // -------------------------------------------------------------------------

  const handleCrash = async () => {
    const crash = lastDecision
    const observed = await observe()
    const shouldSupervise = settings.supervise && (crash.supervised === true || settings.superviseAlways)
    const targets = collectTargets({
      running: crash.running,
      risky: crash.risky,
      stoppedByBus: observed.records.stoppedByBus,
      stoppedByBundle: observed.records.stoppedByBundle,
    })
    journal.record({
      event: 'crash-detected',
      crashId: crash.crashId,
      reason: crash.reason,
      ageMs: crash.ageMs,
      risky: crash.risky,
      running: crash.running,
      fanoutRuns: crash.runs,
      targets: targets.length,
      supervise: shouldSupervise,
    })

    if (!shouldSupervise) {
      log('nothing was running at the crash; recording it and resuming any stopped sessions')
      await finishRecovery('nothing-to-supervise')
      return
    }

    const claim = journal.claimSupervisor({ crashId: crash.crashId })
    if (!claim.claimed) {
      log(`supervisor already claimed (${claim.reason}); resuming without a second supervisor`)
      await finishRecovery('already-claimed')
      return
    }

    try {
      const sessionId = await spawnSupervisor(crash, observed)
      if (sessionId === undefined) {
        journal.clearClaim()
        await finishRecovery('supervisor-unavailable')
      }
    } catch (error) {
      log(`supervisor spawn failed: ${String(error?.message ?? error)}`)
      journal.clearClaim()
      await finishRecovery('supervisor-failed')
    }
  }

  // Boot work happens off the apply hook so no tool dispatch timeout applies.
  void (async () => {
    try {
      if (lastDecision.kind === KIND_CRASH) await handleCrash()
    } catch (error) {
      log(`crash handling failed: ${String(error?.message ?? error)}`)
      journal.record({ event: 'crash-handling-failed', error: String(error?.message ?? error) })
    }
  })()

  // -------------------------------------------------------------------------
  // Heartbeat: what was running when we last looked
  // -------------------------------------------------------------------------

  heartbeatTimer = setInterval(() => {
    if (disposed) return
    void (async () => {
      try {
        const sessions = await listSessions()
        const running = sessions.filter((item) => item.running === true && !isSubagent(item)).map((item) => item.sessionId)
        const runs = readFanoutRuns(settings.fanoutStoreDir)
          .filter((run) => run.status === 'running' || run.status === 'integrating' || run.status === 'staged')
          .map((run) => run.id)
        journal.beat({ runningSessions: running, fanoutRuns: runs })
      } catch (error) {
        journal.beat()
        log(`heartbeat failed: ${String(error?.message ?? error)}`)
      }
    })()
  }, settings.heartbeatMs)
  if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref()

  // -------------------------------------------------------------------------
  // Risky tool call tracking
  // -------------------------------------------------------------------------

  const risky = new Set(settings.riskyTools)
  const listen = (eventName, handler) => {
    try {
      ctx.on(eventName, handler, { global: true })
    } catch (error) {
      log(`could not listen on ${eventName}: ${String(error)}`)
    }
  }
  listen('session/event', (session, event) => {
    const sessionId = session?.id
    if (typeof sessionId !== 'string') return
    if (event?.type !== 'tool/call') return
    const toolName = event.data?.name
    if (typeof toolName !== 'string' || !risky.has(toolName)) return
    journal.markRisky(sessionId, toolName)
  })
  listen('api-session/status', (sessionId, running) => {
    // 監督セッションが終わった瞬間が、復旧の完了点。
    if (state.supervisorSessionId.length === 0 || sessionId !== state.supervisorSessionId) return
    if (running === true) return
    if (state.supervisorSettledAt > 0) return
    if (settings.supervisorTimeoutMs === 0) return
    if (supervisorTimer !== undefined) {
      clearTimeout(supervisorTimer)
      supervisorTimer = undefined
    }
    void finishRecovery('supervisor-idle')
  })

  // -------------------------------------------------------------------------
  // Tools
  // -------------------------------------------------------------------------

  ctx.tools.register({
    name: 'crash_recovery_status',
    description:
      'Report the crash-recovery state: what the last boot concluded about the previous process (crash, clean, foreign profile, stale), the liveness journal, both session-bus stop records, the live fanout runs, and the resume plan that would run.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: JSON_OUTPUT,
    timeoutMs: 20000,
    async execute() {
      const observed = await observe()
      const crashTargets = autoResumeTargets({
        running: previous?.runningSessions,
        risky: previous?.riskySessions,
        stoppedByBus: observed.records.stoppedByBus,
        stoppedByBundle: observed.records.stoppedByBundle,
        runs: observed.runs,
        maxRunAgeMs: settings.maxRunAgeMs,
      })
      const targets = crashTargets.targets
      const { plan, skipped } = buildPlan(observed, targets, [state.supervisorSessionId].filter(Boolean))
      const cooldown = journal.recentResumes(settings.resumeCooldownMs)
      return plain({
        ok: true,
        boot: { pid: process.pid, bootedAt: state.bootedAt, uptimeMs: Date.now() - state.bootedAt },
        previousBoot: {
          decision: lastDecision.kind,
          reason: lastDecision.reason,
          ageMs: lastDecision.ageMs,
          crashId: lastDecision.crashId,
          risky: lastDecision.risky,
          running: lastDecision.running,
          fanoutRuns: lastDecision.runs,
        },
        journal: journal.state ?? null,
        supervisor: {
          sessionId: state.supervisorSessionId,
          startedAt: state.supervisorStartedAt,
          settledAt: state.supervisorSettledAt,
          timeoutMs: settings.supervisorTimeoutMs,
        },
        stopRecords: observed.records,
        fanout: {
          total: observed.runs.length,
          active: observed.runs
            .filter((run) => run.status === 'running' || run.status === 'integrating' || run.status === 'staged')
            .map((run) => ({ id: run.id, status: run.status, cwd: run.cwd })),
          stopped: observed.runs.filter((run) => run.status === 'stopped').map((run) => run.id),
        },
        resume: {
          targets: targets.length,
          interrupted: crashTargets.interrupted,
          runMembers: crashTargets.runMembers,
          plan,
          skipped,
          last: state.resume ?? null,
        },
        cooldown: {
          windowMs: settings.resumeCooldownMs,
          counts: cooldown.count,
          lastResumeAt: cooldown.at,
          sessionIds: cooldown.sessionIds,
          heapUsedRatio: Number(heapUsedRatio().toFixed(3)),
          memoryGuardRatio: settings.resumeMemoryGuardRatio,
        },
        config: {
          supervise: settings.supervise,
          superviseAlways: settings.superviseAlways,
          resumeOnRecovery: settings.resumeOnRecovery,
          heartbeatMs: settings.heartbeatMs,
          maxSessionsPerSweep: settings.maxSessionsPerSweep,
          resumeGapMs: settings.resumeGapMs,
          maxRunAgeMs: settings.maxRunAgeMs,
          riskyTools: [...risky],
        },
      })
    },
    presentCall: () => ({ card: 'generic', title: 'Crash recovery status', kind: 'other' }),
  })

  ctx.tools.register({
    name: 'crash_recovery_resume',
    description:
      'Resume sessions that a crash stopped, with a role-aware prompt rebuilt from the fanout run graph (a worker gets its run/task/attempt, a caller gets the runs it started, a plain session is told to re-derive state from disk). Dry run unless dryRun:false. Also verifies on the live session list whether each prompted session actually started running.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        sessionIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Explicit session ids. Omit to use the crash journal plus both session-bus stop records.',
        },
        dryRun: { type: 'boolean', description: 'Default true: report the plan without sending prompts.' },
        reason: { type: 'string', description: 'Why this sweep is being run; recorded in the ledger.' },
      },
    },
    output: JSON_OUTPUT,
    timeoutMs: 120000,
    async execute(args) {
      return runResume({
        dryRun: args?.dryRun !== false,
        sessionIds: Array.isArray(args?.sessionIds) ? args.sessionIds : [],
        reason: typeof args?.reason === 'string' && args.reason.trim().length > 0 ? args.reason.trim() : 'model-request',
      })
    },
    presentCall: (args) => ({
      card: 'generic',
      title: args?.dryRun === false ? 'Crash recovery resume' : 'Crash recovery resume (dry run)',
      kind: 'other',
    }),
  })

  // -------------------------------------------------------------------------
  // Prompt + cleanup
  // -------------------------------------------------------------------------

  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt !== undefined && settings.injectPrompt) {
    try {
      systemPrompt.section({ name: SECTION_NAME, order: SECTION_ORDER, text: PROMPT_SECTION })
    } catch (error) {
      log(`prompt section failed: ${String(error)}`)
    }
  }

  ctx.effect(() => () => {
    disposed = true
    if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer)
    if (supervisorTimer !== undefined) clearTimeout(supervisorTimer)
    // A plugin reload keeps the process alive: mark clean so the next boot does
    // not misread a hot reload as a crash.
    markClean('plugin-unload')
    log('disposed')
  })

  log(`active (store=${settings.storeDir}, heartbeat=${settings.heartbeatMs}ms, supervise=${settings.supervise})`)
}

/** Exported for tests: the fanout index is also useful to callers of status(). */
export { indexFanoutRuns }

/**
 * Pure resume planning for dsh-crash-recovery.
 *
 * The observed failure: sending "please continue" to a session that a fanout
 * run owns does not bring it back. A worker lost its brief, an integrator lost
 * which report it was waiting on, and a caller is looking at runs that are all
 * `stopped`. The prompt has to be rebuilt from the run graph, so this module
 * answers one question — *what is this session in the run graph?* — and nothing
 * else. It performs no I/O.
 *
 * @module dsh-crash-recovery/lib/resume-plan
 */

export const KIND_FANOUT_WORKER = 'fanout-worker'
export const KIND_FANOUT_REVIEW = 'fanout-review'
export const KIND_FANOUT_INTEGRATOR = 'fanout-integrator'
export const KIND_FANOUT_CALLER = 'fanout-caller'
export const KIND_FANOUT_OTHER = 'fanout-other'
export const KIND_PLAIN = 'plain'

/** Resuming order: the sessions that produce results go first, callers last. */
const ORDER = new Map([
  [KIND_FANOUT_WORKER, 0],
  [KIND_FANOUT_INTEGRATOR, 1],
  [KIND_FANOUT_REVIEW, 2],
  [KIND_FANOUT_OTHER, 3],
  [KIND_FANOUT_CALLER, 4],
  [KIND_PLAIN, 5],
])

function roleKind(role) {
  switch (role) {
    case 'task':
      return KIND_FANOUT_WORKER
    case 'review':
      return KIND_FANOUT_REVIEW
    case 'integrator':
      return KIND_FANOUT_INTEGRATOR
    case 'caller':
      return KIND_FANOUT_CALLER
    default:
      return KIND_FANOUT_OTHER
  }
}

/**
 * Map every session a fanout run mentions to the role it played there.
 *
 * A session can be a caller for several runs; the worker role wins because it
 * carries the concrete task. Later runs do not overwrite an earlier worker hit.
 *
 * @param {Array<any>} runs parsed `run.json` documents
 * @returns {Map<string, any>}
 */
export function indexFanoutRuns(runs) {
  const index = new Map()
  const keep = (sessionId, entry) => {
    const previous = index.get(sessionId)
    if (previous === undefined) {
      index.set(sessionId, entry)
      return
    }
    if (previous.kind === KIND_FANOUT_CALLER && entry.kind !== KIND_FANOUT_CALLER) index.set(sessionId, entry)
    if (previous.kind === KIND_FANOUT_CALLER && entry.kind === KIND_FANOUT_CALLER) {
      // Keep every run the caller started: it has to be told about all of them.
      const runIds = new Set([...(previous.runIds ?? [previous.runId]), entry.runId])
      previous.runIds = [...runIds]
    }
  }

  for (const run of Array.isArray(runs) ? runs : []) {
    if (run === null || typeof run !== 'object') continue
    const runId = typeof run.id === 'string' ? run.id : ''
    if (runId.length === 0) continue
    const runStatus = typeof run.status === 'string' ? run.status : ''
    const objective = typeof run.objective === 'string' ? run.objective : ''
    const cwd = typeof run.cwd === 'string' ? run.cwd : ''

    if (typeof run.callerSessionId === 'string' && run.callerSessionId.length > 0) {
      keep(run.callerSessionId, {
        kind: KIND_FANOUT_CALLER,
        runId,
        runIds: [runId],
        runStatus,
        objective,
        cwd,
        role: 'caller',
        taskId: '',
        attemptId: '',
      })
    }

    for (const session of Array.isArray(run.sessions) ? run.sessions : []) {
      const sessionId = typeof session?.id === 'string' ? session.id : ''
      if (sessionId.length === 0) continue
      const role = typeof session.role === 'string' ? session.role : ''
      const entry = {
        kind: roleKind(role),
        runId,
        runIds: [runId],
        runStatus,
        objective,
        cwd,
        role,
        taskId: typeof session.taskId === 'string' ? session.taskId : '',
        attemptId: typeof session.attemptId === 'string' ? session.attemptId : '',
        state: typeof session.state === 'string' ? session.state : '',
        cause: typeof session.cause === 'string' ? session.cause : '',
      }
      const previous = index.get(sessionId)
      if (previous === undefined || ORDER.get(entry.kind) < ORDER.get(previous.kind)) index.set(sessionId, entry)
    }
  }
  return index
}

/**
 * Turn a pile of candidate ids into an ordered, classified resume plan.
 *
 * @param {{
 *   sessions: Array<{sessionId: string, running?: boolean, origin?: string, cwd?: string}>,
 *   runs?: Array<any>,
 *   targetIds: Iterable<string>,
 *   excludeIds?: Iterable<string>,
 *   includeSubagents?: boolean,
 * }} input
 * @returns {{ plan: Array<any>, skipped: Array<{ sessionId: string, reason: string }> }}
 */
export function buildResumePlan(input) {
  const sessions = Array.isArray(input?.sessions) ? input.sessions : []
  const fanout = indexFanoutRuns(input?.runs)
  const exclude = new Set()
  for (const id of input?.excludeIds ?? []) {
    if (typeof id === 'string' && id.length > 0) exclude.add(id)
  }
  const includeSubagents = input?.includeSubagents === true

  const byId = new Map()
  for (const session of sessions) {
    if (typeof session?.sessionId === 'string' && session.sessionId.length > 0) byId.set(session.sessionId, session)
  }

  const plan = []
  const skipped = []
  const seen = new Set()
  for (const id of input?.targetIds ?? []) {
    if (typeof id !== 'string' || id.length === 0 || seen.has(id)) continue
    seen.add(id)
    if (exclude.has(id)) {
      skipped.push({ sessionId: id, reason: 'excluded' })
      continue
    }
    const session = byId.get(id)
    if (session === undefined) {
      skipped.push({ sessionId: id, reason: 'not-visible' })
      continue
    }
    if (session.running === true) {
      skipped.push({ sessionId: id, reason: 'already-running' })
      continue
    }
    if (session.origin === 'subagent' && !includeSubagents) {
      skipped.push({ sessionId: id, reason: 'subagent' })
      continue
    }
    const membership = fanout.get(id)
    plan.push({
      sessionId: id,
      kind: membership?.kind ?? KIND_PLAIN,
      cwd: typeof session.cwd === 'string' && session.cwd.length > 0 ? session.cwd : '',
      runId: membership?.runId ?? '',
      runIds: membership?.runIds ?? [],
      runStatus: membership?.runStatus ?? '',
      objective: membership?.objective ?? '',
      role: membership?.role ?? '',
      taskId: membership?.taskId ?? '',
      attemptId: membership?.attemptId ?? '',
      state: membership?.state ?? '',
      cause: membership?.cause ?? '',
    })
  }

  plan.sort((a, b) => (ORDER.get(a.kind) ?? 9) - (ORDER.get(b.kind) ?? 9))
  return { plan, skipped }
}

/**
 * Candidate sessions for a crash: what the journal saw, plus every id the two
 * session-bus stop records remember. Deduped, order preserved.
 *
 * @param {{
 *   running?: string[],
 *   risky?: string[],
 *   stoppedByBus?: string[],
 *   stoppedByBundle?: string[],
 *   runMembers?: string[],
 * }} sources
 */
export function collectTargets(sources) {
  const seen = new Set()
  const out = []
  for (const list of [
    sources?.running,
    sources?.risky,
    sources?.stoppedByBus,
    sources?.stoppedByBundle,
    sources?.runMembers,
  ]) {
    for (const id of list ?? []) {
      if (typeof id !== 'string' || id.length === 0 || seen.has(id)) continue
      seen.add(id)
      out.push(id)
    }
  }
  return out
}

/**
 * Sessions that belong to a fanout run nobody finished.
 *
 * This is the case a stop record cannot cover: the two `C:\UE` sessions stayed
 * down for hours because they were a caller and a worker of `stopped`/`failed`
 * runs, not sessions that a stop sweep had cancelled. Without this source the
 * resume plan is blind exactly where it matters.
 *
 * Only sessions whose run record still says they are unfinished count: a
 * `settled`/`cancelled` worker already reported its attempt, so re-prompting it
 * cannot complete the dead run — it only adds another heavy turn. Resuming a
 * whole batch of those was what took the host down on 2026-11-19 (20 workers,
 * three OOM exits about four minutes apart). Callers are always kept: they own
 * the decision about the run.
 *
 * @param {Array<any>} runs
 * @param {{ now?: number, maxAgeMs?: number, includeSettled?: boolean }} [options]
 */
export function sessionsOfUnfinishedRuns(runs, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  const maxAgeMs = Number.isFinite(options.maxAgeMs) ? options.maxAgeMs : 7 * 24 * 60 * 60 * 1000
  const includeSettled = options.includeSettled === true
  const unfinished = new Set(['stopped', 'failed', 'staged', 'escalated', 'paused'])
  const finishedSessionStates = new Set(['settled', 'cancelled'])
  const seen = new Set()
  const out = []
  const push = (id) => {
    if (typeof id !== 'string' || id.length === 0 || seen.has(id)) return
    seen.add(id)
    out.push(id)
  }
  for (const run of Array.isArray(runs) ? runs : []) {
    if (run === null || typeof run !== 'object') continue
    if (!unfinished.has(run.status)) continue
    const stamp = Number(run.updatedAt ?? run.createdAt ?? 0)
    if (maxAgeMs > 0 && stamp > 0 && now - stamp > maxAgeMs) continue
    for (const session of Array.isArray(run.sessions) ? run.sessions : []) {
      if (!includeSettled) {
        const state = typeof session?.state === 'string' ? session.state : ''
        if (finishedSessionStates.has(state)) continue
      }
      push(session?.id)
    }
    push(run.callerSessionId)
  }
  return out
}

/**
 * The automatic sweep's target list.
 *
 * Recovery is only interesting when the exit actually interrupted something.
 * On this machine the Desktop shell kills the Host process on every quit, so a
 * *normal* restart is recorded as "no clean shutdown" too. Pulling every member
 * of every unfinished run into that case resumed three old fanout callers on a
 * plain restart (2026-11-20 07:27) — work the human had already left alone.
 *
 * The rule is therefore: the journal's own observations (running / risky) and
 * fresh session-bus stop records are the only sources that can *start* a sweep.
 * Members of unfinished runs are added as supporting candidates only when one
 * of those sources shows that something was interrupted.
 *
 * @param {{
 *   running?: string[],
 *   risky?: string[],
 *   stoppedByBus?: string[],
 *   stoppedByBundle?: string[],
 *   runs?: Array<any>,
 *   maxRunAgeMs?: number,
 * }} input
 * @returns {{ targets: string[], interrupted: number, runMembers: number }}
 */
export function autoResumeTargets(input = {}) {
  const interrupted = collectTargets({
    running: input.running,
    risky: input.risky,
    stoppedByBus: input.stoppedByBus,
    stoppedByBundle: input.stoppedByBundle,
  })
  if (interrupted.length === 0) return { targets: [], interrupted: 0, runMembers: 0 }
  const runMembers = sessionsOfUnfinishedRuns(input.runs, {
    now: Number.isFinite(input.now) ? input.now : undefined,
    maxAgeMs: Number.isFinite(input.maxRunAgeMs) ? input.maxRunAgeMs : 12 * 60 * 60 * 1000,
  })
  return {
    targets: collectTargets({ running: interrupted, runMembers }),
    interrupted: interrupted.length,
    runMembers: runMembers.length,
  }
}

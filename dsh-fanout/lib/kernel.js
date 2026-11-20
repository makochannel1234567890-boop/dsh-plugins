/**
 * dsh-fanout v2 kernel — task-graph orchestration with quality gates.
 *
 * One run is a DAG of tasks. Every attempt is an ordinary Harness session; its
 * answer is a file with a fixed line protocol (lib/gates.js). A completed task
 * is reviewed by a fresh reviewer node, a failing verdict splices in a repair
 * node, and the whole run is integrated by one final session that must write a
 * parsable report.
 *
 * Capabilities this adds over the v1 engine (and over a captain-driven team):
 *   - dependencies, review/repair rounds and acceptance evidence are enforced
 *     by parsers, not by prose;
 *   - every attempt carries an id, so a stale answer can never be accepted;
 *   - staged plans (approval required) and pause/resume/retry/steer/edit;
 *   - file-backed recovery: an in-flight run is adopted again after a Host
 *     restart or a plugin reload.
 *
 * Nothing here writes the session log: state lives in run.json / result files.
 *
 * @module dsh-fanout/lib/kernel
 */

import { randomUUID } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import path from 'node:path'

import {
  attemptToken,
  graphSummary,
  insertRepair,
  insertReview,
  isReviewedKind,
  nextAttempt,
  normalizeGraph,
  progressPercent,
  readyTasks,
  stateSummary,
  taskById,
  validateGraph,
} from './graph.js'
import { admit, appendTasks as appendQueueTasks, DEFER_REASONS, queueView } from './queue.js'
import { parseResult, parseReview, validateFinal, validateResult, validateReview } from './gates.js'
import { decideBudget, graphFit } from './arm.js'
import {
  applySelection,
  buildSelections,
  DEFAULT_MODEL_EFFORT,
  describeTarget,
  pickTarget,
} from './model.js'
import { estimateBudget, expansionPlan, makeRunId, phaseOf, progressOf } from './plan.js'
import { DIVERGENCE_AXES, renderProbeBrief } from './prompts.js'
import {
  buildManifest,
  cachePrefixHash,
  CONTRACT_VERSION,
  DEFAULT_OBJECTIVE_HEAD_CHARS,
  manifestJsonRelative,
  manifestRelative,
  objectiveRelative,
  promptRelative,
  renderManifestMarkdown,
  runDirRelative,
  sha256,
} from './context.js'
import {
  finalRelative,
  renderCallerDigest,
  renderIntegratorBrief,
  renderIntegratorRepair,
  renderReviewBrief,
  renderStagedPlan,
  renderStatusSummary,
  renderTaskBrief,
  resultRelative,
} from './prompts2.js'

const ACTIVE = new Set(['staged', 'running', 'paused', 'integrating'])
const TERMINAL = new Set(['completed', 'failed', 'stopped'])
/** Statuses the v1 UI already knows; everything else is mapped down in uiState. */
const UI_STATUS = { staged: 'queued', paused: 'queued', escalated: 'failed' }

function nowIso() {
  return new Date().toISOString()
}

function messageText(message) {
  const blocks = Array.isArray(message?.content) ? message.content : []
  let out = ''
  for (const block of blocks) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      out += `${out.length > 0 ? '\n' : ''}${block.text}`
    }
  }
  return out
}

/** Text of the last assistant message in an inspect() event list. */
export function lastAssistantText(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'assistant/message') {
      const text = messageText(event.data?.message)
      if (text.trim().length > 0) return text.trim()
    }
  }
  return ''
}

/** Parse "OPTION: …" lines out of a probe answer. */
export function parseOptionLines(text) {
  const options = []
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const match = /^\s*(?:[-*]\s*)?OPTION\s*[:：]\s*(.+?)\s*$/i.exec(line)
    if (match === null) continue
    const value = match[1].trim()
    if (value.length === 0) continue
    options.push(value.slice(0, 200))
    if (options.length >= 4) break
  }
  return options
}

export class FanoutKernel {
  constructor({ ctx, store, config, log }) {
    this.ctx = ctx
    this.store = store
    this.config = config
    this.log = log ?? (() => {})
    this.runs = new Map()
    this.tracked = new Map()
    this.chain = Promise.resolve()
    this.timer = undefined
    this.disposed = false
    // Sessions whose composer checkbox is checked. The flag is one-shot: it is
    // consumed by the next fanout_start (or refused start) from that session.
    this.armed = new Map()
    // Resolved once per process: the live catalog is authoritative, so a model
    // rename never strands the fan-out on a hardcoded id.
    this.modelTarget = undefined
    this.modelSelections = undefined
    this.modelLabel = ''
    this.modelError = ''
  }

  // ---------------------------------------------------------------------
  // Services and plumbing
  // ---------------------------------------------------------------------

  controller() {
    const service = this.ctx.get('sessionController')
    if (service === undefined || typeof service.create !== 'function' || typeof service.prompt !== 'function') {
      throw new Error('dsh-fanout: sessionController is unavailable in this composition')
    }
    return service
  }

  agentsService() {
    return this.ctx.get('agents')
  }

  createUserMessage(input) {
    return Object.freeze({ ...input, id: randomUUID(), role: 'user' })
  }

  // ---------------------------------------------------------------------
  // Model target and lineage
  // ---------------------------------------------------------------------

  /** Hard ceiling on nested runs: 3 levels = root run, child run, grandchild run. */
  maxDepth() {
    const raw = Number(this.config?.maxDepth)
    return Number.isFinite(raw) && raw >= 1 ? Math.min(4, Math.floor(raw)) : 3
  }

  /**
   * Resolve the configured model against the live catalog, once.
   *
   * @returns {Promise<{ label: string, error: string, selections: object[] }>}
   */
  async resolveModel() {
    if (this.modelSelections !== undefined) {
      return { label: this.modelLabel, error: this.modelError, selections: this.modelSelections }
    }
    const controller = this.controller()
    if (typeof controller.modelCatalog !== 'function') {
      this.modelSelections = []
      this.modelError = 'modelCatalog is unavailable in this composition'
      return { label: '', error: this.modelError, selections: [] }
    }
    try {
      const catalog = await controller.modelCatalog()
      const picked = pickTarget(catalog, {
        pattern: this.config?.modelPattern,
        effort: this.config?.modelEffort ?? DEFAULT_MODEL_EFFORT,
      })
      if (picked.target === null) {
        this.modelSelections = []
        this.modelError = `no catalog model matches ${String(this.config?.modelPattern ?? '')} (${picked.groups} provider groups scanned)`
        this.log(`model target unresolved: ${this.modelError}`)
        return { label: '', error: this.modelError, selections: [] }
      }
      this.modelSelections = buildSelections(catalog?.default, picked.target)
      this.modelLabel = describeTarget(picked.target)
      this.modelError = ''
      this.log(`model target resolved (${picked.matchedBy}): ${this.modelLabel}`)
      return { label: this.modelLabel, error: '', selections: this.modelSelections }
    } catch (error) {
      this.modelSelections = []
      this.modelError = String(error?.message ?? error)
      this.log(`model catalog failed: ${this.modelError}`)
      return { label: '', error: this.modelError, selections: [] }
    }
  }

  /**
   * Switch one session to the run model. Never throws: a run must not die
   * because a model could not be selected, but the reason is logged once.
   *
   * @param {string} sessionId
   * @returns {Promise<boolean>}
   */
  async adoptModel(sessionId) {
    const { selections, error } = await this.resolveModel()
    if (selections.length === 0) {
      if (error.length > 0) this.log(`model not applied to ${sessionId}: ${error}`)
      return false
    }
    const result = await applySelection(this.controller(), sessionId, selections)
    if (!result.ok) this.log(`model not applied to ${sessionId}: ${result.error ?? 'unknown'}`)
    return result.ok
  }

  /**
   * The run a session belongs to — as its caller or as one of its workers.
   * Nested fan-out is addressed by this, so a worker's own run is a child.
   *
   * @param {string} sessionId
   */
  lineageOf(sessionId) {
    const id = typeof sessionId === 'string' ? sessionId.trim() : ''
    if (id.length === 0) return undefined
    let found
    for (const run of this.runs.values()) {
      if (String(run.callerSessionId ?? '') === id) found = run
      else if ((run.sessions ?? []).some((row) => String(row?.id ?? '') === id)) found = run
      else if ((run.tasks ?? []).some((task) => String(task?.sessionId ?? '') === id)) found = run
      if (found !== undefined) return found
    }
    return undefined
  }

  /** Serialise all state transitions: events arrive concurrently. */
  enqueue(task) {
    const run = this.chain.then(task)
    this.chain = run.then(() => undefined).catch((error) => this.log(`chain failed: ${String(error)}`))
    return run
  }

  async init() {
    await this.store.ensure().catch((error) => this.log(`ensure store failed: ${String(error)}`))
    await this.recover().catch((error) => this.log(`recover failed: ${String(error)}`))
    this.timer = setInterval(() => {
      try {
        this.tick()
      } catch (error) {
        this.log(`watchdog failed: ${String(error)}`)
      }
    }, 15000)
    if (typeof this.timer.unref === 'function') this.timer.unref()
  }

  dispose() {
    this.disposed = true
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
  }

  callerCwd(caller) {
    try {
      const service = this.ctx.get('workingDirectory')
      const value = service?.get?.(caller?.session)
      if (typeof value === 'string' && value.length > 0) return value
    } catch {
      // Fall through to the process directory.
    }
    return process.cwd()
  }

  // ---------------------------------------------------------------------
  // Session tracking
  // ---------------------------------------------------------------------

  trackSession(run, role, meta) {
    const entry = {
      runId: run.id,
      role,
      ...meta,
      running: false,
      started: false,
      settled: false,
      settledAt: 0,
      cause: '',
      lastReason: undefined,
      deadlineAt: 0,
      waiter: undefined,
      promptDone: Promise.resolve(),
      promptError: '',
    }
    this.tracked.set(entry.sessionId, entry)
    const record = {
      id: entry.sessionId,
      role,
      taskId: entry.taskId ?? '',
      attemptId: entry.attemptId ?? '',
      state: 'running',
      startedAt: Date.now(),
      deadlineAt: 0,
      cause: '',
    }
    run.sessions.push(record)
    entry.record = record
    return entry
  }

  /**
   * Prompt one ordinary session with a bounded brief.
   *
   * `sessionId` re-uses a session the caller already knows instead of creating
   * another one: the reported failure mode was a parent that spawned a fresh
   * session for every follow-up until several of them edited one file at once.
   * A session fan-out already tracks is refused — prompting it would double-book
   * one worker between two tasks.
   */
  async spawnSession({ run, role, meta = {}, brief, deadlineAt, sessionTag, sessionId: reuseId }) {
    const controller = this.controller()
    const adopted = typeof reuseId === 'string' ? reuseId.trim() : ''
    if (adopted.length > 0 && this.tracked.has(adopted)) {
      throw new Error(`session ${adopted} is already busy with a fan-out task; adopt an idle session instead`)
    }
    const sessionId = adopted.length > 0 ? adopted : (await controller.create({ cwd: run.cwd })).sessionId
    // A session this plugin creates starts on the run model; an adopted session
    // keeps the model the user already chose for it.
    if (adopted.length === 0) await this.adoptModel(sessionId)
    const entry = this.trackSession(run, role, { sessionId, ...meta, adopted: adopted.length > 0 })
    entry.deadlineAt = deadlineAt ?? 0
    entry.record.deadlineAt = entry.deadlineAt
    let releasePrompt
    entry.promptDone = new Promise((resolve) => {
      releasePrompt = resolve
    })
    const abort = new AbortController()
    try {
      await controller.prompt(
        {
          requestId: `${sessionTag}-${randomUUID()}`,
          sessionId,
          mode: 'queue',
          content: [{ type: 'text', text: brief }],
          clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        },
        abort.signal,
      )
      entry.running = true
      entry.started = true
    } catch (error) {
      entry.promptError = String(error?.message ?? error)
      entry.settled = true
      entry.cause = 'prompt-failed'
      entry.record.state = 'settled'
      entry.record.cause = 'prompt-failed'
      throw error
    } finally {
      releasePrompt()
    }
    return entry
  }

  observeStatus(sessionId, running) {
    const entry = this.tracked.get(sessionId)
    if (entry === undefined || entry.settled) return
    if (running) {
      entry.running = true
      entry.started = true
      return
    }
    if (entry.started) this.settle(entry, 'idle')
  }

  observeSessionEvent(session, event) {
    const sessionId = session?.id
    if (typeof sessionId !== 'string') return
    const entry = this.tracked.get(sessionId)
    if (entry === undefined || entry.settled) return
    if (event?.type === 'turn/start') {
      entry.started = true
      entry.running = true
      return
    }
    if (event?.type === 'turn/end') {
      entry.lastReason = event.data?.reason
      if (entry.started) this.settle(entry, 'turn-end')
    }
  }

  settle(entry, cause) {
    if (entry.settled) return
    entry.settled = true
    entry.settledAt = Date.now()
    entry.cause = cause
    entry.running = false
    entry.record.state = 'settled'
    entry.record.cause = cause
    if (typeof entry.waiter === 'function') entry.waiter()
    const run = this.runs.get(entry.runId)
    if (run === undefined) return
    void this.enqueue(async () => {
      try {
        await this.handleSettled(run, entry)
      } catch (error) {
        this.log(`settle handling failed for ${entry.sessionId}: ${String(error)}`)
      }
    })
  }

  // ---------------------------------------------------------------------
  // Start / approval
  // ---------------------------------------------------------------------

  /**
   * A run with the same objective in the same workspace is already active.
   * Four duplicate wait-runs for one objective was the observed failure mode:
   * every duplicate pays for its own reviewer and integrator sessions.
   */
  // ---------------------------------------------------------------------
  // Composer arming
  // ---------------------------------------------------------------------

  /**
   * Record the composer checkbox for one session.
   *
   * The parent session is the only session that reads this: it is consumed when
   * that session starts a run, so a checked box never leaks into the next turn
   * or into a worker session.
   *
   * @param {{ sessionId?: string, armed?: boolean,
   *           mode?: 'auto'|'manual', workers?: number, expansion?: number }} request
   */
  arm(request = {}) {
    const sessionId = typeof request.sessionId === 'string' ? request.sessionId.trim() : ''
    if (sessionId.length === 0) return { ok: false, error: 'session_id is required' }
    if (request.armed !== true) {
      this.armed.delete(sessionId)
      return { ok: true, session_id: sessionId, armed: false }
    }
    const mode = request.mode === 'manual' ? 'manual' : 'auto'
    const entry = {
      armed: true,
      mode,
      workers: Number.isFinite(Number(request.workers)) ? Math.floor(Number(request.workers)) : undefined,
      expansion: Number.isFinite(Number(request.expansion)) ? Math.floor(Number(request.expansion)) : undefined,
      at: Date.now(),
    }
    this.armed.set(sessionId, entry)
    // The armed chat itself runs on the fan-out model: the session that decides
    // the graph should not be the cheapest one in the run. Best effort only.
    void this.adoptModel(sessionId).catch(() => {})
    return {
      ok: true,
      session_id: sessionId,
      armed: true,
      mode: entry.mode,
      workers: entry.workers,
      expansion: entry.expansion,
      model_label: this.modelLabel ?? '',
    }
  }

  /**
   * The armed entry that belongs to the agent that called a tool, if any.
   *
   * Returns `{ sessionId, entry }` so the caller can disarm exactly the session
   * it read, and `undefined` when the call did not come from a composer toggle.
   */
  armedOf(caller) {
    const sessionId = typeof caller?.id === 'string' ? caller.id : ''
    if (sessionId.length === 0) return undefined
    const entry = this.armed.get(sessionId)
    if (entry === undefined || entry.armed !== true) return undefined
    // The flag is one-shot: an hour-old arming is a stale draft, not an intent.
    if (Date.now() - entry.at > 60 * 60 * 1000) {
      this.armed.delete(sessionId)
      return undefined
    }
    return { sessionId, entry }
  }

  armedState(sessionId) {
    const id = typeof sessionId === 'string' ? sessionId.trim() : ''
    const entry = id.length > 0 ? this.armed.get(id) : undefined
    if (entry === undefined) return { armed: false, mode: 'auto' }
    return { armed: true, mode: entry.mode, workers: entry.workers, expansion: entry.expansion, at: entry.at }
  }

  findDuplicateRun(cwd, objective) {
    const normalize = (value) => String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
    const wanted = normalize(objective)
    const target = path.resolve(cwd)
    for (const run of this.runs.values()) {
      if (!ACTIVE.has(run.status)) continue
      if (path.resolve(String(run.cwd ?? '')) !== target) continue
      if (normalize(run.objective) !== wanted) continue
      return run
    }
    return undefined
  }

  async start(request, caller) {
    this.controller()
    // Nesting is a lineage, not a mood: a run started by a session that some
    // other run created is that run's child. Three levels are allowed (root →
    // child → grandchild); a fourth is refused so cost cannot grow silently.
    const callerId = typeof caller?.id === 'string' ? caller.id : String(request?.callerSessionId ?? '')
    const parentRun = this.lineageOf(callerId)
    const depth = parentRun === undefined ? 0 : Math.floor(Number(parentRun.depth ?? 0)) + 1
    const maxDepth = this.maxDepth()
    if (depth >= maxDepth) {
      return {
        ok: false,
        depth_refused: true,
        depth,
        max_depth: maxDepth,
        parent_run_id: parentRun?.id ?? '',
        message:
          `fanout_start refused: this session is already level ${depth} of a fan-out lineage (limit ${maxDepth}). ` +
          'Finish the work here, or extend the parent run with fanout_enqueue / fanout_control steer instead of nesting deeper.',
      }
    }
    const objective = String(request?.objective ?? '').trim()
    if (objective.length === 0) throw new Error('fanout_start requires a non-empty objective')

    const verify = Array.isArray(request?.verify)
      ? request.verify.filter((item) => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim()).slice(0, 12)
      : []
    const rawTasks = Array.isArray(request?.tasks) ? request.tasks : []
    const requireTasks = request?.requireTasks === true
    if (rawTasks.length === 0 && requireTasks) {
      throw new Error(
        'fanout_start requires a non-empty tasks array: list the asymmetric jobs (title/brief, optional dependsOn/kind/acceptance/verify) so the graph can be scheduled.',
      )
    }
    const fallbackTasks = rawTasks.length > 0
      ? rawTasks
      : [{ title: objective.slice(0, 120), brief: objective, weight: 1 }]

    const graph = normalizeGraph(fallbackTasks, { verifyDefault: verify })
    if (graph.problems.length > 0) {
      throw new Error(`fanout_start rejected: ${graph.problems.join('; ')}`)
    }

    // A run started from a composer-armed session is held to the fit rule: the
    // conditions where fan-out measurably loses send the work back to a single
    // session instead of paying for sessions that cannot run in parallel.
    const armed = this.armedOf(caller)
    const fit = graphFit(graph.tasks)
    if (armed !== undefined && request?.force !== true && fit.verdict === 'single') {
      this.armed.delete(armed.sessionId)
      this.log(`refused fan-out for ${armed.sessionId}: ${fit.reasons.join(' | ')}`)
      return {
        ok: false,
        single_session: true,
        downgraded: true,
        reasons: fit.reasons,
        metrics: fit.metrics,
        tasks: graphSummary(graph.tasks),
        guidance:
          'Do not fan out. This request is not wide or deep enough to pay for fan-out: run it in this session yourself, ' +
          'do the work, and report the result normally. Fan-out would add one fixed per-session cost per job plus a ' +
          'reviewer round, for work one context already holds. Pass force:true only if the user explicitly asks for ' +
          'the orchestration anyway.',
      }
    }

    const maxWorkers = Math.min(this.config.maxWorkers ?? 8, 16)
    const maxExpansion = this.config.maxExpansion ?? 100
    let maxConcurrent
    let expansion
    let budget
    if (armed !== undefined) {
      // The parent session decided how wide and how deep this job is; the floor
      // is generous on purpose (widest layer + spare slot, depth-scaled
      // expansion + headroom) so the dials are never silently skipped.
      budget = decideBudget({
        tasks: graph.tasks,
        mode: armed.entry.mode,
        workers: armed.entry.workers,
        expansion: armed.entry.expansion,
        maxWorkers,
        maxExpansion,
      })
      maxConcurrent = Math.min(maxWorkers, Math.max(1, budget.workers))
      expansion = Math.max(0, Math.min(maxExpansion, Math.floor(budget.expansion)))
      this.armed.delete(armed.sessionId)
      this.log(`armed run: workers=${maxConcurrent} expansion=${expansion} (${budget.note})`)
    } else {
      maxConcurrent = Math.min(
        maxWorkers,
        Math.max(1, Math.floor(Number(request?.workers) > 0 ? Number(request.workers) : this.config.defaultWorkers)),
      )
      expansion = Math.max(0, Math.min(maxExpansion, Math.floor(Number(request?.expansion ?? this.config.defaultExpansion))))
      budget = { workers: maxConcurrent, expansion, source: 'caller', note: 'workers/expansion supplied by the caller or config' }
    }
    const cwd = typeof request?.cwd === 'string' && request.cwd.trim().length > 0
      ? path.resolve(request.cwd.trim())
      : this.callerCwd(caller)
    if (request?.allowDuplicate !== true) {
      const duplicate = this.findDuplicateRun(cwd, objective)
      if (duplicate !== undefined) {
        return {
          ok: false,
          duplicate: true,
          duplicate_of: duplicate.id,
          run_id: duplicate.id,
          status: duplicate.status,
          manifest: duplicate.manifestPath || manifestRelative(duplicate),
          message: `An active run already has this objective in ${cwd}: ${duplicate.id} (${duplicate.status}). Resume or retry that run with fanout_control, or pass allowDuplicate:true to add a redundant second run (each run pays for its own review and integration sessions).`,
          tasks: graphSummary(duplicate.tasks),
        }
      }
    }
    const approvalRaw = request?.approval
    const approval = approvalRaw === 'required'
      ? 'required'
      : approvalRaw === 'automatic'
        ? 'automatic'
        : caller !== undefined && this.config.approvalDefault === 'required'
          ? 'required'
          : 'automatic'
    const runId = makeRunId('run')
    const run = {
      v: 2,
      id: runId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: approval === 'required' ? 'staged' : 'running',
      phase: approval === 'required' ? 'staged' : 'workers',
      objective,
      cwd,
      callerSessionId: typeof caller?.id === 'string' ? caller.id : String(request?.callerSessionId ?? ''),
      depth,
      parentRunId: parentRun?.id ?? '',
      modelLabel: this.modelLabel ?? '',
      expansion,
      verify,
      integrateRequested: request?.integrate !== false && this.config.integrate !== false,
      reviewEnabled: request?.review !== false && this.config.review !== false,
      maxConcurrent,
      maxReviewRounds: Math.max(1, Math.min(5, Math.floor(Number(request?.maxReviewRounds ?? this.config.maxReviewRounds ?? 3)))),
      maxAttempts: Math.max(1, Math.min(4, Math.floor(Number(this.config.maxAttempts ?? 2)))),
      approval,
      approvedAt: approval === 'automatic' ? Date.now() : 0,
      tasks: graph.tasks,
      sessions: [],
      warnings: graph.warnings,
      gates: { staged: approval === 'required', paused: false, escalated: false, reason: '' },
      integrator: undefined,
      estimate: estimateBudget({ tasks: graph.tasks, workers: maxConcurrent, expansion }),
      budget,
      deadlineAt: Date.now() + Math.max(5, Math.min(720, Number(this.config.runTimeoutMinutes ?? 120))) * 60000,
      workerTimeoutMs: Math.max(2, Math.min(240, Number(request?.timeoutMinutes ?? this.config.workerTimeoutMinutes ?? 25))) * 60000,
      resultDigestChars: Math.max(200, Math.min(6000, Number(this.config.resultDigestChars ?? 1200))),
      objectiveHeadChars: Math.max(120, Math.min(2000, Number(this.config.objectiveHeadChars ?? DEFAULT_OBJECTIVE_HEAD_CHARS))),
      taskBriefChars: Math.max(400, Math.min(4000, Number(request?.taskBriefChars ?? this.config.taskBriefChars ?? 2000))),
      manifestPath: '',
      objectivePath: '',
      context: undefined,
      runDir: this.store.runDir(runId),
      finalPath: '',
      error: '',
    }
    run.totals = stateSummary(run.tasks)
    await this.store.createRun(run)
    this.runs.set(runId, run)
    // File the objective and the first manifest before anything is spawned:
    // every later stage reads these files instead of receiving them inline.
    await this.ensureRunFiles(run)

    if (approval === 'required') {
      this.log(`run ${runId} staged for approval (${run.tasks.length} tasks)`)
      return {
        run_id: runId,
        status: run.status,
        staged: true,
        plan: renderStagedPlan(run),
        tasks: graphSummary(run.tasks),
        estimate: run.estimate,
        store_dir: run.runDir,
        started_at: nowIso(),
      }
    }
    await this.launch(run)
    return this.startResult(run)
  }

  async approve(runId) {
    const run = await this.requireRun(runId)
    if (run.status !== 'staged') {
      return { run_id: run.id, status: run.status, approved: false, message: `run is ${run.status}, nothing to approve` }
    }
    run.approval = 'automatic'
    run.approvedAt = Date.now()
    run.gates.staged = false
    await this.launch(run)
    return { ...this.startResult(run), approved: true }
  }

  /**
   * Append tasks to an existing queue — the parent's "keep adding to the list".
   *
   * `fanout_start` is one batch. This is the append path that lets a single
   * orchestrating session grow *one* run instead of starting a second one: two
   * runs in one workspace schedule independently and then collide on files.
   * Appended tasks may depend on tasks already in the queue, and they are
   * scheduled immediately when the run is live.
   */
  async appendTasks(runId, request = {}) {
    const run = await this.requireRun(typeof runId === 'string' && runId.length > 0 ? runId : undefined)
    if (TERMINAL.has(run.status)) {
      return {
        ok: false,
        run_id: run.id,
        status: run.status,
        message: `run ${run.id} is ${run.status}; a finished queue cannot take more work — start a new one with fanout_enqueue (no run_id).`,
      }
    }
    const incoming = Array.isArray(request.tasks) ? request.tasks : []
    if (incoming.length === 0) throw new Error('fanout_enqueue requires a non-empty tasks array')
    const result = appendQueueTasks(run.tasks, incoming, { verifyDefault: run.verify })
    if (result.problems.length > 0) throw new Error(`append rejected: ${result.problems.join('; ')}`)
    if (result.added.length === 0) return { ok: false, run_id: run.id, status: run.status, message: 'nothing to append' }
    run.tasks = result.tasks
    run.warnings = [...(run.warnings ?? []), ...result.warnings]
    if (Number.isFinite(Number(request.workers)) && Number(request.workers) > 0) {
      run.maxConcurrent = Math.min(this.config.maxWorkers ?? 8, Math.max(1, Math.floor(Number(request.workers))))
    }
    run.estimate = estimateBudget({ tasks: run.tasks, workers: run.maxConcurrent, expansion: run.expansion })
    await this.save(run)
    await this.refreshManifest(run).catch((error) => this.log(`manifest refresh failed: ${String(error)}`))
    if (run.status === 'running') await this.schedule(run)
    return {
      ok: true,
      run_id: run.id,
      status: run.status,
      appended: result.added.map((task) => task.id),
      totals: run.totals,
      queue: queueView(run.tasks),
      tasks: graphSummary(run.tasks),
    }
  }

  startResult(run) {
    return {
      run_id: run.id,
      status: run.status,
      staged: false,
      workers: graphSummary(run.tasks).map((task, index) => ({
        index,
        task_ids: [task.id],
        weight: 1,
        state: task.state,
        session_id: '',
      })),
      tasks: graphSummary(run.tasks),
      integrator_session_id: run.integrator?.sessionId ?? '',
      estimate: run.estimate,
      budget: run.budget,
      workers_concurrency: run.maxConcurrent,
      expansion: run.expansion,
      store_dir: run.runDir,
      warnings: run.warnings,
      started_at: nowIso(),
    }
  }

  async launch(run) {
    run.status = 'running'
    run.phase = 'workers'
    await this.save(run)
    await this.schedule(run)
  }

  async save(run) {
    run.updatedAt = Date.now()
    run.totals = stateSummary(run.tasks)
    run.estimate = run.estimate ?? estimateBudget({ tasks: run.tasks, workers: run.maxConcurrent, expansion: run.expansion })
    await this.store.saveRun(run).catch((error) => this.log(`save run ${run.id} failed: ${String(error)}`))
  }

  // ---------------------------------------------------------------------
  // Filing — bounded context lives on disk, not in every prompt
  // ---------------------------------------------------------------------

  workspaceRunDir(run) {
    return path.resolve(run.cwd, runDirRelative(run))
  }

  /** Write one workspace-relative text file; returns its manifest entry. */
  async fileText(run, relative, text) {
    try {
      const absolute = path.resolve(run.cwd, relative)
      await fsp.mkdir(path.dirname(absolute), { recursive: true })
      await fsp.writeFile(absolute, text, 'utf8')
      return { path: relative, bytes: Buffer.byteLength(text, 'utf8'), sha256: sha256(text) }
    } catch (error) {
      this.log(`could not file ${relative} for ${run.id}: ${String(error)}`)
      return undefined
    }
  }

  /** File the full objective and record the shared-prefix hash the run uses. */
  async ensureRunFiles(run) {
    const filed = await this.fileText(run, objectiveRelative(run), `${String(run.objective ?? '').trim()}\n`)
    if (filed !== undefined) run.objectivePath = filed.path
    let prefixSha256 = ''
    try {
      prefixSha256 = cachePrefixHash(run)
    } catch (error) {
      this.log(`could not hash the prefix for ${run.id}: ${String(error)}`)
    }
    run.context = {
      contract: CONTRACT_VERSION,
      prefixSha256,
      objectiveHeadChars: run.objectiveHeadChars,
      taskBriefChars: run.taskBriefChars,
    }
    await this.refreshManifest(run)
  }

  /** Everything filed for this run, with size + content hash. */
  async collectArtifacts(run) {
    const artifacts = []
    const add = async (role, relative, extra = {}) => {
      try {
        const absolute = path.resolve(run.cwd, relative)
        const [stat, text] = await Promise.all([fsp.stat(absolute), fsp.readFile(absolute, 'utf8')])
        if (!stat.isFile()) return
        artifacts.push({ role, path: relative, bytes: stat.size, sha256: sha256(text), ...extra })
      } catch {
        // Not filed (yet); the manifest only lists what exists.
      }
    }
    await add('objective', objectiveRelative(run))
    for (const task of run.tasks) {
      if (typeof task.attemptId !== 'string' || task.attemptId.length === 0) continue
      await add('prompt', promptRelative(run, task, task.attemptId), { task: task.id, attempt: task.attemptId })
      const terminal = task.state === 'completed' || task.state === 'failed'
      if (!terminal) continue
      await add('result', resultRelative(run, task, task.attemptId), { task: task.id, attempt: task.attemptId })
    }
    await add('final', finalRelative(run))
    return artifacts
  }

  /** Rebuild manifest.json/manifest.md: the index every later stage reads. */
  async refreshManifest(run) {
    try {
      const artifacts = await this.collectArtifacts(run)
      const manifest = buildManifest(run, artifacts, { objectiveChars: run.objectiveHeadChars })
      await this.fileText(run, manifestJsonRelative(run), `${JSON.stringify(manifest, null, 2)}\n`)
      const markdown = await this.fileText(run, manifestRelative(run), renderManifestMarkdown(manifest))
      if (markdown !== undefined) run.manifestPath = markdown.path
      return manifest
    } catch (error) {
      this.log(`could not refresh the manifest for ${run.id}: ${String(error)}`)
      return undefined
    }
  }

  // ---------------------------------------------------------------------
  // Scheduling
  // ---------------------------------------------------------------------

  runningTasks(run) {
    return run.tasks.filter((task) => task.state === 'running')
  }

  /**
   * Start the ready tasks that may run *together*.
   *
   * Admission is the collision fix, not a nicety: a ready task starts only when
   * no running task already holds a path it writes (`scope` / `contract.inScope`).
   * Before this, two sessions of the same run were regularly told to edit one
   * file; they then invalidated each other's file version and the losing turn
   * was cancelled (`FS_STALE_VERSION`), which is exactly the reported stall.
   * The wait is reported in `run.scopeWaits`, so the parent can see who holds
   * what instead of guessing why nothing starts.
   */
  async schedule(run) {
    if (run.status !== 'running') return
    if (run.gates.paused) return
    const active = this.runningTasks(run).length
    const limit = Math.max(1, run.maxConcurrent ?? 1)
    const plan = admit(readyTasks(run.tasks), {
      running: this.runningTasks(run),
      limit: Math.max(0, limit - active),
      serializeUnclaimed: run.scopeSerialization === true,
    })
    for (const task of plan.admitted) {
      const spawned = await this.spawnTask(run, task)
      if (!spawned) break
    }
    run.scopeWaits = plan.deferred
      .filter((entry) => entry.reason === DEFER_REASONS.SCOPE)
      .map((entry) => ({ id: entry.id, blockedBy: [...entry.blockedBy], path: entry.path }))
    await this.save(run)
    if (this.runningTasks(run).length === 0) await this.maybeIntegrate(run)
  }

  async spawnTask(run, task) {
    task.attempt = nextAttempt(task)
    task.attemptId = `${attemptToken(task.id, task.attempt)}-${randomUUID().slice(0, 4)}`
    task.state = 'running'
    task.startedAt = Date.now()
    task.endedAt = 0
    task.error = ''
    task.sessionId = ''
    const brief = task.kind === 'review'
      ? await this.reviewBrief(run, task)
      : renderTaskBrief(run, task, task.attemptId)
    if (brief === undefined) {
      task.state = 'failed'
      task.error = 'could not build a brief (source task missing)'
      return false
    }
    // File the exact brief this attempt received: the prompt is small, the file
    // makes it auditable and lets a later stage see what the session was told.
    await this.fileText(run, promptRelative(run, task, task.attemptId), brief)
    try {
      const entry = await this.spawnSession({
        run,
        role: task.kind === 'review' ? 'review' : 'task',
        meta: { taskId: task.id, attemptId: task.attemptId },
        brief,
        deadlineAt: Date.now() + run.workerTimeoutMs,
        sessionTag: 'fanout-task',
        sessionId: task.adoptSessionId ?? '',
      })
      task.sessionId = entry.sessionId
      // Adoption is for this attempt only: a retry must not reuse a session that
      // has already moved on to something else.
      task.adoptSessionId = ''
      await this.refreshManifest(run)
      await this.save(run)
      this.log(`spawned ${task.id} attempt ${task.attemptId} (${entry.sessionId})`)
      return true
    } catch (error) {
      task.state = 'failed'
      task.error = `session could not start: ${String(error?.message ?? error)}`
      task.endedAt = Date.now()
      this.log(`task ${task.id} failed to spawn: ${String(error)}`)
      await this.save(run)
      return false
    }
  }

  async reviewBrief(run, reviewTask) {
    const source = taskById(run.tasks, reviewTask.sourceTaskId)
    if (source === undefined) return undefined
    reviewTask.contract = {
      objective: source.contract?.objective ?? source.title,
      acceptance: [...(source.contract?.acceptance ?? [])],
      verify: [...(source.contract?.verify ?? [])],
      inScope: [],
      outOfScope: [],
    }
    const digest = source.digest || source.summary || ''
    return renderReviewBrief(run, source, reviewTask, digest)
  }

  // ---------------------------------------------------------------------
  // Settle handling
  // ---------------------------------------------------------------------

  async handleSettled(run, entry) {
    await entry.promptDone.catch(() => {})
    if (entry.promptError.length > 0) {
      this.log(`prompt failed for ${entry.sessionId}: ${entry.promptError}`)
    }
    if (entry.role === 'integrator') await this.finishIntegrator(run, entry)
    else await this.finishTask(run, entry)
    await this.refreshManifest(run)
    await this.save(run)
    if (run.status === 'running') {
      await this.schedule(run)
    }
    await this.maybeIntegrate(run)
  }

  async readTaskText(run, taskId, attemptId, entry) {
    const relative = `.dsh-fanout/runs/${run.id}/results/${attemptId}.md`
    try {
      const text = await fsp.readFile(path.resolve(run.cwd, relative), 'utf8')
      if (text.trim().length > 0) return { text, source: 'workspace' }
    } catch {
      // fall through
    }
    const stored = await this.store.readResult(run.id, `${attemptId}.md`).catch(() => undefined)
    if (stored !== undefined && stored.trim().length > 0) return { text: stored, source: 'store' }
    try {
      const inspection = await this.controller().inspect(entry.sessionId)
      const text = lastAssistantText(inspection?.events ?? [])
      if (text.trim().length > 0) return { text, source: 'session' }
    } catch (error) {
      this.log(`inspect ${entry.sessionId} failed: ${String(error)}`)
    }
    return { text: '', source: 'none' }
  }

  async finishTask(run, entry) {
    const task = taskById(run.tasks, entry.taskId)
    if (task === undefined || task.state !== 'running') return
    const { text } = await this.readTaskText(run, task.id, task.attemptId, entry)
    task.endedAt = Date.now()
    if (task.kind === 'review') {
      await this.finishReview(run, task, text, entry)
      return
    }
    const parsed = parseResult(text)
    const check = validateResult(parsed, {
      taskId: task.id,
      attemptId: task.attemptId,
      acceptance: task.contract?.acceptance ?? [],
      kind: task.kind,
      sourceFindingIds: task.sourceFindingIds ?? [],
    })
    task.digest = text.slice(0, run.resultDigestChars)
    if (!check.ok) {
      const retryable = task.attempt < (run.maxAttempts ?? 2)
      if (retryable) {
        task.state = 'pending'
        task.error = `attempt ${task.attempt} rejected: ${check.problems.join('; ')}`
        this.log(`task ${task.id} retry after contract violation: ${check.problems.join('; ')}`)
        return
      }
      task.state = 'failed'
      task.error = check.problems.join('; ') || 'result did not satisfy the contract'
      this.log(`task ${task.id} failed: ${task.error}`)
      return
    }
    task.state = 'completed'
    task.summary = parsed.summary.slice(0, 240)
    task.acceptanceResults = parsed.acceptance
    task.closed = parsed.closed
    // Keep the parsed evidence, not the raw answer: later stages receive the
    // compact fields and read the filed result only when they need detail.
    task.changedPaths = parsed.changedPaths
    task.verification = parsed.verification
    task.openIssues = parsed.openIssues
    task.resultPath = path.resolve(run.cwd, resultRelative(run, task, task.attemptId))
    if (task.kind === 'repair') {
      this.resolveFindings(run, task)
      const source = taskById(run.tasks, task.sourceTaskId)
      if (source !== undefined) {
        const round = Math.max(1, task.round + 1)
        insertReview(run.tasks, source.id, round, task.id)
        this.log(`repair ${task.id} completed → review round ${round} for ${source.id}`)
      }
      return
    }
    if (isReviewedKind(task.kind) && run.reviewEnabled && task.review !== false) {
      insertReview(run.tasks, task.id, 1)
      this.log(`task ${task.id} completed → review round 1 queued`)
    }
  }

  resolveFindings(run, repairTask) {
    const source = taskById(run.tasks, repairTask.sourceTaskId)
    if (source === undefined) return
    const closed = new Set(repairTask.closed ?? [])
    for (const finding of source.findings ?? []) {
      if (closed.has(finding.id)) finding.resolved = true
    }
  }

  async finishReview(run, reviewTask, text, entry) {
    const source = taskById(run.tasks, reviewTask.sourceTaskId)
    const parsed = parseReview(text)
    reviewTask.digest = text.slice(0, run.resultDigestChars)
    reviewTask.reviewVerdict = parsed.verdict
    reviewTask.findings = parsed.findings
    reviewTask.acceptanceResults = parsed.acceptance
    reviewTask.summary = parsed.verdict.length > 0 ? `verdict: ${parsed.verdict}` : 'no verdict'
    const check = validateReview(parsed, {
      acceptance: reviewTask.contract?.acceptance ?? [],
      strictAcceptance: this.config.strictReviewAcceptance === true,
    })
    reviewTask.warnings = check.warnings ?? []
    if (!check.ok) {
      if (reviewTask.attempt < (run.maxAttempts ?? 2)) {
        reviewTask.state = 'pending'
        reviewTask.error = `review attempt ${reviewTask.attempt} rejected: ${check.problems.join('; ')}`
        return
      }
      reviewTask.state = 'failed'
      reviewTask.error = check.problems.join('; ')
      return
    }
    reviewTask.state = 'completed'
    reviewTask.endedAt = Date.now()
    if (source === undefined) return
    source.reviewVerdict = parsed.verdict
    source.acceptanceResults = parsed.acceptance
    if (parsed.verdict === 'pass') {
      for (const finding of source.findings ?? []) {
        if (!finding.resolved) finding.resolved = true
      }
      this.log(`review ${reviewTask.id} passed ${source.id}`)
      return
    }
    source.findings = parsed.findings
    const round = Math.max(1, reviewTask.round ?? 1)
    if (round >= (run.maxReviewRounds ?? 3)) {
      await this.escalate(run, source, reviewTask)
      return
    }
    insertRepair(run.tasks, reviewTask.id, round)
    this.log(`review ${reviewTask.id} → ${parsed.verdict}; repair round ${round} queued`)
  }

  async escalate(run, source, reviewTask) {
    run.gates.escalated = true
    run.gates.reason = `review round limit (${run.maxReviewRounds}) reached on ${source?.id ?? '?'}`
    run.status = 'escalated'
    run.error = run.gates.reason
    for (const entry of this.tracked.values()) {
      if (entry.runId !== run.id || entry.settled) continue
      this.cancelSession(entry)
      entry.settled = true
      entry.record.state = 'settled'
      entry.record.cause = 'escalated'
    }
    await this.save(run)
    await this.notifyCaller(run)
    this.log(`run ${run.id} escalated: ${run.gates.reason}`)
  }

  // ---------------------------------------------------------------------
  // Integration
  // ---------------------------------------------------------------------

  async maybeIntegrate(run) {
    if (run.status !== 'running') return
    if (run.gates.paused) return
    if (run.tasks.some((task) => task.state === 'running')) return
    const pending = run.tasks.filter((task) => task.state === 'pending')
    const failed = run.tasks.filter((task) => task.state === 'failed')
    if (pending.length > 0) {
      if (failed.length > 0) {
        run.status = 'failed'
        run.error = `blocked by failed task(s): ${failed.map((task) => task.id).join(', ')}`
        await this.save(run)
        await this.notifyCaller(run)
      }
      return
    }
    if (failed.length > 0) {
      run.status = 'failed'
      run.error = failed.map((task) => `${task.id}: ${task.error}`).join(' | ')
      await this.save(run)
      await this.notifyCaller(run)
      return
    }
    if (run.integrateRequested === false) {
      run.status = 'completed'
      run.phase = 'done'
      run.integrator = { sessionId: '', state: 'settled', attempt: 0, summary: 'integration disabled' }
      await this.save(run)
      await this.notifyCaller(run)
      return
    }
    run.status = 'integrating'
    run.phase = 'integrating'
    run.integrator = { sessionId: '', state: 'running', attempt: 1, summary: '' }
    run.gates.paused = false
    // The integrator reads the manifest, so every settled result must be indexed
    // before its brief is rendered.
    await this.refreshManifest(run)
    await this.save(run)
    try {
      const entry = await this.spawnSession({
        run,
        role: 'integrator',
        meta: {},
        brief: renderIntegratorBrief(run),
        deadlineAt: Date.now() + run.workerTimeoutMs,
        sessionTag: 'fanout-integrator',
      })
      run.integrator.sessionId = entry.sessionId
      await this.save(run)
      this.log(`integrator started for ${run.id} (${entry.sessionId})`)
    } catch (error) {
      run.status = 'failed'
      run.error = `integrator could not start: ${String(error?.message ?? error)}`
      await this.save(run)
      await this.notifyCaller(run)
    }
  }

  async finishIntegrator(run, entry) {
    const attempt = run.integrator?.attempt ?? 1
    const { text } = await this.readFinal(run, entry)
    const check = validateFinal(text)
    if (!check.ok && attempt < 2) {
      this.log(`integrator report rejected (attempt ${attempt}): ${check.problems.join('; ')}`)
      run.integrator = { ...(run.integrator ?? {}), state: 'running', attempt: attempt + 1, problems: check.problems }
      await this.save(run)
      try {
        const retry = await this.spawnSession({
          run,
          role: 'integrator',
          meta: {},
          brief: renderIntegratorRepair(run, check.problems),
          deadlineAt: Date.now() + run.workerTimeoutMs,
          sessionTag: 'fanout-integrator-fix',
        })
        run.integrator.sessionId = retry.sessionId
        await this.save(run)
        return
      } catch (error) {
        this.log(`integrator retry failed to start: ${String(error)}`)
      }
    }
    const ok = check.ok
    run.integrator = {
      ...(run.integrator ?? {}),
      sessionId: entry.sessionId,
      state: ok ? 'settled' : 'failed',
      attempt,
      digest: text.slice(0, 1600),
      summary: text.replace(/\s+/g, ' ').slice(0, 400),
      ...(ok ? {} : { problems: check.problems }),
    }
    run.status = ok ? 'completed' : 'failed'
    run.phase = 'done'
    if (!ok) {
      run.error = `final report failed the contract: ${check.problems.join('; ')}`
    } else {
      const workspaceFinal = path.resolve(run.cwd, finalRelative(run))
      const exists = await fsp.stat(workspaceFinal).then(() => true, () => false)
      if (exists) {
        run.finalPath = workspaceFinal
      } else {
        const storedFinal = this.resolveStoreFinal(run)
        if (text.trim().length > 0) {
          await fsp.mkdir(run.runDir, { recursive: true })
          await fsp.writeFile(storedFinal, `${text}\n`, 'utf8').catch((error) => this.log(`could not persist final report: ${String(error)}`))
        }
        run.finalPath = storedFinal
      }
    }
    await this.refreshManifest(run)
    await this.save(run)
    await this.notifyCaller(run)
    this.releaseRun(run.id)
  }

  resolveStoreFinal(run) {
    return path.join(run.runDir, 'final.md')
  }

  async readFinal(run, entry) {
    try {
      const text = await fsp.readFile(path.resolve(run.cwd, finalRelative(run)), 'utf8')
      if (text.trim().length > 0) return { text, source: 'workspace' }
    } catch {
      // fall through
    }
    const stored = await this.store.readFinal(run.id).catch(() => undefined)
    if (stored !== undefined && stored.trim().length > 0) return { text: stored, source: 'store' }
    try {
      const inspection = await this.controller().inspect(entry.sessionId)
      return { text: lastAssistantText(inspection?.events ?? []), source: 'session' }
    } catch (error) {
      this.log(`inspect integrator ${entry.sessionId} failed: ${String(error)}`)
      return { text: '', source: 'none' }
    }
  }

  // ---------------------------------------------------------------------
  // Notification
  // ---------------------------------------------------------------------

  async notifyCaller(run) {
    if (this.config.notifyCaller === false) return
    if (run.callerSessionId.length === 0) return
    const agents = this.agentsService()
    if (agents === undefined || typeof agents.get !== 'function') return
    const agent = agents.get(run.callerSessionId)
    if (agent === undefined || typeof agent.followup !== 'function') return
    try {
      agent.followup(
        this.createUserMessage({
          content: [{ type: 'text', text: renderCallerDigest(run) }],
          source: { kind: 'fanout', form: 'result', runId: run.id },
        }),
      )
    } catch (error) {
      this.log(`caller follow-up failed: ${String(error)}`)
    }
  }

  releaseRun(runId) {
    for (const [sessionId, entry] of this.tracked) {
      if (entry.runId === runId) this.tracked.delete(sessionId)
    }
  }

  // ---------------------------------------------------------------------
  // Control surface
  // ---------------------------------------------------------------------

  async requireRun(runId) {
    if (typeof runId === 'string' && runId.length > 0) {
      const live = this.runs.get(runId)
      if (live !== undefined) return live
      const stored = await this.store.loadRun(runId).catch(() => undefined)
      if (stored === undefined) throw new Error(`run ${runId} not found`)
      const hydrated = this.hydrate(stored)
      this.runs.set(hydrated.id, hydrated)
      return hydrated
    }
    const newest = [...this.runs.values()].sort((a, b) => b.createdAt - a.createdAt)
    if (newest.length === 0) throw new Error('no fan-out runs are known in this process')
    return newest[0]
  }

  async control(action, request = {}) {
    const run = await this.requireRun(typeof request.run_id === 'string' ? request.run_id : undefined)
    const taskId = typeof request.task_id === 'string' ? request.task_id : ''
    if (action === 'pause') {
      if (run.status !== 'running') return { ok: false, run_id: run.id, status: run.status, message: `cannot pause a ${run.status} run` }
      run.status = 'paused'
      run.gates.paused = true
      await this.save(run)
      return { ok: true, run_id: run.id, status: run.status, paused: true }
    }
    if (action === 'resume') {
      if (run.status !== 'paused' && run.status !== 'escalated' && run.status !== 'stopped') {
        return { ok: false, run_id: run.id, status: run.status, message: `cannot resume a ${run.status} run` }
      }
      run.status = 'running'
      run.phase = 'workers'
      run.gates.paused = false
      run.gates.escalated = false
      run.gates.reason = ''
      run.error = ''
      await this.save(run)
      await this.schedule(run)
      return { ok: true, run_id: run.id, status: run.status, resumed: true }
    }
    if (action === 'retry') {
      const task = taskById(run.tasks, taskId)
      if (task === undefined) throw new Error(`task ${taskId || '(missing)'} not found`)
      if (task.state !== 'failed') return { ok: false, run_id: run.id, task_id: task.id, message: `task is ${task.state}, not failed` }
      task.state = 'pending'
      task.error = ''
      task.endedAt = 0
      if (run.status === 'failed' || run.status === 'stopped' || run.status === 'escalated') {
        run.status = 'running'
        run.phase = 'workers'
        run.error = ''
        run.gates.escalated = false
      }
      await this.save(run)
      await this.schedule(run)
      return { ok: true, run_id: run.id, task_id: task.id, status: run.status, retried: true }
    }
    if (action === 'steer') {
      const message = String(request.message ?? '').trim()
      if (message.length === 0) throw new Error('steer requires a non-empty message')
      const task = taskId.length > 0 ? run.tasks.find((item) => item.id === taskId) : undefined
      // The parent may address any session it already knows (a worker, the
      // integrator, or one adopted from an earlier run), not only a task of
      // this run: "tell the session that is already on it" is the normal
      // orchestrator move when more work appears.
      const explicit = typeof request.session_id === 'string' ? request.session_id.trim() : ''
      const fallbackTask = taskId.length === 0 ? run.tasks.find((item) => item.state === 'running') : undefined
      const sessionId = explicit.length > 0
        ? explicit
        : task?.sessionId || fallbackTask?.sessionId || (taskId.length === 0 ? run.integrator?.sessionId : '') || ''
      if (!sessionId) throw new Error('no running session to steer')
      const controller = this.controller()
      await controller.prompt(
        {
          requestId: `fanout-steer-${randomUUID()}`,
          sessionId,
          mode: 'steer',
          content: [{ type: 'text', text: message }],
          clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        },
        new AbortController().signal,
      )
      run.steers = [...(run.steers ?? []), { at: Date.now(), sessionId, taskId: task?.id ?? '', message: message.slice(0, 500) }]
      await this.save(run)
      return { ok: true, run_id: run.id, session_id: sessionId, steered: true }
    }
    if (action === 'edit') {
      const task = taskById(run.tasks, taskId)
      if (task === undefined) throw new Error(`task ${taskId || '(missing)'} not found`)
      if (task.state !== 'pending' || task.attempt > 0) {
        return { ok: false, run_id: run.id, task_id: task.id, message: 'only a never-started pending task can be edited' }
      }
      const patch = request.patch !== null && typeof request.patch === 'object' ? request.patch : {}
      if (typeof patch.title === 'string' && patch.title.trim().length > 0) task.title = patch.title.trim().slice(0, 160)
      if (typeof patch.brief === 'string') task.brief = patch.brief.slice(0, 4000)
      if (Number.isFinite(Number(patch.weight))) task.weight = Math.min(8, Math.max(0.25, Number(patch.weight)))
      if (Array.isArray(patch.dependsOn)) {
        const next = [...new Set(patch.dependsOn.map((dep) => (typeof dep === 'number' ? `t${dep}` : String(dep))))]
        const candidate = run.tasks.map((item) => (item.id === task.id ? { ...item, deps: next } : item))
        const check = validateGraph(candidate)
        if (check.problems.length > 0) throw new Error(`edit rejected: ${check.problems.join('; ')}`)
        task.deps = next
      }
      if (Array.isArray(patch.acceptance)) task.contract.acceptance = patch.acceptance.filter((item) => typeof item === 'string')
      if (Array.isArray(patch.verify)) task.contract.verify = patch.verify.filter((item) => typeof item === 'string')
      if (Array.isArray(patch.inScope)) task.contract.inScope = patch.inScope.filter((item) => typeof item === 'string')
      if (typeof patch.objective === 'string' && patch.objective.trim().length > 0) task.contract.objective = patch.objective.trim().slice(0, 1800)
      await this.save(run)
      return { ok: true, run_id: run.id, task_id: task.id, edited: true, tasks: graphSummary(run.tasks) }
    }
    if (action === 'takeover') {
      const task = taskById(run.tasks, taskId)
      if (task === undefined) throw new Error(`task ${taskId || '(missing)'} not found`)
      if (task.state !== 'running') return { ok: false, run_id: run.id, task_id: task.id, message: `task is ${task.state}, not running` }
      const entry = this.tracked.get(task.sessionId)
      if (entry !== undefined) {
        this.cancelSession(entry)
        entry.settled = true
        entry.record.state = 'settled'
        entry.record.cause = 'takeover'
      }
      task.state = 'pending'
      task.error = ''
      await this.save(run)
      if (run.status === 'running') await this.schedule(run)
      return { ok: true, run_id: run.id, task_id: task.id, takeover: true, status: run.status }
    }
    if (action === 'stop' || action === 'cancel') {
      return this.stop(run.id, typeof request.reason === 'string' ? request.reason : 'control-stop')
    }
    throw new Error(`unknown control action "${action}"`)
  }

  // ---------------------------------------------------------------------
  // Status / stop
  // ---------------------------------------------------------------------

  async status(runId) {
    // The queue view rides along with every status read: what may start, what
    // is waiting for a file another task holds, and which tasks never declared
    // a write scope. Without it the parent can only guess why nothing starts.
    // `queue` is computed live — `run.scopeWaits` in run.json is the decision
    // the last schedule() made and goes stale the moment a task settles, so it
    // is deliberately not exposed here twice.
    const summarize = (run) => ({
      ...renderStatusSummary(run),
      queue: queueView(run.tasks),
    })
    if (typeof runId === 'string' && runId.length > 0) {
      const live = this.runs.get(runId)
      if (live !== undefined) return { runs: [summarize(live)], run: summarize(live) }
      const stored = await this.store.loadRun(runId).catch(() => undefined)
      if (stored !== undefined) {
        const hydrated = this.hydrate(stored)
        return { runs: [summarize(hydrated)], run: summarize(hydrated), source: 'disk' }
      }
      return { runs: [], run: undefined, message: `run ${runId} is not active in this process` }
    }
    const live = [...this.runs.values()].sort((a, b) => b.createdAt - a.createdAt).map(summarize)
    return { runs: live, run: live[0] }
  }

  async stop(runId, reason = 'user') {
    const target = typeof runId === 'string' && runId.length > 0
      ? this.runs.get(runId)
      : [...this.runs.values()].filter((run) => ACTIVE.has(run.status)).sort((a, b) => b.createdAt - a.createdAt)[0]
    if (target === undefined) return { run_id: runId ?? '', status: 'not-found', cancelled: [] }
    const cancelled = []
    for (const [sessionId, entry] of this.tracked) {
      if (entry.runId !== target.id || entry.settled) continue
      this.cancelSession(entry)
      entry.settled = true
      entry.cause = 'stopped'
      entry.record.state = 'settled'
      entry.record.cause = 'stopped'
      cancelled.push(sessionId)
    }
    for (const task of target.tasks) {
      if (task.state === 'running') {
        task.state = 'cancelled'
        task.endedAt = Date.now()
      }
    }
    if (target.integrator?.state === 'running') target.integrator.state = 'failed'
    target.status = 'stopped'
    target.phase = 'done'
    target.error = target.error || `stopped (${reason})`
    await this.refreshManifest(target)
    await this.save(target)
    await this.notifyCaller(target)
    this.releaseRun(target.id)
    return { run_id: target.id, status: target.status, cancelled, cancelled_count: cancelled.length }
  }

  cancelSession(entry) {
    try {
      this.controller().cancel({ sessionId: entry.sessionId })
    } catch (error) {
      this.log(`cancel ${entry.sessionId} failed: ${String(error)}`)
    }
  }

  // ---------------------------------------------------------------------
  // UI state (v1-compatible shape: the dock is untouched)
  // ---------------------------------------------------------------------

  uiState() {
    const runs = [...this.runs.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 8)
      .map((run) => {
        const totals = run.totals ?? stateSummary(run.tasks)
        const status = UI_STATUS[run.status] ?? run.status
        const phase = run.status === 'integrating' ? 'integrating' : run.status === 'running' || run.status === 'paused' ? 'workers' : 'done'
        return {
          run_id: run.id,
          depth: Math.max(0, Math.floor(Number(run.depth ?? 0))),
          parent_run_id: String(run.parentRunId ?? ''),
          // Sessions this run owns: the client marks their sidebar rows so one
          // workspace full of fan-out sessions stays readable.
          sessions: (run.sessions ?? []).map((row) => String(row?.id ?? '')).filter((id) => id.length > 0),
          caller_session_id: String(run.callerSessionId ?? ''),
          model_label: String(run.modelLabel ?? ''),
          status,
          total: totals.total,
          settled: totals.settled,
          failed: totals.failed,
          workers: run.maxConcurrent ?? 1,
          phase: phaseOf({ status, integratorState: run.integrator?.state ?? '' }),
          percent: progressOf({ totalWorkers: totals.total, settledWorkers: totals.settled, integratorState: run.integrator?.state ?? '', status }),
          integrate: run.integrateRequested !== false,
          integrator_state: run.integrator?.state ?? '',
          final_path: run.finalPath ?? '',
          estimate_tokens: run.estimate?.approx_tokens ?? 0,
          created_at: new Date(run.createdAt).toISOString(),
          updated_at: new Date(run.updatedAt ?? Date.now()).toISOString(),
          objective: String(run.objective ?? '').slice(0, 160),
          worker_details: (run.tasks ?? []).map((task, index) => ({
            index,
            state: task.state === 'completed' ? 'settled' : task.state === 'cancelled' ? 'stopped' : task.state,
            weight: task.weight,
            session_id: task.sessionId,
            summary: String(task.summary ?? '').slice(0, 160),
            error: task.error ? String(task.error) : undefined,
            tasks: [{ id: task.id, title: task.title }],
          })),
        }
      })
    const active = runs.find((run) => run.status === 'running' || run.status === 'integrating' || run.status === 'queued')
    return {
      runs,
      active_run_id: active?.run_id ?? '',
      // One line the takeover panel renders even before any run exists.
      model_label: String(this.modelLabel ?? ''),
      model_error: String(this.modelError ?? ''),
      max_depth: this.maxDepth(),
    }
  }

  // ---------------------------------------------------------------------
  // Recovery (restart / reload)
  // ---------------------------------------------------------------------

  hydrate(raw) {
    if (raw === null || typeof raw !== 'object') throw new Error('run record is not an object')
    if (raw.v === 2) {
      return {
        ...raw,
        tasks: Array.isArray(raw.tasks) ? raw.tasks : [],
        sessions: Array.isArray(raw.sessions) ? raw.sessions : [],
        gates: raw.gates ?? { staged: false, paused: false, escalated: false, reason: '' },
        maxConcurrent: raw.maxConcurrent ?? this.config.defaultWorkers,
        maxReviewRounds: raw.maxReviewRounds ?? 3,
        maxAttempts: raw.maxAttempts ?? 2,
        maxWorkers: raw.maxWorkers,
        reviewEnabled: raw.reviewEnabled !== false,
      }
    }
    return this.migrateV1(raw)
  }

  /** Adopt a v1 run (flat worker packing) as a v2 graph. */
  migrateV1(raw) {
    const workers = Array.isArray(raw.workers) ? raw.workers : []
    const tasks = workers.map((worker, index) => {
      const ids = Array.isArray(worker.taskIds) ? worker.taskIds : []
      const source = (raw.tasks ?? []).filter((task) => ids.includes(task.id))
      const title = source.map((task) => task.title).join(' + ') || `worker ${index + 1}`
      const state = worker.state === 'settled' ? 'completed' : worker.state === 'failed' ? 'failed' : 'running'
      return {
        id: `w${index + 1}`,
        title,
        brief: source.map((task) => task.brief).join('\n\n'),
        kind: 'work',
        weight: worker.weight ?? 1,
        deps: [],
        scope: [],
        contract: {
          objective: String(raw.objective ?? ''),
          acceptance: [],
          verify: Array.isArray(raw.verify) ? raw.verify : [],
          inScope: [],
          outOfScope: [],
        },
        review: false,
        auto: false,
        state,
        attempt: 1,
        attemptId: `w${index + 1}-a1-legacy`,
        sessionId: worker.sessionId ?? '',
        startedAt: raw.createdAt ?? 0,
        endedAt: state === 'running' ? 0 : raw.updatedAt ?? 0,
        resultPath: '',
        summary: worker.summary ?? '',
        digest: worker.digest ?? '',
        error: worker.error ?? '',
        acceptanceResults: [],
        findings: [],
        closed: [],
        round: 0,
        sourceTaskId: '',
        sourceFindingIds: [],
      }
    })
    const sessions = tasks
      .filter((task) => task.sessionId.length > 0)
      .map((task) => ({
        id: task.sessionId,
        role: 'task',
        taskId: task.id,
        attemptId: task.attemptId,
        state: task.state === 'running' ? 'running' : 'settled',
        startedAt: raw.createdAt ?? 0,
        deadlineAt: raw.deadlineAt ?? 0,
        cause: '',
      }))
    if (raw.integrator?.sessionId) {
      sessions.push({
        id: raw.integrator.sessionId,
        role: 'integrator',
        taskId: '',
        attemptId: '',
        state: raw.integrator.state === 'running' ? 'running' : 'settled',
        startedAt: raw.updatedAt ?? 0,
        deadlineAt: raw.deadlineAt ?? 0,
        cause: '',
      })
    }
    return {
      v: 2,
      id: raw.id,
      createdAt: raw.createdAt ?? Date.now(),
      updatedAt: raw.updatedAt ?? Date.now(),
      status: raw.status === 'running' || raw.status === 'integrating' ? raw.status : raw.status,
      phase: raw.status === 'integrating' ? 'integrating' : 'workers',
      objective: String(raw.objective ?? ''),
      cwd: String(raw.cwd ?? this.callerCwd()),
      callerSessionId: String(raw.callerSessionId ?? ''),
      depth: Math.max(0, Math.floor(Number(raw.depth ?? 0))),
      parentRunId: String(raw.parentRunId ?? ''),
      modelLabel: String(raw.modelLabel ?? ''),
      expansion: raw.expansion ?? 0,
      verify: Array.isArray(raw.verify) ? raw.verify : [],
      integrateRequested: raw.integrateRequested !== false,
      reviewEnabled: false,
      maxConcurrent: Math.max(1, workers.length),
      maxReviewRounds: 1,
      maxAttempts: 1,
      approval: 'automatic',
      approvedAt: raw.createdAt ?? 0,
      tasks,
      sessions,
      warnings: ['adopted from a v1 run record (reviews disabled)'],
      gates: { staged: false, paused: false, escalated: false, reason: '' },
      integrator: raw.integrator === undefined
        ? undefined
        : {
            sessionId: raw.integrator.sessionId ?? '',
            state: raw.integrator.state ?? 'running',
            attempt: 1,
            summary: raw.integrator.summary ?? '',
            digest: raw.integrator.digest ?? '',
          },
      estimate: raw.estimate,
      deadlineAt: raw.deadlineAt ?? Date.now() + 3600000,
      workerTimeoutMs: raw.workerTimeoutMs ?? 25 * 60000,
      resultDigestChars: raw.resultDigestChars ?? 1200,
      runDir: this.store.runDir(raw.id),
      finalPath: raw.finalPath ?? '',
      error: raw.error ?? '',
      migratedFromV1: true,
    }
  }

  async recover() {
    const stored = await this.store.listRuns(50).catch(() => [])
    const candidates = stored
      .filter((raw) => raw !== undefined && typeof raw === 'object' && typeof raw.id === 'string')
      .filter((raw) => !TERMINAL.has(raw.status))
      .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
    for (const raw of candidates) {
      if (this.runs.has(raw.id)) continue
      let run
      try {
        run = this.hydrate(raw)
      } catch (error) {
        this.log(`could not hydrate ${raw.id}: ${String(error)}`)
        continue
      }
      this.runs.set(run.id, run)
      this.rehydrateTracking(run)
      this.log(`recovered run ${run.id} (${run.status}, ${run.tasks.length} tasks)`)
      if (run.status === 'running' || run.status === 'integrating') {
        void this.enqueue(async () => {
          try {
            await this.probeRecovered(run)
            if (run.status === 'running') {
              await this.schedule(run)
              await this.maybeIntegrate(run)
            }
          } catch (error) {
            this.log(`recovery of ${run.id} failed: ${String(error)}`)
          }
        })
      }
    }
    // Keep the last few finished runs visible in the dock after a reload: they
    // are display-only (historyOnly) and never scheduled.
    const finished = stored
      .filter((raw) => raw !== undefined && typeof raw === 'object' && typeof raw.id === 'string')
      .filter((raw) => TERMINAL.has(raw.status) || raw.status === 'escalated')
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
      .slice(0, 5)
    for (const raw of finished) {
      if (this.runs.has(raw.id)) continue
      try {
        const run = this.hydrate(raw)
        run.historyOnly = true
        this.runs.set(run.id, run)
      } catch (error) {
        this.log(`could not load history run ${raw.id}: ${String(error)}`)
      }
    }
  }

  rehydrateTracking(run) {
    for (const session of run.sessions ?? []) {
      if (session.state !== 'running') continue
      if (this.tracked.has(session.id)) continue
      const entry = {
        runId: run.id,
        role: session.role,
        sessionId: session.id,
        taskId: session.taskId,
        attemptId: session.attemptId,
        running: true,
        started: true,
        settled: false,
        settledAt: 0,
        cause: '',
        lastReason: undefined,
        deadlineAt: session.deadlineAt > 0 ? session.deadlineAt : Date.now() + run.workerTimeoutMs,
        waiter: undefined,
        promptDone: Promise.resolve(),
        promptError: '',
        record: session,
      }
      this.tracked.set(session.id, entry)
    }
  }

  /** Reconcile tracked entries with the live session list after adoption. */
  async probeRecovered(run) {
    const controller = this.controller()
    let items = []
    if (typeof controller.list === 'function') {
      try {
        const listed = await controller.list({}, new AbortController().signal)
        items = Array.isArray(listed?.items) ? listed.items : []
      } catch (error) {
        this.log(`list sessions failed: ${String(error)}`)
      }
    }
    const byId = new Map(items.map((item) => [item.sessionId, item]))
    for (const session of [...(run.sessions ?? [])]) {
      if (session.state !== 'running') continue
      const entry = this.tracked.get(session.id)
      if (entry === undefined || entry.settled) continue
      const live = byId.get(session.id)
      const stillRunning = live === undefined ? undefined : live.running === true
      if (stillRunning === false && items.length > 0) {
        this.settle(entry, 'recovered-idle')
      } else if (items.length > 0 && live === undefined) {
        // The session no longer exists: do not wait for a settle that will never come.
        entry.settled = true
        entry.cause = 'session-missing'
        session.state = 'settled'
        session.cause = 'session-missing'
        const task = taskById(run.tasks, session.taskId)
        if (task !== undefined && task.state === 'running') {
          task.state = 'failed'
          task.error = 'session disappeared while the run was unmanaged (takeover/retry is available)'
        }
      }
    }
  }

  // ---------------------------------------------------------------------
  // Watchdog
  // ---------------------------------------------------------------------

  tick() {
    if (this.disposed) return
    const now = Date.now()
    for (const entry of [...this.tracked.values()]) {
      if (entry.settled) continue
      if (entry.deadlineAt > 0 && now >= entry.deadlineAt) {
        this.log(`deadline reached for ${entry.role} ${entry.sessionId}; cancelling`)
        this.cancelSession(entry)
        this.settle(entry, 'timeout')
      }
    }
    for (const run of [...this.runs.values()]) {
      if (!ACTIVE.has(run.status) && run.status !== 'escalated') continue
      if (now < (run.deadlineAt ?? 0)) continue
      this.log(`run ${run.id} reached its global deadline`)
      for (const entry of [...this.tracked.values()]) {
        if (entry.runId !== run.id || entry.settled) continue
        this.cancelSession(entry)
        entry.settled = true
        entry.record.state = 'settled'
        entry.record.cause = 'run-timeout'
      }
      for (const task of run.tasks) {
        if (task.state === 'running') {
          task.state = 'failed'
          task.error = 'run deadline reached'
          task.endedAt = now
        }
      }
      run.status = 'failed'
      run.phase = 'done'
      run.error = run.error || 'run deadline reached'
      void this.save(run)
      void this.notifyCaller(run)
      this.releaseRun(run.id)
    }
  }

  // ---------------------------------------------------------------------
  // Divergence gate (unchanged behaviour, moved here)
  // ---------------------------------------------------------------------

  axesForIntensity(intensity) {
    const table = [1, 2, 3, 5, 8]
    const level = Math.max(1, Math.min(5, Math.floor(Number(intensity) || 3)))
    return table[level - 1]
  }

  async readProbeText(divergence, axisId, entry, cwd) {
    const relative = path.join(FanoutStoreDivergenceDir(divergence.id), `${axisId}.md`)
    try {
      const text = await fsp.readFile(path.resolve(cwd, relative), 'utf8')
      if (text.trim().length > 0) return text
    } catch {
      // Fall through to the session log.
    }
    try {
      const inspection = await this.controller().inspect(entry.sessionId)
      return lastAssistantText(inspection?.events ?? [])
    } catch (error) {
      this.log(`inspect probe ${entry.sessionId} failed: ${String(error)}`)
      return ''
    }
  }

  async waitForEntries(entries, timeoutMs) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (entries.every((entry) => entry.settled)) return
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }

  async divergence(request, caller) {
    const controller = this.controller()
    const decisions = Array.isArray(request?.decisions) ? request.decisions : undefined
    if (decisions !== undefined) return this.classifyDivergence(request, decisions)

    const objective = String(request?.objective ?? '').trim()
    if (objective.length === 0) throw new Error('divergence_check requires a non-empty objective')
    const plan = expansionPlan(this.config.defaultExpansion)
    const intensity = request?.intensity === undefined ? undefined : Math.max(1, Math.min(5, Math.floor(Number(request.intensity) || 3)))
    const axisCount = intensity === undefined ? Math.max(1, plan.axes) : this.axesForIntensity(intensity)
    const axes = DIVERGENCE_AXES.slice(0, Math.min(axisCount, DIVERGENCE_AXES.length))
    const cwd = typeof request?.cwd === 'string' && request.cwd.trim().length > 0
      ? path.resolve(request.cwd.trim())
      : this.callerCwd(caller)
    const id = makeRunId('div')
    const divergence = {
      v: 1,
      id,
      createdAt: Date.now(),
      phase: 'probing',
      objective,
      proposal: String(request?.proposal ?? '').slice(0, 6000),
      constraints: Array.isArray(request?.constraints)
        ? request.constraints.filter((item) => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim()).slice(0, 12)
        : [],
      axes: axes.map((axis) => ({ id: axis.id, label: axis.label })),
      probes: [],
      options: [],
      decisions: undefined,
      cwd,
      callerSessionId: typeof caller?.id === 'string' ? caller.id : '',
    }
    await this.store.saveDivergence(divergence)

    const entries = []
    const pseudoRun = { id, cwd, sessions: [] }
    for (const axis of axes) {
      try {
        const entry = await this.spawnSession({
          run: pseudoRun,
          role: 'probe',
          meta: { divergenceId: id, axisId: axis.id },
          brief: renderProbeBrief(divergence, axis),
          deadlineAt: Date.now() + 120000,
          sessionTag: 'fanout-probe',
        })
        entries.push({ axis, entry })
        divergence.probes.push({ axis: axis.id, session_id: entry.sessionId, state: 'running', options: 0 })
      } catch (error) {
        this.log(`probe ${axis.id} failed to start: ${String(error)}`)
        divergence.probes.push({ axis: axis.id, session_id: '', state: 'failed', options: 0, error: String(error?.message ?? error) })
      }
    }

    await this.waitForEntries(entries.map((item) => item.entry), 90000)

    const options = []
    let optionIndex = 0
    for (const { axis, entry } of entries) {
      if (!entry.settled) this.cancelSession(entry)
      const text = entry.settled ? await this.readProbeText(divergence, axis.id, entry, cwd) : ''
      const parsed = parseOptionLines(text)
      const probe = divergence.probes.find((item) => item.axis === axis.id)
      if (probe !== undefined) {
        probe.state = entry.settled ? 'settled' : 'timeout'
        probe.options = parsed.length
      }
      for (const value of parsed) {
        optionIndex += 1
        options.push({ option_id: `a${optionIndex}`, axis: axis.id, axis_label: axis.label, text: value })
      }
    }
    for (const entry of [...this.tracked.values()]) {
      if (entry.runId === id) this.tracked.delete(entry.sessionId)
    }
    divergence.options = options
    divergence.phase = 'report'
    divergence.probesFailed = divergence.probes.filter((probe) => probe.state !== 'settled').length
    await this.store.saveDivergence(divergence)
    const required = intensity === undefined ? plan.classify || axisCount >= 5 : axisCount >= 5
    return {
      phase: 'report',
      divergence_id: id,
      objective: objective.slice(0, 300),
      axes: divergence.axes,
      options,
      probes: {
        spawned: divergence.probes.length,
        settled: divergence.probes.filter((probe) => probe.state === 'settled').length,
        failed: divergence.probesFailed,
        sessions: divergence.probes.map((probe) => probe.session_id).filter((value) => value.length > 0),
      },
      required,
      message: options.length === 0
        ? 'No probe returned options. Treat the option space as unproven and re-run with a higher intensity or a narrower objective.'
        : `Classify EVERY option (adopt / reject / defer with a reason), then call divergence_check again with divergence_id="${id}" and decisions=[...]. The gate stays closed until then.`,
    }
  }

  async classifyDivergence(request, decisions) {
    const id = typeof request?.divergence_id === 'string' ? request.divergence_id.trim() : ''
    if (id.length === 0) throw new Error('divergence_check with decisions requires divergence_id from the report phase')
    const record = await this.store.loadDivergence(id)
    if (record === undefined) throw new Error(`divergence ${id} not found`)
    const known = new Map((record.options ?? []).map((option) => [option.option_id, option]))
    const cleaned = []
    for (const item of decisions) {
      if (item === null || typeof item !== 'object') continue
      const optionId = String(item.option_id ?? '').trim()
      const decision = String(item.decision ?? '').trim()
      const reason = String(item.reason ?? '').trim()
      if (!known.has(optionId)) continue
      if (!['adopt', 'reject', 'defer'].includes(decision)) continue
      cleaned.push({ option_id: optionId, decision, reason: reason.slice(0, 400) })
    }
    const covered = new Set(cleaned.map((item) => item.option_id))
    const missing = [...known.keys()].filter((optionId) => !covered.has(optionId))
    if (missing.length > 0) {
      return {
        phase: 'report',
        divergence_id: id,
        options: record.options,
        required: true,
        missing,
        message: `The gate is still closed: ${missing.length} option(s) were not classified (${missing.join(', ')}). Decide every option and call again.`,
      }
    }
    record.phase = 'classified'
    record.decisions = cleaned
    record.classifiedAt = Date.now()
    await this.store.saveDivergence(record)
    return {
      phase: 'classified',
      divergence_id: id,
      accepted: true,
      recorded: cleaned,
      storage: this.store.divergenceFile(id),
      message:
        'Gate closed with a recorded classification. Proceed with the adopted options only where the reasoning survives; the record is on disk for later review.',
    }
  }

  // ---------------------------------------------------------------------
  // UI-triggered planning
  // ---------------------------------------------------------------------

  async requestPlan({ objective, workers, expansion, verify, sessionId }) {
    const controller = this.controller()
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      return { planning: false, reason: 'no-caller-session' }
    }
    const verifyAttr = Array.isArray(verify) && verify.length > 0
      ? ` verify="${verify.join(' | ').replace(/"/g, "'")}"`
      : ''
    const text = `<fanout_request workers="${workers}" expansion="${expansion}"${verifyAttr}>
目的: ${String(objective).slice(0, 4000)}

この依頼を 2〜6 個の「大きさの違う仕事」に分解し、fanout_start を tasks 付きで呼んでください。
- tasks: [{ title, brief, weight, dependsOn?, kind?, acceptance?, verify?, inScope?, scope? }]
- 依存があるなら dependsOn に task id（t1 / t2 …）を入れる。無いなら省略してよい。
- kind は work / requirements / implementation / verification のいずれか（既定 work）。
  implementation を名乗るなら acceptance と verify を必ず書く（書式はツール説明を見る）。
- brief はその仕事だけで完結する自己完結の指示にする（触るファイル、受け入れ条件、確認方法）。
- workers=${workers} / expansion=${expansion} をそのまま渡す。
- ワーカーにはこの会話は渡りません。brief に必要な前提はすべて書いてください。
</fanout_request>`
    await controller.prompt(
      {
        requestId: `fanout-plan-${randomUUID()}`,
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text }],
        clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
      new AbortController().signal,
    )
    return { planning: true, session_id: sessionId }
  }
}

/** Kept tiny so the module does not import the store just for a path helper. */
function FanoutStoreDivergenceDir(id) {
  return path.join('.dsh-fanout', 'divergence', id)
}

/**
 * dsh-fanout engine — the orchestration state machine.
 *
 * One run: pack tasks -> create worker sessions -> prompt each with a bounded
 * brief -> observe settle events -> collect bounded digests -> create one
 * integrator session that merges, verifies and builds -> notify the caller.
 *
 * Design rules enforced here:
 *   - workers never receive the parent transcript and the parent never receives
 *     worker transcripts (only digests read from result files / last message);
 *   - every wait has a deadline and every session has a cancel path;
 *   - all durable state is written before it is reported, so a crash leaves
 *     readable evidence behind.
 *
 * @module dsh-fanout/lib/engine
 */

import { randomUUID } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import path from 'node:path'

import { clampInt, estimateBudget, expansionPlan, makeRunId, normalizeTasks, packTasks } from './plan.js'
import { DIVERGENCE_AXES, renderCallerDigest, renderIntegratorBrief, renderProbeBrief, renderWorkerBrief } from './prompts.js'
import { FanoutStore } from './store.js'

const TERMINAL = new Set(['completed', 'failed', 'stopped'])

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

/** Extract the text of the last assistant message from a session event list. */
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

function lastTurnReason(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.type === 'turn/end') return events[index].data?.reason
  }
  return undefined
}

/** Parse "OPTION: ..." lines out of a probe answer. */
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

export class FanoutEngine {
  constructor({ ctx, store, config, log }) {
    this.ctx = ctx
    this.store = store ?? new FanoutStore(config.storeDir)
    this.config = config
    this.log = log ?? (() => {})
    /** runId -> run record (live). */
    this.runs = new Map()
    /** sessionId -> tracked entry. */
    this.tracked = new Map()
    this.timer = undefined
    this.disposed = false
  }

  controller() {
    const service = this.ctx.get('sessionController')
    if (
      service === undefined ||
      typeof service.create !== 'function' ||
      typeof service.prompt !== 'function'
    ) {
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

  async init() {
    await this.store.ensure().catch((error) => this.log(`ensure store failed: ${String(error)}`))
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

  // ---------------------------------------------------------------------
  // Session tracking
  // ---------------------------------------------------------------------

  trackSession(runId, role, meta) {
    return {
      runId,
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
    }
  }

  /** Create one ordinary session, prompt it, and start tracking it. */
  async spawn({ runId, role, meta, brief, cwd, deadlineAt, sessionTag }) {
    const controller = this.controller()
    const created = await controller.create(cwd !== undefined ? { cwd } : {})
    const sessionId = created.sessionId
    const entry = this.trackSession(runId, role, { sessionId, ...meta })
    entry.deadlineAt = deadlineAt ?? 0
    this.tracked.set(sessionId, entry)
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
      // A prompted session is presumed running until its settle event arrives;
      // this also protects fast finishes that beat the status listener.
      entry.running = true
      entry.started = true
    } catch (error) {
      entry.settled = true
      entry.cause = 'prompt-failed'
      entry.error = String(error?.message ?? error)
      throw error
    }
    return entry
  }

  /** Global `api-session/status` listener body. */
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

  /** Global `session/event` listener body. */
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
    if (typeof entry.waiter === 'function') entry.waiter()
    if (entry.role === 'worker') void this.onWorkerSettled(entry)
    if (entry.role === 'integrator') void this.onIntegratorSettled(entry)
  }

  cancelSession(entry) {
    try {
      this.controller().cancel({ sessionId: entry.sessionId })
    } catch (error) {
      this.log(`cancel ${entry.sessionId} failed: ${String(error)}`)
    }
  }

  // ---------------------------------------------------------------------
  // Start
  // ---------------------------------------------------------------------

  async start(request, caller) {
    this.controller()
    const config = this.config
    const objective = String(request?.objective ?? '').trim()
    if (objective.length === 0) throw new Error('fanout_start requires a non-empty objective')

    const tasks = normalizeTasks(request?.tasks)
    const requireTasks = request?.requireTasks === true
    if (tasks.length === 0 && requireTasks) {
      throw new Error(
        'fanout_start requires a non-empty tasks array: list the large asymmetric jobs and their briefs so workers can be packed.',
      )
    }
    const fallbackTasks = tasks.length > 0
      ? tasks
      : normalizeTasks([{ title: objective.slice(0, 120), brief: objective, weight: 1 }])

    const maxWorkers = clampInt(config.maxWorkers, 8, 1, 16)
    const requestedWorkers = clampInt(
      request?.workers,
      config.defaultWorkers,
      1,
      Math.min(maxWorkers, fallbackTasks.length),
    )
    const buckets = packTasks(fallbackTasks, requestedWorkers)
    const expansion = clampInt(
      request?.expansion,
      config.defaultExpansion,
      0,
      config.maxExpansion ?? 100,
    )
    const cwd = typeof request?.cwd === 'string' && request.cwd.trim().length > 0
      ? path.resolve(request.cwd.trim())
      : this.callerCwd(caller)
    const callerSessionId = typeof caller?.id === 'string' ? caller.id : String(request?.callerSessionId ?? '')
    const runId = makeRunId('run')
    const workerTimeoutMs = clampInt(
      request?.timeoutMinutes,
      config.workerTimeoutMinutes,
      2,
      240,
    ) * 60000
    const runTimeoutMs = clampInt(config.runTimeoutMinutes, 120, 5, 720) * 60000
    const verify = Array.isArray(request?.verify)
      ? request.verify.filter((item) => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim()).slice(0, 12)
      : []
    const integrateRequested = request?.integrate !== false && config.integrate !== false

    const run = {
      v: 1,
      id: runId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: 'running',
      objective,
      cwd,
      callerSessionId,
      expansion,
      verify,
      integrateRequested,
      tasks: fallbackTasks,
      workers: buckets.map((bucket) => ({
        index: bucket.index,
        taskIds: bucket.taskIds,
        weight: bucket.weight,
        sessionId: '',
        state: 'pending',
        digest: '',
        summary: '',
        error: '',
      })),
      integrator: undefined,
      settledWorkers: 0,
      deadlineAt: Date.now() + runTimeoutMs,
      workerTimeoutMs,
      resultDigestChars: clampInt(config.resultDigestChars, 1200, 200, 6000),
      runDir: this.store.runDir(runId),
      finalPath: '',
      estimate: estimateBudget({ tasks: fallbackTasks, workers: buckets.length, expansion }),
      error: '',
    }
    await this.store.createRun(run)
    this.runs.set(runId, run)

    const spawned = []
    for (const worker of run.workers) {
      const bucket = { index: worker.index, taskIds: worker.taskIds, weight: worker.weight }
      try {
        const entry = await this.spawn({
          runId,
          role: 'worker',
          meta: { workerIndex: worker.index, taskIds: worker.taskIds },
          brief: renderWorkerBrief(run, bucket),
          cwd: run.cwd,
          deadlineAt: Date.now() + workerTimeoutMs,
          sessionTag: 'fanout-worker',
        })
        worker.sessionId = entry.sessionId
        worker.state = 'running'
        spawned.push(entry)
      } catch (error) {
        worker.state = 'failed'
        worker.error = String(error?.message ?? error)
        this.log(`worker ${worker.index + 1} failed to start: ${String(error)}`)
      }
    }
    run.settledWorkers = run.workers.filter((worker) => worker.state !== 'running' && worker.state !== 'pending').length
    await this.store.saveRun(run)

    if (run.workers.every((worker) => worker.state !== 'running')) {
      void this.maybeIntegrate(run)
    }

    return {
      run_id: run.id,
      status: run.status,
      workers: run.workers.map((worker) => ({
        session_id: worker.sessionId,
        task_ids: worker.taskIds,
        weight: worker.weight,
        state: worker.state,
      })),
      integrator_session_id: '',
      estimate: run.estimate,
      store_dir: run.runDir,
      spawned_sessions: spawned.map((entry) => entry.sessionId),
      started_at: nowIso(),
    }
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

  /**
   * UI started a run with an objective but no task list.
   *
   * The plugin cannot split a goal into *meaningful* asymmetric jobs by itself,
   * so it asks the current session's model to do the decomposition and call
   * `fanout_start` with tasks. That keeps the slider values (workers/expansion)
   * and the verify commands intact instead of silently degrading to one worker.
   */
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
- tasks: [{ title, brief, weight, scope? }]。weight はおおよその大きさ（0.5〜5）。
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

  // ---------------------------------------------------------------------
  // Worker settle -> integration
  // ---------------------------------------------------------------------

  async readWorkerResult(run, worker, entry) {
    const fileName = `worker-${worker.index + 1}.md`
    let text = await this.store.readResult(run.id, fileName).catch(() => undefined)
    if (text === undefined) {
      try {
        const inspection = await this.controller().inspect(entry.sessionId)
        text = lastAssistantText(inspection?.events ?? [])
      } catch (error) {
        this.log(`inspect worker ${entry.sessionId} failed: ${String(error)}`)
        text = ''
      }
    }
    const clean = String(text ?? '').trim()
    const digest = clean.slice(0, run.resultDigestChars)
    const summary = clean
      .split(/\r?\n/)
      .map((line) => line.replace(/^#+\s*/, '').trim())
      .filter((line) => line.length > 0 && !/^summary$/i.test(line))[0] ?? ''
    return { digest, summary: summary.slice(0, 240) }
  }

  async onWorkerSettled(entry) {
    const run = this.runs.get(entry.runId)
    if (run === undefined) return
    const worker = run.workers.find((item) => item.sessionId === entry.sessionId)
    if (worker === undefined) return
    try {
      const { digest, summary } = await this.readWorkerResult(run, worker, entry)
      worker.digest = digest
      worker.summary = summary
      const reasonKind = entry.lastReason?.kind
      worker.state = digest.length > 0
        ? 'settled'
        : reasonKind === undefined || reasonKind === 'completed'
          ? 'settled'
          : 'failed'
      if (worker.state === 'failed') {
        worker.error = `turn ended with ${String(reasonKind)} and no result file`
      }
    } catch (error) {
      worker.state = 'failed'
      worker.error = String(error?.message ?? error)
    }
    run.settledWorkers = run.workers.filter((item) => item.state !== 'running' && item.state !== 'pending').length
    await this.store.saveRun(run).catch((error) => this.log(`save run failed: ${String(error)}`))
    await this.maybeIntegrate(run)
  }

  async maybeIntegrate(run) {
    if (run.integrating === true) return
    if (run.status !== 'running') return
    if (run.workers.some((worker) => worker.state === 'running' || worker.state === 'pending')) return
    run.integrating = true
    if (run.integrateRequested === false) {
      run.status = 'completed'
      run.finalPath = ''
      await this.store.saveRun(run).catch(() => {})
      await this.notifyCaller(run)
      this.releaseRun(run.id)
      return
    }
    await this.integrate(run)
  }

  async integrate(run) {
    run.status = 'integrating'
    await this.store.saveRun(run).catch((error) => this.log(`save run failed: ${String(error)}`))
    try {
      const entry = await this.spawn({
        runId: run.id,
        role: 'integrator',
        meta: {},
        brief: renderIntegratorBrief(run),
        cwd: run.cwd,
        deadlineAt: Date.now() + clampInt(this.config.workerTimeoutMinutes, 25, 2, 240) * 60000,
        sessionTag: 'fanout-integrator',
      })
      run.integrator = { sessionId: entry.sessionId, state: 'running', digest: '', summary: '' }
      await this.store.saveRun(run)
    } catch (error) {
      run.status = 'failed'
      run.error = `integrator could not start: ${String(error?.message ?? error)}`
      await this.store.saveRun(run).catch(() => {})
      await this.notifyCaller(run)
      this.releaseRun(run.id)
    }
  }

  async onIntegratorSettled(entry) {
    const run = this.runs.get(entry.runId)
    if (run === undefined) return
    let final = ''
    try {
      final = (await this.store.readFinal(run.id)) ?? ''
    } catch (error) {
      this.log(`read final failed: ${String(error)}`)
    }
    if (final.trim().length === 0) {
      try {
        const inspection = await this.controller().inspect(entry.sessionId)
        final = lastAssistantText(inspection?.events ?? [])
      } catch (error) {
        this.log(`inspect integrator failed: ${String(error)}`)
      }
    }
    run.integrator = {
      ...(run.integrator ?? {}),
      sessionId: entry.sessionId,
      state: final.trim().length > 0 ? 'settled' : 'failed',
      digest: final.slice(0, 1600),
      summary: final.replace(/\s+/g, ' ').slice(0, 400),
    }
    run.status = final.trim().length > 0 ? 'completed' : 'failed'
    if (run.status === 'failed') run.error = 'integrator produced no final report'
    run.finalPath = path.join(run.runDir, 'final.md')
    await this.store.saveRun(run).catch((error) => this.log(`save run failed: ${String(error)}`))
    await this.notifyCaller(run)
    if (this.config.archiveWorkers === true) await this.archiveWorkers(run)
    this.releaseRun(run.id)
  }

  releaseRun(runId) {
    for (const [sessionId, entry] of this.tracked) {
      if (entry.runId === runId) this.tracked.delete(sessionId)
    }
  }

  async archiveWorkers(run) {
    const registry = this.ctx.get('workspaceRegistry')
    if (registry === undefined || typeof registry.archiveSession !== 'function') return
    for (const worker of run.workers) {
      if (worker.sessionId.length === 0) continue
      try {
        await registry.archiveSession(worker.sessionId, {})
      } catch (error) {
        this.log(`archive worker ${worker.sessionId} failed: ${String(error)}`)
      }
    }
  }

  async notifyCaller(run) {
    if (this.config.notifyCaller === false) return
    const agents = this.agentsService()
    if (agents === undefined || typeof agents.get !== 'function') return
    if (run.callerSessionId.length === 0) return
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

  // ---------------------------------------------------------------------
  // Status / stop
  // ---------------------------------------------------------------------

  status(runId) {
    if (typeof runId === 'string' && runId.length > 0) {
      const run = this.runs.get(runId)
      if (run !== undefined) return { runs: [this.compactRun(run)], run: this.compactRun(run) }
      return { runs: [], run: undefined, message: `run ${runId} is not active in this process` }
    }
    const live = [...this.runs.values()].map((run) => this.compactRun(run))
    return { runs: live, run: live[0] }
  }

  compactRun(run) {
    return {
      run_id: run.id,
      status: run.status,
      objective: run.objective.length > 240 ? `${run.objective.slice(0, 239)}…` : run.objective,
      created_at: new Date(run.createdAt).toISOString(),
      updated_at: new Date(run.updatedAt).toISOString(),
      workers: run.workers.map((worker) => ({
        index: worker.index,
        state: worker.state,
        session_id: worker.sessionId,
        task_ids: worker.taskIds,
        summary: worker.summary,
        error: worker.error || undefined,
      })),
      integrator: run.integrator,
      final_path: run.finalPath,
      run_dir: run.runDir,
      estimate: run.estimate,
      error: run.error || undefined,
    }
  }

  async stop(runId, reason = 'user') {
    const target = typeof runId === 'string' && runId.length > 0
      ? this.runs.get(runId)
      : [...this.runs.values()].find((run) => !TERMINAL.has(run.status))
    if (target === undefined) {
      return { run_id: runId ?? '', status: 'not-found', cancelled: [] }
    }
    const cancelled = []
    for (const [sessionId, entry] of this.tracked) {
      if (entry.runId !== target.id || entry.settled) continue
      this.cancelSession(entry)
      entry.settled = true
      entry.cause = 'stopped'
      cancelled.push(sessionId)
    }
    for (const worker of target.workers) {
      if (worker.state === 'running' || worker.state === 'pending') {
        worker.state = 'stopped'
      }
    }
    if (target.integrator?.state === 'running') target.integrator.state = 'stopped'
    target.status = 'stopped'
    target.error = target.error || `stopped (${reason})`
    await this.store.saveRun(target).catch((error) => this.log(`save stopped run failed: ${String(error)}`))
    await this.notifyCaller(target)
    this.releaseRun(target.id)
    return { run_id: target.id, status: target.status, cancelled, cancelled_count: cancelled.length }
  }

  // ---------------------------------------------------------------------
  // Divergence gate
  // ---------------------------------------------------------------------

  axesForIntensity(intensity) {
    const table = [1, 2, 3, 5, 8]
    return table[clampInt(intensity, 3, 1, 5) - 1]
  }

  async readProbeText(divergence, axisId, entry, cwd) {
    const relative = path.join(FanoutStore.workspaceDivergenceDir(divergence.id), `${axisId}.md`)
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
    // Without an explicit intensity the slider default decides the width; an
    // explicit 1–5 overrides it. Expansion slider 0 means "off", but an explicit
    // divergence call still probes at least one axis.
    const plan = expansionPlan(this.config.defaultExpansion)
    const intensity = request?.intensity === undefined
      ? undefined
      : clampInt(request.intensity, 3, 1, 5)
    const axisCount = intensity === undefined
      ? Math.max(1, plan.axes)
      : this.axesForIntensity(intensity)
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
    for (const axis of axes) {
      try {
        const entry = await this.spawn({
          runId: id,
          role: 'probe',
          meta: { divergenceId: id, axisId: axis.id },
          brief: renderProbeBrief(divergence, axis),
          cwd,
          deadlineAt: Date.now() + 120000,
          sessionTag: 'fanout-probe',
        })
        entries.push({ axis, entry })
        divergence.probes.push({ axis: axis.id, session_id: entry.sessionId, state: 'running', options: 0 })
      } catch (error) {
        this.log(`probe ${axis.id} failed to start: ${String(error)}`)
        divergence.probes.push({
          axis: axis.id,
          session_id: '',
          state: 'failed',
          options: 0,
          error: String(error?.message ?? error),
        })
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
        options.push({
          option_id: `a${optionIndex}`,
          axis: axis.id,
          axis_label: axis.label,
          text: value,
        })
      }
    }

    for (const entry of this.tracked.values()) {
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
    if (id.length === 0) {
      throw new Error('divergence_check with decisions requires divergence_id from the report phase')
    }
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
      if (TERMINAL.has(run.status)) continue
      if (now < run.deadlineAt) continue
      this.log(`run ${run.id} reached its global deadline`)
      for (const [sessionId, entry] of this.tracked) {
        if (entry.runId !== run.id || entry.settled) continue
        this.cancelSession(entry)
        this.settle(entry, 'run-timeout')
        void sessionId
      }
      if (run.status === 'running' && run.workers.some((worker) => worker.digest.length > 0 || worker.state === 'settled')) {
        void this.maybeIntegrate(run)
      } else if (run.status === 'running') {
        run.status = 'failed'
        run.error = 'run deadline reached before any worker produced a result'
        void this.store.saveRun(run).catch(() => {})
        void this.notifyCaller(run)
        this.releaseRun(run.id)
      } else if (run.status === 'integrating') {
        run.status = 'failed'
        run.error = 'run deadline reached while integrating'
        void this.store.saveRun(run).catch(() => {})
        void this.notifyCaller(run)
        this.releaseRun(run.id)
      }
    }
  }

  /** Compact state for the UI bridge. */
  uiState() {
    const runs = [...this.runs.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 8)
      .map((run) => ({
        run_id: run.id,
        status: run.status,
        total: run.workers.length,
        settled: run.workers.filter((worker) => worker.state !== 'running' && worker.state !== 'pending').length,
        failed: run.workers.filter((worker) => worker.state === 'failed').length,
        updated_at: new Date(run.updatedAt).toISOString(),
        objective: run.objective.slice(0, 160),
        estimate_tokens: run.estimate?.approx_tokens ?? 0,
      }))
    const active = runs.find((run) => !TERMINAL.has(run.status))
    return { runs, active_run_id: active?.run_id }
  }
}

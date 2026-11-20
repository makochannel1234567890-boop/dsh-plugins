/**
 * Pure task-graph helpers for dsh-fanout v2.
 *
 * The v1 plugin packed a flat list of jobs into workers. v2 models the same
 * request as a *graph*: nodes carry a kind, a quality contract and explicit
 * dependencies, and review / repair nodes are spliced in while the run is live.
 * Everything here is side-effect free so the scheduler rules can be tested
 * without a Harness.
 *
 * @module dsh-fanout/lib/graph
 */

import { clampInt, truncate } from './plan.js'

export const MAX_TASKS = 24

export const TASK_KINDS = Object.freeze([
  'work',
  'requirements',
  'implementation',
  'verification',
  'repair',
  'integration',
  'review',
])

/** Kinds that must carry an acceptance contract before they may run. */
export const QUALITY_KINDS = Object.freeze([
  'requirements',
  'implementation',
  'verification',
  'repair',
  'integration',
])

/** Kinds whose result is reviewed by a fresh reviewer before it counts. */
export const REVIEWED_KINDS = Object.freeze(['work', 'implementation', 'repair'])

const KIND_RANK = new Map([
  ['requirements', 0],
  ['implementation', 1],
  ['repair', 2],
  ['work', 3],
  ['verification', 4],
  ['review', 5],
  ['integration', 6],
])

export const TASK_STATES = Object.freeze([
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled',
])

const TERMINAL = new Set(['completed', 'failed', 'cancelled'])

function asText(value, max) {
  const text = typeof value === 'string' ? value.trim() : ''
  return max === undefined ? text : truncate(text, max)
}

function asList(value, max, itemMax = 400) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const text = item.trim()
    if (text.length === 0) continue
    out.push(truncate(text, itemMax))
    if (out.length >= max) break
  }
  return out
}

export function isTerminalState(state) {
  return TERMINAL.has(state)
}

export function isQualityKind(kind) {
  return QUALITY_KINDS.includes(kind)
}

export function isReviewedKind(kind) {
  return REVIEWED_KINDS.includes(kind)
}

/** A node id is user supplied only when it is a safe, unique slug. */
function normalizeId(raw, fallback) {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (/^[a-z][a-z0-9_-]{0,40}$/i.test(text)) return text
  return fallback
}

/**
 * Normalise a caller-supplied task list into graph nodes.
 *
 * Hard problems block the run; soft ones are recorded as warnings so a casual
 * call still works while an auditable one gets the full quality contract.
 *
 * @returns {{ tasks: object[], problems: string[], warnings: string[] }}
 */
export function normalizeGraph(input, options = {}) {
  const verifyDefault = asList(options.verifyDefault, 12)
  const problems = []
  const warnings = []
  const tasks = []
  if (!Array.isArray(input) || input.length === 0) {
    return { tasks: [], problems: ['tasks must be a non-empty array'], warnings }
  }
  if (input.length > MAX_TASKS) {
    problems.push(`at most ${MAX_TASKS} tasks are accepted (got ${input.length})`)
  }
  const usedIds = new Set()

  for (const raw of input.slice(0, MAX_TASKS)) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      problems.push('every task must be an object')
      continue
    }
    const title = asText(raw.title ?? raw.name, 160)
    const brief = asText(raw.brief ?? raw.description ?? raw.instructions, 4000)
    if (title.length === 0 && brief.length === 0) {
      problems.push(`task ${tasks.length + 1} has neither a title nor a brief`)
      continue
    }
    const baseId = normalizeId(raw.id, `t${tasks.length + 1}`)
    let id = baseId
    let suffix = 2
    while (usedIds.has(id)) {
      id = `${baseId}-${suffix}`
      suffix += 1
    }
    usedIds.add(id)

    const rawKind = typeof raw.kind === 'string' ? raw.kind.trim().toLowerCase() : ''
    let kind = 'work'
    if (rawKind.length > 0) {
      if (TASK_KINDS.includes(rawKind)) kind = rawKind
      else warnings.push(`${id}: unknown kind "${rawKind}", treated as work`)
    }

    const contract = raw.contract !== null && typeof raw.contract === 'object' ? raw.contract : {}
    const objective = asText(
      raw.objective ?? contract.objective ?? title,
      1800,
    )
    let acceptance = asList(raw.acceptance ?? contract.acceptance, 12, 300)
    const verify = asList(raw.verify ?? contract.verify ?? verifyDefault, 12, 300)
    const inScope = asList(raw.inScope ?? contract.inScope, 24, 240)
    const outOfScope = asList(raw.outOfScope ?? contract.outOfScope, 24, 240)

    if (isQualityKind(kind)) {
      if (objective.length === 0) {
        problems.push(`${id}: a ${kind} task needs an objective`)
      }
      if (acceptance.length === 0) {
        acceptance = [truncate(`${title || id}: the stated deliverable exists and its evidence is attached`, 300)]
        warnings.push(`${id}: acceptance criteria were defaulted (none supplied)`)
      }
      if (verify.length === 0 && kind !== 'requirements') {
        problems.push(`${id}: a ${kind} task needs at least one verify command (pass verify=[…] on the task or the run)`)
      }
    }

    const rawDeps = raw.dependsOn ?? raw.deps ?? raw.dependencies
    const deps = []
    if (rawDeps !== undefined && rawDeps !== null) {
      if (!Array.isArray(rawDeps)) problems.push(`${id}: dependsOn must be an array`)
      else {
        for (const dep of rawDeps) {
          if (typeof dep === 'number' && Number.isFinite(dep)) deps.push(`t${Math.trunc(dep)}`)
          else if (typeof dep === 'string' && dep.trim().length > 0) {
            const text = dep.trim()
            deps.push(/^\d+$/.test(text) ? `t${text}` : text)
          } else problems.push(`${id}: dependency entries must be ids or 1-based numbers`)
        }
      }
    }

    // Optional expert lenses. The parent records which summoned experts shaped
    // this job, so the worker brief can name the standard it inherits.
    const experts = [...new Set(asList(raw.experts, 6, 80))]

    tasks.push({
      id,
      title: title.length > 0 ? title : truncate(brief, 80),
      brief,
      experts,
      kind,
      weight: Number(Math.min(8, Math.max(0.25, Number.isFinite(Number(raw.weight)) ? Number(raw.weight) : 1)).toFixed(2)),
      deps: [...new Set(deps)],
      scope: asList(raw.scope, 12, 240),
      contract: { objective, acceptance, verify, inScope, outOfScope },
      review: raw.review !== false,
      auto: false,
      state: 'pending',
      attempt: 0,
      attemptId: '',
      sessionId: '',
      startedAt: 0,
      endedAt: 0,
      resultPath: '',
      summary: '',
      digest: '',
      error: '',
      acceptanceResults: [],
      findings: [],
      closed: [],
      round: 0,
      sourceTaskId: '',
      sourceFindingIds: [],
    })
  }

  // Resolve dependencies against the final id set.
  const ids = new Set(tasks.map((task) => task.id))
  for (const task of tasks) {
    const kept = []
    for (const dep of task.deps) {
      if (dep === task.id) problems.push(`${task.id}: a task cannot depend on itself`)
      else if (!ids.has(dep)) problems.push(`${task.id}: unknown dependency "${dep}"`)
      else kept.push(dep)
    }
    task.deps = [...new Set(kept)]
  }

  const graphCheck = validateGraph(tasks)
  problems.push(...graphCheck.problems)

  return { tasks, problems, warnings }
}

/** Structural validation: dependency existence and acyclicity. */
export function validateGraph(tasks) {
  const problems = []
  if (!Array.isArray(tasks)) return { problems: ['tasks must be an array'] }
  const byId = new Map(tasks.map((task) => [task.id, task]))
  for (const task of tasks) {
    for (const dep of task.deps ?? []) {
      if (!byId.has(dep)) problems.push(`${task.id}: unknown dependency "${dep}"`)
    }
  }
  const color = new Map()
  const visit = (id, trail) => {
    const state = color.get(id)
    if (state === 'done') return
    if (state === 'visiting') {
      problems.push(`dependency cycle: ${[...trail, id].join(' -> ')}`)
      return
    }
    color.set(id, 'visiting')
    const task = byId.get(id)
    for (const dep of task?.deps ?? []) visit(dep, [...trail, id])
    color.set(id, 'done')
  }
  for (const task of tasks) visit(task.id, [])
  return { problems: [...new Set(problems)] }
}

export function taskById(tasks, id) {
  return tasks.find((task) => task.id === id)
}

/** Nodes whose dependencies all completed, in scheduling priority order. */
export function readyTasks(tasks) {
  const byId = new Map(tasks.map((task) => [task.id, task]))
  return tasks
    .filter((task) => task.state === 'pending')
    .filter((task) => (task.deps ?? []).every((dep) => byId.get(dep)?.state === 'completed'))
    .sort((a, b) => {
      const rank = (KIND_RANK.get(a.kind) ?? 9) - (KIND_RANK.get(b.kind) ?? 9)
      if (rank !== 0) return rank
      if (b.weight !== a.weight) return b.weight - a.weight
      return a.id.localeCompare(b.id)
    })
}

export function attemptToken(taskId, attempt) {
  return `${taskId}-a${Math.max(1, Math.trunc(attempt))}`
}

export function nextAttempt(task) {
  return Math.max(0, Math.trunc(task.attempt ?? 0)) + 1
}

/** Insert the review node that gates `sourceId`'s result (dep defaults to the source). */
export function insertReview(tasks, sourceId, round, depId) {
  const id = `review-${sourceId}-r${round}`
  if (tasks.some((task) => task.id === id)) return taskById(tasks, id)
  const source = taskById(tasks, sourceId)
  const node = {
    id,
    title: `Review ${source?.title ?? sourceId} (round ${round})`,
    brief: '',
    kind: 'review',
    weight: 1,
    deps: [typeof depId === 'string' && depId.length > 0 ? depId : sourceId],
    scope: [],
    experts: [...(source?.experts ?? [])],
    contract: {
      objective: source?.contract?.objective ?? '',
      acceptance: [...(source?.contract?.acceptance ?? [])],
      verify: [...(source?.contract?.verify ?? [])],
      inScope: [],
      outOfScope: [],
    },
    review: false,
    auto: true,
    state: 'pending',
    attempt: 0,
    attemptId: '',
    sessionId: '',
    startedAt: 0,
    endedAt: 0,
    resultPath: '',
    summary: '',
    digest: '',
    error: '',
    acceptanceResults: [],
    findings: [],
    closed: [],
    round,
    sourceTaskId: sourceId,
    sourceFindingIds: [],
  }
  tasks.push(node)
  return node
}

/** Insert the repair node that closes a failed review's findings. */
export function insertRepair(tasks, reviewId, round) {
  const review = taskById(tasks, reviewId)
  const sourceId = review?.sourceTaskId ?? reviewId
  const id = `repair-${sourceId}-r${round}`
  if (tasks.some((task) => task.id === id)) return taskById(tasks, id)
  const source = taskById(tasks, sourceId)
  const findings = review?.findings ?? []
  const node = {
    id,
    title: `Repair ${source?.title ?? sourceId} (round ${round})`,
    brief: '',
    kind: 'repair',
    weight: 1,
    deps: [reviewId],
    scope: [...(source?.scope ?? [])],
    experts: [...(source?.experts ?? [])],
    contract: {
      objective: source?.contract?.objective ?? '',
      acceptance: [...(source?.contract?.acceptance ?? [])],
      verify: [...(source?.contract?.verify ?? [])],
      inScope: [...(source?.contract?.inScope ?? [])],
      outOfScope: [...(source?.contract?.outOfScope ?? [])],
    },
    review: false,
    auto: true,
    state: 'pending',
    attempt: 0,
    attemptId: '',
    sessionId: '',
    startedAt: 0,
    endedAt: 0,
    resultPath: '',
    summary: '',
    digest: '',
    error: '',
    acceptanceResults: [],
    findings: [],
    closed: [],
    round,
    sourceTaskId: sourceId,
    sourceFindingIds: findings.map((finding) => finding.id),
  }
  tasks.push(node)
  return node
}

export function stateSummary(tasks) {
  const total = tasks.length
  let completed = 0
  let failed = 0
  let running = 0
  let pending = 0
  for (const task of tasks) {
    if (task.state === 'completed') completed += 1
    else if (task.state === 'failed') failed += 1
    else if (task.state === 'running') running += 1
    else if (task.state === 'pending') pending += 1
  }
  return {
    total,
    settled: completed + failed + tasks.filter((task) => task.state === 'cancelled').length,
    completed,
    failed,
    running,
    pending,
    open: running + pending,
  }
}

/** 85% for the worker graph, the last 15% for integration (same dial as v1). */
export function progressPercent(tasks, integratorState) {
  const { total, settled } = stateSummary(tasks)
  const graph = total === 0 ? 0 : Math.round((settled / total) * 85)
  const tail = integratorState === 'settled' ? 15 : 0
  return Math.min(100, graph + tail)
}

export function graphSummary(tasks) {
  return tasks.map((task) => ({
    id: task.id,
    kind: task.kind,
    title: task.title,
    state: task.state,
    deps: [...(task.deps ?? [])],
    attempt: task.attempt,
    round: task.round,
    auto: task.auto === true,
    findings: Array.isArray(task.findings) ? task.findings.length : 0,
    error: task.error || '',
  }))
}

export { clampInt }

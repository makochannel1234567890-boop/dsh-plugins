/**
 * dsh-fanout — one append-only task queue per workspace, plus write-claim
 * admission control.
 *
 * Why this module exists
 * ----------------------
 * Fan-out used to be "start a run, get a batch". When the same parent kept
 * coming back with more work it started a *second* run, and the two runs
 * scheduled their workers independently. Two sessions were then told to write
 * the same file at the same time and stopped each other (observed as
 * `FS_STALE_VERSION` / cancelled turns / a build broken by a sibling's
 * half-written edit).
 *
 * The fix is structural, not procedural:
 *   - one queue per workspace (`findQueueRun`): new work is appended to the
 *     live run instead of creating a competing one;
 *   - every task declares the paths it writes (`scope` + `contract.inScope`);
 *   - the scheduler admits a ready task only when its claim set is disjoint
 *     from every claim already held by a running task, so two sessions are
 *     never told to write the same path at the same time. The loser stays
 *     `pending` and is admitted when the claim is released.
 *
 * Everything here is pure: no Host, no filesystem, no clock. The kernel owns
 * state; this module only decides.
 *
 * @module dsh-fanout/lib/queue
 */

import { MAX_TASKS, normalizeGraph, readyTasks, validateGraph } from './graph.js'

/** Statuses in which a run is the live queue for its workspace. */
export const QUEUE_STATUSES = Object.freeze(['staged', 'running', 'paused', 'integrating'])

/** Why a ready task was not admitted. */
export const DEFER_REASONS = Object.freeze({
  SCOPE: 'write-scope',
  LIMIT: 'concurrency-limit',
})

/**
 * Canonical form of one write claim.
 *
 * A claim is a workspace path prefix, not a glob: `src/render` covers
 * `src/render/TerrainMaterial.ts`. Separators are unified and segments folded to
 * lower case so a Windows checkout and a POSIX checkout compare the same way
 * (folding case can only serialise *more* work, never less, so it is the safe
 * direction on both).
 *
 * @param {unknown} raw
 * @returns {string} normalised prefix, or '' when the claim names nothing
 */
export function normalizeClaim(raw) {
  if (typeof raw !== 'string') return ''
  const text = raw.trim()
  if (text.length === 0) return ''
  const parts = []
  for (const segment of text.replace(/\\/g, '/').split('/')) {
    if (segment.length === 0 || segment === '.') continue
    if (segment === '..') {
      parts.pop()
      continue
    }
    parts.push(segment.toLowerCase())
  }
  return parts.join('/')
}

/**
 * The paths a task claims for writing: its summary `scope` plus the contract
 * `inScope`. Both are honoured because a caller may fill in either one.
 *
 * @param {object|undefined} task
 * @returns {string[]} sorted, de-duplicated claims
 */
export function claimsOf(task) {
  const out = new Set()
  for (const list of [task?.scope, task?.contract?.inScope]) {
    if (!Array.isArray(list)) continue
    for (const item of list) {
      const claim = normalizeClaim(item)
      if (claim.length > 0) out.add(claim)
    }
  }
  return [...out].sort()
}

/** True when two claims name the same path or one contains the other. */
export function claimsOverlap(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  if (left.length === 0 || right.length === 0) return false
  if (left === right) return true
  const long = left.length > right.length ? left : right
  const short = left.length > right.length ? right : left
  return long.startsWith(`${short}/`)
}

/**
 * First conflicting pair between two claim sets, with the evidence the parent
 * needs ("t7 wants src/render, t3 holds it").
 *
 * @returns {{ path: string, heldBy: string }|undefined}
 */
export function claimsConflict(claims, otherClaims) {
  for (const claim of claims ?? []) {
    for (const other of otherClaims ?? []) {
      if (!claimsOverlap(claim, other)) continue
      const path = claim.length >= other.length ? claim : other
      return { path, heldBy: other }
    }
  }
  return undefined
}

/**
 * Choose which ready tasks may start now.
 *
 * Greedy and deterministic: candidates arrive in scheduling priority order
 * (`readyTasks`), and each admitted task's claims are reserved for the next
 * candidate. A task whose claims collide with a running task or with an
 * already-admitted one is deferred with the path and the holder named.
 *
 * A task that declares no claim is admitted as before (`serializeUnclaimed`
 * turns that off): refusing to schedule undeclared work would serialise every
 * casual fan-out, and the old behaviour has to keep working. The queue view
 * reports such tasks as `unclaimed` so the parent can fix the brief instead.
 *
 * @param {object[]} candidates ready tasks, in priority order
 * @param {{ running?: object[], limit?: number, serializeUnclaimed?: boolean }} [options]
 * @returns {{ admitted: object[], deferred: Array<{ id: string, reason: string, blockedBy: string[], path: string }>, held: Array<{ id: string, claims: string[] }> }}
 */
export function admit(candidates, options = {}) {
  const limit = Number.isFinite(Number(options.limit)) ? Math.max(0, Math.trunc(Number(options.limit))) : Infinity
  const serializeUnclaimed = options.serializeUnclaimed === true
  const running = Array.isArray(options.running) ? options.running : []

  const held = [].concat(
    running.map((task) => ({ id: String(task?.id ?? ''), claims: claimsOf(task), state: 'running' })),
  )
  const reserved = held.filter((entry) => entry.id.length > 0 && (entry.claims.length > 0 || serializeUnclaimed))

  const admitted = []
  const deferred = []
  for (const candidate of candidates ?? []) {
    if (admitted.length >= limit) {
      deferred.push({ id: String(candidate?.id ?? ''), reason: DEFER_REASONS.LIMIT, blockedBy: [], path: '' })
      continue
    }
    const claims = claimsOf(candidate)
    const wildcard = claims.length === 0
    if (wildcard && !serializeUnclaimed) {
      admitted.push(candidate)
      continue
    }
    let clash
    for (const entry of reserved) {
      const hit = claimsConflict(claims, entry.claims)
      if (hit !== undefined) {
        clash = { entry, hit }
        break
      }
      // A task that declares nothing claims the whole workspace once
      // serialisation is on, so it excludes (and is excluded by) everything.
      if (serializeUnclaimed && (wildcard || entry.claims.length === 0)) {
        clash = { entry, hit: { path: '*', heldBy: entry.id } }
        break
      }
    }
    if (clash !== undefined) {
      deferred.push({
        id: String(candidate?.id ?? ''),
        reason: DEFER_REASONS.SCOPE,
        blockedBy: [clash.entry.id],
        path: clash.hit.path,
      })
      continue
    }
    admitted.push(candidate)
    reserved.push({ id: String(candidate?.id ?? ''), claims, state: 'pending' })
  }
  return { admitted, deferred, held }
}

function assignId(raw, taken) {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (/^[a-z][a-z0-9_-]{0,40}$/i.test(text) && !taken.has(text)) return text
  let index = 1
  while (taken.has(`t${index}`)) index += 1
  return `t${index}`
}

function normalizeGroup(raw) {
  const text = typeof raw === 'string' ? raw.trim() : ''
  return text.slice(0, 60)
}

/** Dependency entries as the graph stores them: numbers are 1-based indexes. */
function normalizeDepEntry(dep) {
  if (typeof dep === 'number' && Number.isFinite(dep)) return `t${Math.trunc(dep)}`
  if (typeof dep === 'string') {
    const text = dep.trim()
    if (text.length === 0) return ''
    return /^\d+$/.test(text) ? `t${text}` : text
  }
  return ''
}

/**
 * Append tasks to an existing queue.
 *
 * Atomic: any problem (bad contract, unknown dependency, cycle) returns the
 * original list untouched with `problems` filled in, so a rejected append can
 * never leave a half-added graph behind. New ids never collide with existing
 * ones, and `dependsOn` may name tasks that already exist in the queue — which
 * is what lets a parent append "3 more jobs that follow the work already
 * running".
 *
 * @param {object[]} existing current task list (not mutated)
 * @param {object[]} incoming caller-supplied tasks
 * @param {{ verifyDefault?: string[] }} [options]
 * @returns {{ tasks: object[], added: object[], problems: string[], warnings: string[] }}
 */
export function appendTasks(existing, incoming, options = {}) {
  const base = Array.isArray(existing) ? existing : []
  const problems = []
  const warnings = []
  const added = []
  if (!Array.isArray(incoming)) {
    return { tasks: base, added, problems: ['tasks must be an array'], warnings }
  }
  if (incoming.length === 0) {
    return { tasks: base, added, problems: ['tasks must be a non-empty array'], warnings }
  }
  if (base.length + incoming.length > MAX_TASKS) {
    return {
      tasks: base,
      added,
      problems: [`a queue is capped at ${MAX_TASKS} tasks (it already has ${base.length})`],
      warnings,
    }
  }

  const taken = new Set(base.map((task) => String(task?.id ?? '')))
  const staged = []
  for (const raw of incoming) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      problems.push('every task must be an object')
      continue
    }
    // Normalise one task on its own: its dependencies are resolved against the
    // merged id set afterwards, once every appended id is known.
    const single = normalizeGraph(
      [{ ...raw, dependsOn: undefined, deps: undefined, dependencies: undefined }],
      { verifyDefault: options.verifyDefault },
    )
    warnings.push(...single.warnings)
    if (single.problems.length > 0) {
      problems.push(...single.problems.map((problem) => `${String(raw.title ?? raw.name ?? 'task')}: ${problem}`))
      continue
    }
    const task = single.tasks[0]
    task.id = assignId(raw.id, taken)
    taken.add(task.id)
    task.group = normalizeGroup(raw.group)
    const adopt = raw.session_id ?? raw.adoptSessionId
    task.adoptSessionId = typeof adopt === 'string' ? adopt.trim() : ''
    const rawDeps = raw.dependsOn ?? raw.deps ?? raw.dependencies
    staged.push({ task, rawDeps })
  }
  if (problems.length > 0) return { tasks: base, added, problems, warnings }

  const merged = [...base, ...staged.map((entry) => entry.task)]
  const knownIds = new Set(merged.map((task) => String(task?.id ?? '')))
  for (const { task, rawDeps } of staged) {
    const deps = []
    if (rawDeps !== undefined && rawDeps !== null) {
      if (!Array.isArray(rawDeps)) {
        problems.push(`${task.id}: dependsOn must be an array`)
        continue
      }
      for (const dep of rawDeps) {
        const id = normalizeDepEntry(dep)
        if (id.length === 0) {
          problems.push(`${task.id}: dependency entries must be ids or 1-based numbers`)
          continue
        }
        if (!knownIds.has(id)) problems.push(`${task.id}: unknown dependency "${id}"`)
        else if (id === task.id) problems.push(`${task.id}: a task cannot depend on itself`)
        else deps.push(id)
      }
    }
    task.deps = [...new Set(deps)]
    added.push(task)
  }
  if (problems.length > 0) return { tasks: base, added: [], problems, warnings }

  const check = validateGraph(merged)
  if (check.problems.length > 0) return { tasks: base, added: [], problems: check.problems, warnings }
  return { tasks: merged, added, problems: [], warnings }
}

/**
 * The queue as the orchestrating parent sees it: what is running, what may
 * start, what is waiting for a file, and which tasks never said what they
 * write.
 */
export function queueView(tasks, options = {}) {
  const list = Array.isArray(tasks) ? tasks : []
  const running = list.filter((task) => task?.state === 'running')
  const pending = list.filter((task) => task?.state === 'pending')
  const candidates = readyTasks(list)
  const plan = admit(candidates, { running, limit: candidates.length, serializeUnclaimed: options.serializeUnclaimed })
  const blocked = plan.deferred.filter((entry) => entry.reason === DEFER_REASONS.SCOPE)
  const groups = new Map()
  for (const task of list) {
    const key = typeof task?.group === 'string' && task.group.length > 0 ? task.group : 'ungrouped'
    groups.set(key, (groups.get(key) ?? 0) + 1)
  }
  const unclaimed = list
    .filter((task) => (task?.state === 'running' || task?.state === 'pending') && claimsOf(task).length === 0)
    .map((task) => String(task.id))
  return {
    total: list.length,
    running: running.map((task) => String(task.id)),
    pending: pending.map((task) => String(task.id)),
    ready: plan.admitted.map((task) => String(task.id)),
    scope_blocked: blocked.map((entry) => ({ id: entry.id, blocked_by: entry.blockedBy, path: entry.path })),
    unclaimed,
    groups: Object.fromEntries(groups),
    hint:
      blocked.length > 0
        ? 'A ready task is waiting on a file another task holds. Either wait for that task to settle, or narrow the waiting task\'s scope to the paths it really writes.'
        : unclaimed.length > 0
          ? 'Some tasks declare no write scope, so two of them can still collide. Add scope/inScope to those tasks.'
          : '',
  }
}

/**
 * The single live queue for a workspace.
 *
 * A second active run in the same directory is exactly what made two workers
 * fight over one file, so callers append here instead of starting a new run.
 *
 * @param {Iterable<object>|undefined} runs
 * @param {string} cwd
 * @returns {object|undefined} newest active run rooted at `cwd`
 */
export function findQueueRun(runs, cwd) {
  const target = normalizeClaim(String(cwd ?? ''))
  if (target.length === 0) return undefined
  let best
  for (const run of runs ?? []) {
    if (run === null || typeof run !== 'object') continue
    if (!QUEUE_STATUSES.includes(run.status)) continue
    if (normalizeClaim(String(run.cwd ?? '')) !== target) continue
    if (best === undefined || Number(run.createdAt ?? 0) > Number(best.createdAt ?? 0)) best = run
  }
  return best
}

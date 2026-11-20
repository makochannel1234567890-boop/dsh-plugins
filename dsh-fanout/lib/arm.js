/**
 * Fan-out fit assessment and automatic budget decision.
 *
 * The composer checkbox arms fan-out for the *next* prompt, but the plugin is for
 * wide-and-deep jobs only. Two questions have to be answered before anything is
 * spawned, and both must be answerable without a model:
 *
 *   1. Would fan-out lose? (a two-step request, or a pure chain of dependent
 *      steps, pays the per-session fixed cost and the reviewer round for nothing)
 *   2. How many branch sessions and how much thought expansion does this job
 *      actually need? The parent session decides, but the *floor* must never be
 *      the cheap default: a request that needs 6 branches does not get 4 because
 *      4 was the configured default.
 *
 * Everything here is side-effect free so the rules stay testable without a
 * Harness, and so the model-facing refusal and the UI can share one verdict.
 *
 * @module dsh-fanout/lib/arm
 */

import { clampInt } from './plan.js'

/** Fewer than this is not a graph, it is one job with extra steps. */
export const MIN_FANOUT_TASKS = 3

/** Below this much total instruction text, the per-session fixed cost dominates. */
export const MIN_FANOUT_CHARS = 600

/** Ask for one slot more than the widest layer so a freed slot is never idle. */
export const AUTO_MARGIN_WORKERS = 1

/** Expansion floor plus the deliberate headroom the parent is asked to add. */
export const AUTO_EXPANSION_BASE = 60
export const AUTO_EXPANSION_PER_LEVEL = 8
export const AUTO_MARGIN_EXPANSION = 15

function asTasks(input) {
  return Array.isArray(input) ? input.filter((task) => task !== null && typeof task === 'object') : []
}

function depsOf(task, indexById) {
  const raw = Array.isArray(task?.deps) ? task.deps : []
  const kept = []
  for (const dep of raw) {
    if (typeof dep === 'string' && indexById.has(dep)) kept.push(dep)
  }
  return kept
}

/**
 * Longest-path levelisation. `level` is 0 for a task with no dependencies, so
 * `depth` is (max level + 1) and `width` is the largest single layer — the two
 * numbers that decide whether fan-out can actually run anything in parallel.
 *
 * Cycles cannot appear here (the graph is validated first) but a stray cycle
 * must not hang the scheduler, so every node is visited once.
 *
 * @param {object[]} tasks normalised graph nodes
 * @returns {{ levels: Map<string, number>, width: number, depth: number, count: number }}
 */
export function levelize(tasks) {
  const list = asTasks(tasks)
  const byId = new Map()
  list.forEach((task, index) => {
    const id = typeof task.id === 'string' && task.id.length > 0 ? task.id : `t${index + 1}`
    byId.set(id, { task, index })
  })
  const levels = new Map()
  const visiting = new Set()

  const levelOf = (id) => {
    if (levels.has(id)) return levels.get(id)
    if (visiting.has(id)) return 0
    const entry = byId.get(id)
    if (entry === undefined) return 0
    visiting.add(id)
    let level = 0
    for (const dep of depsOf(entry.task, byId)) {
      const candidate = levelOf(dep) + 1
      if (candidate > level) level = candidate
    }
    visiting.delete(id)
    levels.set(id, level)
    return level
  }

  for (const id of byId.keys()) levelOf(id)

  const perLevel = new Map()
  for (const [id, level] of levels) {
    perLevel.set(level, (perLevel.get(level) ?? 0) + 1)
  }
  let width = 0
  let depth = 0
  for (const [level, count] of perLevel) {
    if (count > width) width = count
    if (level + 1 > depth) depth = level + 1
  }
  return { levels, width, depth, count: levels.size }
}

/**
 * Decide whether a task graph is a fan-out job at all.
 *
 * The refusals are the conditions measured earlier to lose outright:
 * too few jobs, a pure chain (no layer ever runs twice in parallel), and jobs so
 * small that the shared prefix plus the reviewer round costs more than the work.
 *
 * @param {object[]} tasks normalised graph nodes
 * @returns {{
 *   verdict: 'fanout' | 'single',
 *   reasons: string[],
 *   metrics: { count: number, width: number, depth: number,
 *              parallelism: number, briefChars: number }
 * }}
 */
export function graphFit(tasks) {
  const list = asTasks(tasks)
  const { width, depth, count } = levelize(list)
  let briefChars = 0
  for (const task of list) {
    if (typeof task.brief === 'string') briefChars += task.brief.length
    else if (typeof task.title === 'string') briefChars += task.title.length
  }
  const parallelism = count === 0 ? 0 : Number((width / count).toFixed(3))
  const metrics = { count, width, depth, parallelism, briefChars }

  const reasons = []
  if (count < MIN_FANOUT_TASKS) {
    reasons.push(`only ${count} task(s); fan-out needs at least ${MIN_FANOUT_TASKS} independent jobs`)
  }
  if (count >= 2 && width <= 1) {
    reasons.push(
      `every task depends on the previous one (${count} steps in a single chain, depth ${depth}); ` +
        'a chain runs in one session and the reviewer round buys nothing',
    )
  }
  if (count >= MIN_FANOUT_TASKS && briefChars > 0 && briefChars < MIN_FANOUT_CHARS) {
    reasons.push(
      `the briefs total ${briefChars} characters, under the ${MIN_FANOUT_CHARS} floor; ` +
        'the per-session fixed cost would exceed the work',
    )
  }
  return { verdict: reasons.length === 0 ? 'fanout' : 'single', reasons, metrics }
}

const BREADTH_MARKERS = [
  /\b(each|every|respectively|independently|in parallel|across all)\b/i,
  /(それぞれ|各々|各|並列|同時に|独立して|すべての)/,
  /(?:^|\n)\s*(?:[-*•]|\d+[.)])\s+/,
]

/**
 * A cheap, text-only breadth hint used for the composer's early warning.
 *
 * This is deliberately *not* the gate: the authoritative verdict comes from the
 * task graph, because a prompt cannot say how the work will actually decompose.
 * It only lets the panel tell the user "this looks like a single job" before the
 * turn starts, without pretending to be a classifier.
 *
 * @param {string} objective draft text
 * @returns {{ chars: number, bullets: number, markers: number,
 *             hint: 'narrow' | 'wide' | 'unsure' }}
 */
export function objectiveFit(objective) {
  const text = typeof objective === 'string' ? objective : ''
  const chars = text.trim().length
  const bullets = (text.match(/(?:^|\n)\s*(?:[-*•]|\d+[.)])\s+/g) ?? []).length
  let markers = 0
  for (const pattern of BREADTH_MARKERS) {
    if (pattern.test(text)) markers += 1
  }
  let hint = 'unsure'
  if (chars > 0) {
    if (chars < 200 && bullets === 0 && markers === 0) hint = 'narrow'
    else if (bullets >= 3 || (markers >= 2 && chars >= 400)) hint = 'wide'
  }
  return { chars, bullets, markers, hint }
}

/**
 * Decide the two dials for this run.
 *
 * `manual` honours what the user set. `auto` is the parent session's default and
 * is intentionally generous: the widest layer plus one spare slot, and a thought
 * expansion floor that climbs with how deep the graph is, plus headroom on top.
 * The earlier measurement was that the dials were skipped or left at a cheap
 * default, which silently removed the capability the plugin exists for.
 *
 * @param {{
 *   tasks?: object[],
 *   mode?: 'auto' | 'manual',
 *   workers?: number,
 *   expansion?: number,
 *   maxWorkers?: number,
 *   maxExpansion?: number,
 * }} input
 * @returns {{ workers: number, expansion: number, source: 'auto' | 'manual', note: string }}
 */
export function decideBudget(input = {}) {
  const maxWorkers = clampInt(input.maxWorkers, 8, 1, 16)
  const maxExpansion = clampInt(input.maxExpansion, 100, 0, 100)
  const mode = input.mode === 'manual' ? 'manual' : 'auto'

  if (mode === 'manual') {
    return {
      workers: Math.min(maxWorkers, clampInt(input.workers, 4, 1, 16)),
      expansion: Math.min(maxExpansion, clampInt(input.expansion, 40, 0, 100)),
      source: 'manual',
      note: 'manual dials from the composer panel',
    }
  }

  const { width, depth, count } = levelize(input.tasks)
  const need = Math.max(1, width > 0 ? width : count > 0 ? 1 : 1)
  const workers = Math.min(maxWorkers, clampInt(need + AUTO_MARGIN_WORKERS, 5, 1, 16))
  const expansion = Math.min(
    maxExpansion,
    clampInt(
      AUTO_EXPANSION_BASE + AUTO_EXPANSION_PER_LEVEL * Math.max(0, depth - 1) + AUTO_MARGIN_EXPANSION,
      AUTO_EXPANSION_BASE + AUTO_MARGIN_EXPANSION,
      0,
      100,
    ),
  )
  return {
    workers,
    expansion,
    source: 'auto',
    note:
      `auto: widest layer ${width || 1} + ${AUTO_MARGIN_WORKERS} spare slot, ` +
      `driven by depth ${depth || 1} + ${AUTO_MARGIN_EXPANSION} headroom`,
  }
}

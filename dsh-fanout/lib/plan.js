/**
 * Pure planning helpers for dsh-fanout.
 *
 * Kept free of Cordis/Node-IO so the packing, budget and expansion rules can be
 * unit tested without a running Harness.
 *
 * @module dsh-fanout/lib/plan
 */

export const MAX_TASKS = 24
export const SLIDER_MAX = 100

function clampNumber(value, fallback, min, max) {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback
  return Math.min(max, Math.max(min, n))
}

export function clampInt(value, fallback, min, max) {
  return Math.floor(clampNumber(value, fallback, min, max))
}

export function truncate(value, max) {
  const text = String(value ?? '')
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`
}

/**
 * Validate and normalise the caller-supplied task list.
 * Blank tasks are dropped; ids are stable (`t1`, `t2`, ...) and weights are bounded.
 */
export function normalizeTasks(input, options = {}) {
  const maxBrief = clampInt(options.maxBrief, 4000, 200, 12000)
  if (!Array.isArray(input)) return []
  const tasks = []
  for (const raw of input) {
    if (raw === null || typeof raw !== 'object') continue
    const title = String(raw.title ?? raw.name ?? '').trim()
    const brief = String(raw.brief ?? raw.description ?? raw.instructions ?? '').trim()
    if (title.length === 0 && brief.length === 0) continue
    const weight = Number(clampNumber(raw.weight, 1, 0.25, 8).toFixed(2))
    const scope = Array.isArray(raw.scope)
      ? raw.scope
          .filter((item) => typeof item === 'string' && item.trim().length > 0)
          .map((item) => item.trim())
          .slice(0, 12)
      : []
    tasks.push({
      id: `t${tasks.length + 1}`,
      title: truncate(title.length > 0 ? title : brief.slice(0, 80), 160),
      brief: truncate(brief, maxBrief),
      weight,
      scope,
    })
    if (tasks.length >= MAX_TASKS) break
  }
  return tasks
}

/**
 * Weight-balanced assignment of tasks to workers (longest-processing-time first).
 *
 * Asymmetric task lists are the point: the heaviest job is placed first onto the
 * least-loaded worker, so a "big + 3 tiny" batch does not collapse into one
 * worker holding everything while three sit idle.
 *
 * @returns {{ index: number, taskIds: string[], weight: number }[]}
 */
export function packTasks(tasks, workerCount) {
  const workers = clampInt(workerCount, 1, 1, Math.max(1, tasks.length || 1))
  const buckets = Array.from({ length: workers }, (_, index) => ({
    index,
    taskIds: [],
    weight: 0,
  }))
  const ordered = [...tasks].sort((a, b) => b.weight - a.weight)
  for (const task of ordered) {
    let target = buckets[0]
    for (const bucket of buckets) {
      if (bucket.weight < target.weight) target = bucket
    }
    target.taskIds.push(task.id)
    target.weight = Number((target.weight + task.weight).toFixed(2))
  }
  // Keep only workers that received work, preserving index order.
  return buckets.filter((bucket) => bucket.taskIds.length > 0)
}

/**
 * Map the "思考拡張" slider (0–100) to a concrete probe plan.
 *
 * 0 disables probing. Higher values widen the number of orthogonal axes and,
 * from 61 upward, force the classification gate before the caller may proceed.
 */
export function expansionPlan(value) {
  const slider = clampInt(value, 40, 0, SLIDER_MAX)
  if (slider <= 0) {
    return { slider, level: 0, axes: 0, classify: false, label: 'オフ' }
  }
  if (slider <= 30) {
    return { slider, level: 1, axes: 1, classify: false, label: '浅く1軸' }
  }
  if (slider <= 60) {
    return { slider, level: 2, axes: 3, classify: false, label: '3軸' }
  }
  if (slider <= 85) {
    return { slider, level: 3, axes: 5, classify: true, label: '5軸+分類ゲート' }
  }
  return { slider, level: 4, axes: 8, classify: true, label: '8軸+分類ゲート' }
}

/**
 * Map a 1–5 explicit intensity onto the same plan shape the slider produces.
 *
 * Axis counts widen strictly (1, 2, 3, 5, 8) so the tool's documented
 * "1–5 → 1/2/3/5/8 axes" is literally true, while every other field keeps the
 * slider's own thresholds (`classify` turns on with the 5-axis tier).
 */
export function intensityPlan(intensity) {
  const level = clampInt(intensity, 3, 1, 5)
  const sliderSteps = [15, 30, 50, 75, 100]
  const axisCounts = [1, 2, 3, 5, 8]
  const plan = expansionPlan(sliderSteps[level - 1])
  return { ...plan, axes: axisCounts[level - 1], classify: plan.level >= 3 }
}

/**
 * Rough token estimate for one run. Deliberately conservative and *not* a promise:
 * it exists so the sliders show a cost trend instead of a mystery.
 */
export function estimateBudget({ tasks, workers, expansion }) {
  const taskCount = Array.isArray(tasks) ? tasks.length : 0
  const briefChars = (Array.isArray(tasks) ? tasks : []).reduce(
    (sum, task) => sum + String(task.brief ?? '').length,
    0,
  )
  const plan = expansionPlan(expansion)
  const workerTokens = clampInt(workers, 1, 1, 24) * (1200 + Math.round(briefChars / 3))
  const taskTokens = taskCount * 500
  const probeTokens = plan.axes * 900
  const integrateTokens = 5200
  return {
    workers: clampInt(workers, 1, 1, 24),
    tasks: taskCount,
    probeAxes: plan.axes,
    approx_tokens: workerTokens + taskTokens + probeTokens + integrateTokens,
  }
}

/**
 * Stable, filesystem-safe run id. Timestamp prefix keeps runs sortable and the
 * suffix makes collisions across quick successive runs unlikely.
 */
export function makeRunId(prefix, now = Date.now(), random = Math.random) {
  const stamp = new Date(now).toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
  const suffix = random().toString(36).slice(2, 6).padEnd(4, '0')
  return `${prefix}-${stamp}-${suffix}`
}

/** True when every task id appears exactly once in the packed worker buckets. */
export function packingCovers(tasks, buckets) {
  const expected = tasks.map((task) => task.id).sort()
  const actual = buckets.flatMap((bucket) => bucket.taskIds).sort()
  return expected.length === actual.length && expected.every((id, index) => id === actual[index])
}

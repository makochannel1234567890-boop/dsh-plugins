/**
 * Pure crash classification for dsh-crash-recovery.
 *
 * The journal is written while the process is alive and re-written as `clean`
 * by every graceful path (plugin unload, process exit). A restart that finds
 * `clean: false` therefore means the previous process disappeared without
 * running any of them: a kill, a fatal error, or a native crash.
 *
 * No I/O here on purpose — the decision is the part that must be provable.
 *
 * @module dsh-crash-recovery/lib/detect
 */

/** Missing/garbage journal: nothing to decide. */
export const KIND_NONE = 'none'
/** Previous boot exited through a graceful path. */
export const KIND_CLEAN = 'clean'
/** Previous boot never recorded a shutdown: unexpected termination. */
export const KIND_CRASH = 'crash'
/** Journal belongs to another DSH profile; never act across profiles. */
export const KIND_FOREIGN_PROFILE = 'foreign-profile'
/** Journal is older than the configured horizon: report it, do not act. */
export const KIND_STALE = 'stale'

const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

function idList(value) {
  if (!Array.isArray(value)) return []
  const seen = new Set()
  const out = []
  for (const item of value) {
    const id = typeof item === 'string' ? item : typeof item?.sessionId === 'string' ? item.sessionId : ''
    if (id.length === 0 || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

/**
 * Decide what the previous process left behind.
 *
 * @param {unknown} previous parsed `live.json`, or undefined when absent
 * @param {{ now?: number, profile?: string, maxAgeMs?: number }} [options]
 * @returns {{
 *   kind: string,
 *   reason: string,
 *   ageMs?: number,
 *   crashId?: string,
 *   risky?: string[],
 *   running?: string[],
 *   runs?: string[],
 *   supervised?: boolean,
 * }}
 */
export function classifyBoot(previous, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  const maxAgeMs = Number.isFinite(options.maxAgeMs) ? options.maxAgeMs : DEFAULT_MAX_AGE_MS

  if (previous === undefined || previous === null) return { kind: KIND_NONE, reason: 'no journal' }
  if (typeof previous !== 'object') return { kind: KIND_NONE, reason: 'journal is not an object' }
  if (typeof previous.bootId !== 'string' || previous.bootId.length === 0) {
    return { kind: KIND_NONE, reason: 'journal has no bootId' }
  }

  const wantedProfile = typeof options.profile === 'string' && options.profile.length > 0 ? options.profile : undefined
  const recordedProfile =
    typeof previous.profile === 'string' && previous.profile.length > 0 ? previous.profile : undefined
  if (wantedProfile !== undefined && recordedProfile !== undefined && wantedProfile !== recordedProfile) {
    return { kind: KIND_FOREIGN_PROFILE, reason: `journal belongs to profile ${recordedProfile}` }
  }

  if (previous.clean === true) {
    const why = typeof previous.exitReason === 'string' && previous.exitReason.length > 0 ? previous.exitReason : 'unknown'
    return { kind: KIND_CLEAN, reason: `previous boot exited cleanly (${why})` }
  }

  const heartbeatAt = Number(previous.heartbeatAt)
  const ageMs = Number.isFinite(heartbeatAt) && heartbeatAt > 0 ? Math.max(0, now - heartbeatAt) : 0
  if (maxAgeMs > 0 && ageMs > maxAgeMs) {
    return {
      kind: KIND_STALE,
      reason: `journal heartbeat is ${Math.round(ageMs / 3_600_000)}h old`,
      ageMs,
    }
  }

  const risky = idList(previous.riskySessions)
  const running = idList(previous.runningSessions)
  const runs = idList(previous.fanoutRuns)
  return {
    kind: KIND_CRASH,
    reason: 'no clean shutdown was recorded',
    ageMs,
    crashId: `${previous.bootId}@${Number.isFinite(heartbeatAt) ? heartbeatAt : 0}`,
    risky,
    running,
    runs,
    // 監督セッションを立てるのは「危険ツールを撃った/実行中だった」ときだけ。
    // 何も動いていなかったクラッシュに空のセッションを増やさない。
    supervised: risky.length > 0 || running.length > 0 || runs.length > 0,
  }
}

/**
 * A crash re-detected within `repeatMs` for the same boot is the same incident.
 *
 * @param {string} a
 * @param {string} b
 */
export function sameCrash(a, b) {
  return typeof a === 'string' && a.length > 0 && a === b
}

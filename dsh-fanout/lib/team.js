/**
 * Agent-team face of the fan-out panel.
 *
 * The panel owns the only Team switch and the only shared-task board; the
 * bundled `agent-team` UI row is disabled so one surface, not two, describes the
 * same state. This module is the Host adapter between that panel and the
 * `agents` / `agentTeams` services, reached lazily: fan-out itself only hard-
 * depends on `tools`, and every other service may be absent.
 *
 * Contract:
 *   - `read(sessionId)` is synchronous and never throws; a missing service, a
 *     stale session id, or a listener fault becomes `{ ok: false, error }`.
 *   - `setEnabled(sessionId, enabled)` awaits persistence and reports the value
 *     the service actually holds afterwards.
 *   - Task views are copied and bounded: the panel is a monitor, not an editor.
 *
 * @module dsh-fanout/lib/team
 */

/** Most tasks one board read returns; the panel is a monitor, not a log. */
export const MAX_TASKS = 200

/** Longest subject or owner name kept from one task view. */
const MAX_LABEL = 200

function asString(value) {
  return typeof value === 'string' ? value : ''
}

function clipped(value) {
  const text = asString(value)
  return text.length > MAX_LABEL ? `${text.slice(0, MAX_LABEL - 1)}…` : text
}

/** One task view, reduced to what the board renders; unknown fields are dropped. */
export function taskSummary(view) {
  if (view === null || typeof view !== 'object') return null
  const blocked = Array.isArray(view.blockedBy) ? view.blockedBy.length : 0
  return {
    id: asString(view.id),
    subject: clipped(view.subject),
    status: asString(view.status) || 'pending',
    owner: clipped(view.ownerName),
    ownerId: asString(view.ownerId),
    ready: view.ready === true,
    blocked: blocked,
  }
}

/**
 * Build the Team face exposed over the bridge.
 *
 * @param ctx - Host Context; services are resolved per call so a late mount works.
 * @param log - Diagnostic sink used for listener faults.
 */
export function createTeamFace(ctx, log) {
  const serviceOf = () => (typeof ctx.get === 'function' ? ctx.get('agentTeams') : undefined)
  const registryOf = () => (typeof ctx.get === 'function' ? ctx.get('agents') : undefined)

  /** Resolve the live Agent for a Session id, or report why it is unavailable. */
  function resolve(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      return { ok: false, error: 'session-id-required' }
    }
    const registry = registryOf()
    if (registry === undefined || typeof registry.get !== 'function') {
      return { ok: false, error: 'agents-unavailable' }
    }
    const agent = registry.get(sessionId)
    if (agent === undefined) return { ok: false, error: 'no-live-agent' }
    return { ok: true, agent }
  }

  return {
    /**
     * Read the Team selection and the shared task board for one Session.
     *
     * @param sessionId - Root conversation whose tree shares the board.
     * @returns `{ ok: true, enabled, tasks }`, or `{ ok: false, error }`.
     */
    read(sessionId) {
      const resolved = resolve(sessionId)
      if (!resolved.ok) return resolved
      const service = serviceOf()
      if (service === undefined) return { ok: false, error: 'team-unavailable' }
      try {
        const enabled = service.isEnabled(resolved.agent) === true
        const raw = service.listTasks(resolved.agent)
        const tasks = (Array.isArray(raw) ? raw : [])
          .slice(0, MAX_TASKS)
          .map(taskSummary)
          .filter(task => task !== null)
        return { ok: true, enabled, tasks }
      } catch (error) {
        log(`team read failed: ${String(error)}`)
        return { ok: false, error: 'team-read-failed' }
      }
    },

    /**
     * Save one Session tree's Team selection.
     *
     * @param sessionId - Root conversation whose tree receives the selection.
     * @param enabled - Whether Team tools and guidance are on.
     * @returns `{ ok: true, enabled }`, or `{ ok: false, error }`.
     */
    async setEnabled(sessionId, enabled) {
      const resolved = resolve(sessionId)
      if (!resolved.ok) return resolved
      const service = serviceOf()
      if (service === undefined) return { ok: false, error: 'team-unavailable' }
      const next = enabled === true
      try {
        await service.setEnabled(resolved.agent, next)
        return { ok: true, enabled: next }
      } catch (error) {
        log(`team setEnabled failed: ${String(error)}`)
        return { ok: false, error: 'team-write-failed' }
      }
    },
  }
}

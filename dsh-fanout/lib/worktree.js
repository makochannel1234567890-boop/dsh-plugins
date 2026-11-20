/**
 * Worktree face of the fan-out panel.
 *
 * The panel owns the only worktree control; the bundled forge row that used to
 * draw one is disabled, and this face reaches `ctx.worktrees` inside the
 * isolated realm fan-out mounts. Keeping the creation here means one owner for
 * "move this session into a checkout", and no second UI that could disagree
 * about the base.
 *
 * Contract:
 *   - `status(sessionId)` reports whether the service is mounted at all; a
 *     missing service is `available: false`, never an invented branch name.
 *   - `create(sessionId, from)` awaits the service, which creates the branch,
 *     checks the files out, and enters the checkout in one operation.
 *   - Every failure is returned as `{ ok: false, error }` with the service's own
 *     message: a missing branch or an occupied path must stay readable.
 *
 * @module dsh-fanout/lib/worktree
 */

const MAX_BASE_REF = 200

function asString(value) {
  return typeof value === 'string' ? value : ''
}

/** One created checkout, reduced to the fields the panel shows. */
export function checkoutSummary(record) {
  if (record === null || typeof record !== 'object') return null
  return {
    branch: asString(record.branch),
    path: asString(record.path),
    baseCommit: asString(record.baseCommit),
    repositoryRoot: asString(record.repositoryRoot),
  }
}

/**
 * Build the worktree face exposed over the bridge.
 *
 * @param ctx - Host Context; `worktrees` and `agents` resolve per call.
 * @param log - Diagnostic sink used for service faults.
 */
export function createWorktreeFace(ctx, log) {
  const serviceOf = () => (typeof ctx.get === 'function' ? ctx.get('worktrees') : undefined)
  const registryOf = () => (typeof ctx.get === 'function' ? ctx.get('agents') : undefined)

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
     * Report whether this composition can create checkouts at all.
     *
     * @returns `{ ok: true, available }`; the panel disables its control when
     * the service is absent instead of offering a button that cannot work.
     */
    status() {
      return { ok: true, available: serviceOf() !== undefined }
    },

    /**
     * Create a new branch and checkout from a local ref, and enter it.
     *
     * @param sessionId - Live Session whose directory changes.
     * @param from - Local branch, tag, or commit; empty means HEAD.
     * @returns `{ ok: true, branch, path, baseCommit, repositoryRoot }` or an error.
     */
    async create(sessionId, from) {
      const resolved = resolve(sessionId)
      if (!resolved.ok) return resolved
      const service = serviceOf()
      if (service === undefined || typeof service.create !== 'function') {
        return { ok: false, error: 'worktree-unavailable' }
      }
      const requested = asString(from).trim().slice(0, MAX_BASE_REF)
      try {
        const record = await service.create(resolved.agent, requested.length > 0 ? { from: requested } : {})
        const summary = checkoutSummary(record)
        if (summary === null) return { ok: false, error: 'worktree-empty-result' }
        return Object.assign({ ok: true }, summary)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        log(`worktree create failed: ${message}`)
        return { ok: false, error: message.length > 0 ? message : 'worktree-create-failed' }
      }
    },
  }
}

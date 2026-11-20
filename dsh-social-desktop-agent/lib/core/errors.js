/**
 * Shared policy error type for dsh-social-desktop-agent.
 *
 * Every denial raised by lib/core/policy.js is a PolicyError: a normal Error
 * with a stable machine-readable `code` (see POLICY_CODES) plus the action
 * coordinates (`scope`, `kind`, `target`). Callers — the browser layer, the
 * desktop layer, tools — branch on the code and never on the message text.
 *
 * @module dsh-social-desktop-agent/lib/core/errors
 */

/** The only denial codes this plugin may emit. */
export const POLICY_CODES = Object.freeze({
  SCOPE_DENIED: 'SCOPE_DENIED',
  TARGET_DENIED: 'TARGET_DENIED',
  RATE_LIMITED: 'RATE_LIMITED',
  CONFIRM_REQUIRED: 'CONFIRM_REQUIRED',
  KILL_SWITCH: 'KILL_SWITCH',
})

const CODE_SET = new Set(Object.values(POLICY_CODES))

export class PolicyError extends Error {
  /**
   * @param {string} code one of POLICY_CODES
   * @param {string} [message] human readable explanation
   * @param {{ scope?: string|null, kind?: string|null, target?: unknown }} [extra]
   */
  constructor(code, message, extra = {}) {
    super(typeof message === 'string' && message.trim().length > 0 ? message : String(code ?? 'policy denied'))
    this.name = 'PolicyError'
    this.code = String(code ?? '')
    this.scope = extra && typeof extra === 'object' ? extra.scope ?? null : null
    this.target = extra && typeof extra === 'object' ? extra.target ?? null : null
    this.kind = extra && typeof extra === 'object' ? extra.kind ?? null : null
    this.details = extra && typeof extra === 'object' && !Array.isArray(extra) ? { ...extra } : {}
    if (Error.captureStackTrace) Error.captureStackTrace(this, PolicyError)
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      scope: this.scope,
      kind: this.kind,
      target: this.target,
    }
  }
}

/** True for a real PolicyError, or for a look-alike thrown across a realm. */
export function isPolicyError(error) {
  return (
    error instanceof PolicyError ||
    (!!error && error.name === 'PolicyError' && typeof error.code === 'string' && CODE_SET.has(error.code))
  )
}

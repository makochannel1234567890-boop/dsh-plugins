/**
 * Global kill switch: one environment variable or one file stops everything.
 *
 * Tripped when either condition holds:
 *   - `DSH_KILL_SWITCH=1`
 *   - the configured kill-switch file exists (`DSH_KILL_SWITCH_FILE` supplies
 *     the default path; the plugin config overrides it)
 *
 * Every call re-reads the environment / filesystem, so dropping the file in
 * place stops the running plugin on the very next action. There is deliberately
 * no way to disable the switch through policy options: an unreadable state is
 * treated as "not tripped" only for the file probe, while an exception while
 * evaluating a custom switch is handled by the policy as tripped.
 *
 * @module dsh-social-desktop-agent/lib/core/killswitch
 */

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

export const KILL_SWITCH_ENV = 'DSH_KILL_SWITCH'
export const KILL_SWITCH_FILE_ENV = 'DSH_KILL_SWITCH_FILE'

function readEnv(env, key) {
  try {
    const value = env?.[key]
    return typeof value === 'string' ? value : undefined
  } catch {
    return undefined
  }
}

/** Resolve the kill-switch file: explicit option first, then the environment. */
export function resolveKillSwitchFile({ file, env = process.env } = {}) {
  const explicit = typeof file === 'string' ? file.trim() : ''
  if (explicit.length > 0) return resolve(explicit)
  const fromEnv = readEnv(env, KILL_SWITCH_FILE_ENV)
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return resolve(fromEnv.trim())
  return null
}

/**
 * @param {{ file?: string|null, env?: Record<string,string|undefined>, exists?: (path: string) => boolean }} [options]
 * @returns {{ file: string|null, trip(): boolean, active(): boolean, reason(): string|null, snapshot(): object }}
 */
export function createKillSwitch({ file = null, env = process.env, exists = existsSync } = {}) {
  const path = resolveKillSwitchFile({ file, env })

  function evaluate() {
    const flag = readEnv(env, KILL_SWITCH_ENV)
    if (typeof flag === 'string' && flag.trim() === '1') {
      return { source: 'env', detail: `${KILL_SWITCH_ENV}=1` }
    }
    if (path) {
      try {
        if (exists(path)) return { source: 'file', detail: path }
      } catch {
        // An unreadable probe cannot prove the switch is absent; fail closed.
        return { source: 'file', detail: `${path} (unreadable)` }
      }
    }
    return null
  }

  return {
    file: path,
    trip() {
      return evaluate() !== null
    },
    active() {
      return evaluate() !== null
    },
    reason() {
      const state = evaluate()
      return state ? state.detail : null
    },
    snapshot() {
      const state = evaluate()
      return {
        active: state !== null,
        source: state ? state.source : null,
        detail: state ? state.detail : null,
        file: path,
      }
    },
  }
}

/** Convenience one-shot check (mainly for tests and status text). */
export function isKillSwitchActive(options = {}) {
  return createKillSwitch(options).trip()
}

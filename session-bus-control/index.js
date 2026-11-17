/**
 * dsh-session-bus-control — one-shot host-side sweep used together with
 * dsh-session-bus.
 *
 * Why this exists: the coordination tool in the main plugin can time out when
 * the host is saturated by the very sessions it is asked to stop. This bundle
 * does the same work inside the plugin apply hook, where no tool-dispatch
 * timeout applies:
 *
 *   1. list the visible sessions,
 *   2. cancel every RUNNING session that is not excluded and not a subagent,
 *   3. wait `resumeDelayMs`,
 *   4. send a resume prompt to exactly the sessions cancelled in step 2.
 *
 * It is intentionally one-shot: a marker file makes a re-apply a no-op, so a
 * profile config reload cannot stop the user's sessions again by accident.
 *
 * @module dsh-session-bus-control
 */

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'

export const name = 'session-bus-control'

const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  resumeDelayMs: 60000,
  excludeSessionIds: [],
  resumePrompt:
    '（dsh-session-bus）一斉停止が解除されました。停止前に進めていた作業を再開してください。まず session_bus_digest で他セッションの進捗を確認し、共有ファイルは現物を読み直してから続行してください。再開内容を 1〜2 行で share_progress に記録してください。',
})

function storeDir() {
  return path.join(os.homedir(), '.dsh', 'storages', 'session-bus')
}

function logFile() {
  return path.join(storeDir(), 'control-run.log')
}

function stateFile() {
  return path.join(storeDir(), 'control-run.json')
}

function markerFile() {
  return path.join(storeDir(), 'control-run.done')
}

function record(line) {
  try {
    mkdirSync(storeDir(), { recursive: true })
    appendFileSync(logFile(), `[${new Date().toISOString()}] ${line}\n`, 'utf8')
  } catch {
    // Diagnostics must never break the host.
  }
}

function writeState(value) {
  try {
    mkdirSync(storeDir(), { recursive: true })
    writeFileSync(stateFile(), `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  } catch {
    // Ignore: the state file is informational.
  }
}

function isSubagent(summary) {
  return summary?.origin === 'subagent'
}

function clampDelay(value) {
  const candidate =
    typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : DEFAULT_CONFIG.resumeDelayMs
  return Math.min(600000, Math.max(1000, candidate))
}

/**
 * Host plugin entry point. Returns promptly; the sweep continues in background.
 *
 * @param {any} ctx Cordis context
 * @param {any} config loader row config
 */
export function apply(ctx, config) {
  const raw = config !== null && typeof config === 'object' ? config : {}
  if (raw.enabled === false) {
    record('disabled by config')
    return
  }
  if (existsSync(markerFile())) {
    record('already ran (marker present); skipping')
    return
  }

  const settings = {
    resumeDelayMs: clampDelay(raw.resumeDelayMs),
    excludeSessionIds: Array.isArray(raw.excludeSessionIds)
      ? raw.excludeSessionIds.filter((id) => typeof id === 'string' && id.length > 0)
      : [],
    resumePrompt:
      typeof raw.resumePrompt === 'string' && raw.resumePrompt.trim().length > 0
        ? raw.resumePrompt.trim()
        : DEFAULT_CONFIG.resumePrompt,
  }

  record(`control bundle loaded (resumeDelayMs=${settings.resumeDelayMs}, exclude=${settings.excludeSessionIds.length})`)

  sweep(ctx, settings).catch((error) => {
    record(`sweep failed: ${String(error?.stack ?? error)}`)
    writeState({ ok: false, error: String(error?.message ?? error), at: Date.now() })
  })
}

async function sweep(ctx, settings) {
  const controller = typeof ctx.get === 'function' ? ctx.get('sessionController') : undefined
  if (controller === undefined || typeof controller.list !== 'function' || typeof controller.cancel !== 'function') {
    record('sessionController service not found')
    writeState({ ok: false, error: 'sessionController service not found', at: Date.now() })
    return
  }

  const exclude = new Set(settings.excludeSessionIds)
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), 180000)
  let listed
  try {
    listed = await controller.list({}, abort.signal)
  } catch (error) {
    clearTimeout(timer)
    record(`list failed: ${String(error?.message ?? error)}`)
    writeState({ ok: false, error: `list failed: ${String(error?.message ?? error)}`, at: Date.now() })
    return
  }
  clearTimeout(timer)

  const items = Array.isArray(listed?.items) ? listed.items : []
  const running = items.filter((item) => item?.running === true)
  const candidates = running.filter(
    (item) =>
      typeof item.sessionId === 'string' &&
      item.sessionId.length > 0 &&
      !isSubagent(item) &&
      !exclude.has(item.sessionId),
  )
  record(
    `list: total=${items.length} running=${running.length} candidates=${candidates.length} excluded=${exclude.size}`,
  )

  const stopped = []
  const failed = []
  for (const item of candidates) {
    try {
      controller.cancel({ sessionId: item.sessionId })
      stopped.push({ sessionId: item.sessionId, cwd: typeof item.cwd === 'string' ? item.cwd : undefined })
      record(`cancelled ${item.sessionId} cwd=${item.cwd ?? ''}`)
    } catch (error) {
      failed.push({ sessionId: item.sessionId, error: String(error?.message ?? error) })
      record(`cancel failed ${item.sessionId}: ${String(error?.message ?? error)}`)
    }
  }

  const state = {
    ok: failed.length === 0,
    startedAt: Date.now(),
    resumeAt: Date.now() + settings.resumeDelayMs,
    runningSeen: running.map((item) => ({ sessionId: item.sessionId, cwd: item.cwd, origin: item.origin })),
    stopped,
    failed,
    resumed: [],
    resumeFailed: [],
  }
  writeState(state)
  record(`stopped=${stopped.length} failed=${failed.length}; resume scheduled in ${settings.resumeDelayMs}ms`)

  await new Promise((resolve) => setTimeout(resolve, settings.resumeDelayMs))

  const resumed = []
  const resumeFailed = []
  for (const entry of stopped) {
    try {
      await controller.prompt({
        requestId: `session-bus-control-${Date.now()}-${randomUUID()}`,
        sessionId: entry.sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: settings.resumePrompt }],
      })
      resumed.push(entry.sessionId)
      record(`resumed ${entry.sessionId}`)
    } catch (error) {
      resumeFailed.push({ sessionId: entry.sessionId, error: String(error?.message ?? error) })
      record(`resume failed ${entry.sessionId}: ${String(error?.message ?? error)}`)
    }
  }

  state.resumed = resumed
  state.resumeFailed = resumeFailed
  state.finishedAt = Date.now()
  writeState(state)
  try {
    writeFileSync(markerFile(), new Date().toISOString(), 'utf8')
  } catch {
    // Marker is best-effort.
  }
  record(`resumed=${resumed.length} failed=${resumeFailed.length}`)
}

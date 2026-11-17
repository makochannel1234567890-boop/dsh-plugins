/**
 * dsh-session-bus-resume — one-shot host-side resume sweep.
 *
 * The stop bundle (dsh-session-bus-control) recorded every session it cancelled
 * in `~/.dsh/storages/session-bus/control-run.json`. This bundle sends the
 * resume prompt to exactly those sessions, all at once, from the plugin apply
 * hook so no tool-dispatch timeout applies.
 *
 * Note: `sessionController.prompt(request, signal)` requires the signal argument;
 * omitting it throws "Cannot read properties of undefined (reading
 * 'throwIfAborted')" — observed in the first stop sweep's resume attempt.
 * This bundle passes a fresh AbortController signal per call.
 *
 * @module dsh-session-bus-resume
 */

import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const name = 'session-bus-resume'

const DEFAULT_PROMPT =
  '（dsh-session-bus）一斉停止が解除されました。停止前に進めていた作業を再開してください。まず session_bus_digest で他セッションの進捗を確認し、共有ファイルは現物を読み直してから続行してください。再開内容を 1〜2 行で share_progress に記録してください。'

function storeDir() {
  return path.join(os.homedir(), '.dsh', 'storages', 'session-bus')
}

function stateFile() {
  return path.join(storeDir(), 'control-run.json')
}

function markerFile() {
  return path.join(storeDir(), 'resume-run.done')
}

function logFile() {
  return path.join(storeDir(), 'resume-run.log')
}

function record(line) {
  try {
    mkdirSync(storeDir(), { recursive: true })
    appendFileSync(logFile(), `[${new Date().toISOString()}] ${line}\n`, 'utf8')
  } catch {
    // Diagnostics must never break the host.
  }
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
  const promptText =
    typeof raw.resumePrompt === 'string' && raw.resumePrompt.trim().length > 0
      ? raw.resumePrompt.trim()
      : DEFAULT_PROMPT
  record('resume bundle loaded')
  sweep(ctx, promptText).catch((error) => {
    record(`sweep failed: ${String(error?.stack ?? error)}`)
  })
}

async function sweep(ctx, promptText) {
  const controller = typeof ctx.get === 'function' ? ctx.get('sessionController') : undefined
  if (controller === undefined || typeof controller.prompt !== 'function') {
    record('sessionController service not found')
    return
  }

  let state
  try {
    state = JSON.parse(readFileSync(stateFile(), 'utf8'))
  } catch (error) {
    record(`no control state: ${String(error?.message ?? error)}`)
    return
  }

  const ids = new Set()
  for (const entry of Array.isArray(state.stopped) ? state.stopped : []) {
    if (typeof entry?.sessionId === 'string' && entry.sessionId.length > 0) ids.add(entry.sessionId)
  }
  for (const entry of Array.isArray(state.resumeFailed) ? state.resumeFailed : []) {
    if (typeof entry?.sessionId === 'string' && entry.sessionId.length > 0) ids.add(entry.sessionId)
  }
  record(`resume targets=${ids.size}`)

  const resumed = []
  const failed = []
  for (const sessionId of ids) {
    const signal = new AbortController().signal
    try {
      await controller.prompt(
        {
          requestId: `session-bus-resume-${Date.now()}-${randomUUID()}`,
          sessionId,
          mode: 'queue',
          content: [{ type: 'text', text: promptText }],
        },
        signal,
      )
      resumed.push(sessionId)
      record(`resumed ${sessionId}`)
    } catch (error) {
      failed.push({ sessionId, error: String(error?.message ?? error) })
      record(`resume failed ${sessionId}: ${String(error?.message ?? error)}`)
    }
  }

  state.resumed = [...(Array.isArray(state.resumed) ? state.resumed : []), ...resumed]
  state.resumeFailed = failed
  state.finishedAt = Date.now()
  try {
    writeFileSync(stateFile(), `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    writeFileSync(markerFile(), new Date().toISOString(), 'utf8')
  } catch (error) {
    record(`state write failed: ${String(error?.message ?? error)}`)
  }
  record(`resumed=${resumed.length} failed=${failed.length}`)
}

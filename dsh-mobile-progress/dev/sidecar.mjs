/**
 * Standalone sidecar for dsh-mobile-progress.
 *
 * The plugin normally runs inside the Harness Host process. When the Host
 * cannot hot-apply a profile change (for example while another plugin
 * installation holds the HMR transaction), this sidecar runs the exact same
 * plugin code against a minimal host mock and feeds it the current session's
 * own log, so the phone page can still be verified end to end.
 *
 * It is a development/verification tool, not part of the installed bundle:
 *
 *   node dev/sidecar.mjs
 *
 * The session id comes from DSH_SESSION_ID (set in every Harness shell).
 */

import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

import { apply } from '../index.js'

const sessionId = process.env.DSH_SESSION_ID
if (!sessionId) {
  console.error('DSH_SESSION_ID is not set; run this from a Harness shell.')
  process.exit(1)
}

const sessionsRoot = path.join(os.homedir(), '.dsh', 'sessions')
const cwd = process.cwd()

async function findSessionLog() {
  const workspaces = await fsp.readdir(sessionsRoot, { withFileTypes: true })
  for (const workspace of workspaces) {
    if (!workspace.isDirectory()) continue
    const directory = path.join(sessionsRoot, workspace.name, sessionId)
    const file = path.join(directory, 'session.v4.jsonl.zstd')
    try {
      const stat = await fsp.stat(file)
      if (stat.isFile()) return file
    } catch {
      // Not this workspace.
    }
  }
  throw new Error(`session log not found for ${sessionId}`)
}

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** The DSH session file is a concatenation of independently written zstd frames. */
function decompressFrames(buffer) {
  const chunks = []
  let offset = 0
  while (offset < buffer.length) {
    const start = buffer.indexOf(ZSTD_MAGIC, offset)
    if (start < 0) break
    let end = buffer.indexOf(ZSTD_MAGIC, start + ZSTD_MAGIC.length)
    if (end < 0) end = buffer.length
    try {
      chunks.push(zstdDecompressSync(buffer.subarray(start, end)))
    } catch {
      // The last frame can be mid-write; the next poll picks it up.
    }
    offset = end
  }
  return Buffer.concat(chunks).toString('utf8')
}

const handlers = new Map()
const effects = []

/**
 * Fake `sessionController` for `DSH_MP_CONTROL_MOCK=1`.
 *
 * The real service only exists inside the Harness Host, so the phone's
 * "start a session" flow is exercised offline: `create` returns a plausible
 * id, and `prompt` emits the same `session/event` sequence a real session
 * would (the request, then a final assistant message), which makes the
 * tracking switch and the result fold observable end to end.
 */
function makeMockController() {
  return {
    async create(request) {
      const cwd = typeof request?.cwd === 'string' ? request.cwd : ''
      return { sessionId: `session-sidecar-${Date.now()}`, cwd }
    },
    async prompt(request, signal) {
      const sessionId = String(request?.sessionId ?? '')
      const content = Array.isArray(request?.content) ? request.content : []
      const text = content
        .filter((block) => block?.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n')
      const target = { id: sessionId, header: { cwd } }
      setTimeout(() => {
        if (signal?.aborted) return
        const emit = (type, data) => handlers.get('session/event')?.(target, { type, data, time: Date.now() })
        emit('user/message', { content: [{ type: 'text', text }] })
        emit('assistant/message', {
          turn: 1,
          step: 1,
          message: { role: 'assistant', content: [{ type: 'text', text: 'sidecar mock result' }] },
        })
      }, 200)
    },
  }
}

const mockController = makeMockController()
const controlMock = process.env.DSH_MP_CONTROL_MOCK === '1'
const workspacesFile = process.env.DSH_MP_WORKSPACES_FILE ?? ''

const mockContext = {
  tools: {
    register(definition) {
      return () => {
        void definition
      }
    },
  },
  on(event, handler) {
    handlers.set(event, handler)
    return () => handlers.delete(event)
  },
  get(name) {
    if (name === 'systemPrompt') return { section: () => () => undefined }
    if (name === 'workingDirectory') return { get: () => cwd }
    if (name === 'agents') return { currentInitiator: () => undefined }
    if (name === 'sessionController') return controlMock ? mockController : undefined
    return undefined
  },
  effect(factory) {
    const disposer = factory()
    effects.push(disposer)
    return disposer
  },
  logger: {
    warn: (message) => console.log(`[plugin] ${message}`),
  },
}

console.log(`[sidecar] session ${sessionId}`)
const port = Number(process.env.DSH_MP_PORT ?? 8790)
const tunnelOn = process.env.DSH_MP_TUNNEL === '1'
const keepAwakeOn = process.env.DSH_MP_KEEPAWAKE === '1'
console.log(`[sidecar] port ${port} tunnel=${tunnelOn} keepAwake=${keepAwakeOn} controlMock=${controlMock}`)
console.log(`[sidecar] workspaces ledger ${workspacesFile.length > 0 ? workspacesFile : '(default)'}`)
apply(mockContext, {
  enabled: true,
  port,
  host: '0.0.0.0',
  accessToken: '',
  title: 'DSH Progress · live',
  autoClaim: true,
  persist: false,
  // `DSH_MP_TUNNEL=1` exercises the real remote-access path (cloudflared is
  // downloaded on first use), `DSH_MP_KEEPAWAKE=1` the sleep guard.
  tunnel: tunnelOn ? { enabled: true, provider: 'cloudflared', mode: 'quick', autoDownload: true } : false,
  keepAwake: keepAwakeOn,
  // `DSH_MP_CONTROL_MOCK=1` backs `POST /api/session` with a fake controller;
  // `DSH_MP_WORKSPACES_FILE` points the list at another ledger.
  control: { enabled: true, workspacesFile },
})

const logFile = await findSessionLog()
console.log(`[sidecar] log ${logFile}`)

const session = { id: sessionId, header: { cwd } }
const seen = new Set()
let lastSize = 0
let dispatched = 0

async function poll() {
  const buffer = await fsp.readFile(logFile)
  if (buffer.length === lastSize) return
  lastSize = buffer.length

  const events = []
  for (const line of decompressFrames(buffer).split('\n')) {
    if (line.trim().length === 0) continue
    try {
      const value = JSON.parse(line)
      if (value !== null && typeof value === 'object' && value.type !== 'session' && typeof value.seq === 'number') {
        events.push(value)
      }
    } catch {
      // A partial line from the newest frame.
    }
  }
  events.sort((left, right) => left.seq - right.seq)
  for (const event of events) {
    const key = String(event.seq)
    if (seen.has(key)) continue
    seen.add(key)
    dispatched += 1
    try {
      handlers.get('session/event')?.(session, event)
    } catch (error) {
      console.error('[sidecar] handler error', error)
    }
  }
  if (dispatched > 0) console.log(`[sidecar] dispatched ${dispatched} events (last seq ${events.at(-1)?.seq})`)
}

await poll()
console.log('[sidecar] serving on port 8790')
setInterval(() => {
  poll().catch((error) => console.error('[sidecar] poll failed', error?.message ?? error))
}, 1000)

// Electron's `ELECTRON_RUN_AS_NODE` mode exits once the main module finishes,
// even with live timers or an HTTP server. A never-settling top-level await
// keeps the process resident under both Node and Electron, which also keeps
// the Windows firewall rule for `DeepSeek Harness.exe` applicable.
await new Promise(() => {})

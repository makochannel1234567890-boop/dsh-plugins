/**
 * dsh-mobile-progress — live progress for the phone.
 *
 * The Host plugin watches the session log (read-only, post-commit), folds the
 * few facts that describe "what is happening now" into a small JSON state,
 * and serves it over a dedicated LAN HTTP server:
 *
 *   GET /                 mobile-first progress UI (bar + step checklist)
 *   GET /api/state        current JSON state
 *   GET /api/stream       Server-Sent Events; pushes state on every change
 *   GET /manifest.webmanifest, /sw.js, /icon.svg, /icon-*.png
 *
 * The model can publish an explicit milestone with the `progress_update` tool.
 * `todo_write` calls are mirrored automatically, so the phone bar follows the
 * agent's own task list without extra turns.
 *
 * State is a derived cache (the session log stays the source of truth) and is
 * persisted to `<home>/.dsh/storages/mobile-progress/state.json` so the page
 * still shows the last known progress after a Harness restart.
 *
 * @module dsh-mobile-progress
 */

import { randomBytes } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  describePath,
  installCloudflared,
  keepAwakeScript,
  keepAwakeSpawn,
  killTree,
  locateCloudflared,
  resolveTunnelConfig,
  spawnTracked,
  tunnelArgs,
  withToken,
  findPublicUrl,
} from './lib/tunnel.js'

export const name = 'mobile-progress'

/** `tools` is required; every other service is resolved optionally via `ctx.get`. */
export const inject = ['tools']

const PLUGIN_VERSION = '0.2.0'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC_DIR = path.join(HERE, 'public')

const SECTION_NAME = 'tool:mobile-progress'
/** Just below the goal section, above the workflow section. */
const SECTION_ORDER = 2350

const PROMPT_SECTION = `## Phone progress feed (dsh-mobile-progress)

A companion plugin mirrors this session's progress to the user's phone as a
simple progress bar. Keep it accurate with \`progress_update\`:

- When you start a multi-step request, call \`progress_update\` once with a short
  \`title\`, the user's \`request\`, and a \`steps\` array (one entry per planned
  step, status \`pending\`/\`in_progress\`/\`done\`).
- \`todo_write\` calls are mirrored automatically; you do not need to duplicate
  them. Call \`progress_update\` again after a milestone, a plan change, a blocker,
  or before a long-running tool call, with the new \`status\`, \`percent\`,
  \`current_step\`, or \`steps\`.
- Finish with \`status: "done"\` (100%) or \`status: "blocked"\` plus a \`note\`
  that says what is missing. Use \`percent\` only when the step list cannot
  express progress.
- Keep titles and steps short (they are read on a phone), never include secrets,
  and never wait for the phone to acknowledge anything.`

const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  port: 8790,
  host: '0.0.0.0',
  accessToken: '',
  title: 'DSH Progress',
  autoClaim: true,
  persist: true,
  storeDir: '',
  maxLogs: 40,
})

const MIME_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
})

const STATIC_ROUTES = Object.freeze({
  '/': 'index.html',
  '/index.html': 'index.html',
  '/style.css': 'style.css',
  '/app.js': 'app.js',
  '/manifest.webmanifest': 'manifest.webmanifest',
  '/sw.js': 'sw.js',
  '/icon.svg': 'icon.svg',
  '/icon-180.png': 'icon-180.png',
  '/icon-192.png': 'icon-192.png',
  '/icon-512.png': 'icon-512.png',
  '/icon-maskable-192.png': 'icon-maskable-192.png',
  '/icon-maskable-512.png': 'icon-maskable-512.png',
})

// ---------------------------------------------------------------------------
// Small pure helpers (unit-tested in test/state.test.mjs)
// ---------------------------------------------------------------------------

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

export function truncate(text, max) {
  const value = String(text ?? '').trim()
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`
}

export function normalizeStepStatus(value) {
  switch (String(value ?? '').toLowerCase()) {
    case 'done':
    case 'completed':
    case 'complete':
    case 'finished':
      return 'done'
    case 'in_progress':
    case 'in-progress':
    case 'active':
    case 'running':
    case 'current':
      return 'in_progress'
    default:
      return 'pending'
  }
}

export function normalizeStatus(value, fallback = 'idle') {
  switch (String(value ?? '').toLowerCase()) {
    case 'working':
    case 'running':
    case 'busy':
      return 'working'
    case 'done':
    case 'complete':
    case 'completed':
      return 'done'
    case 'blocked':
    case 'waiting':
      return 'blocked'
    case 'error':
    case 'failed':
      return 'error'
    case 'idle':
    case 'ready':
      return 'idle'
    default:
      return fallback
  }
}

/**
 * Percent derived from a step list: done counts fully, the active step half.
 * Returns `null` when there is nothing to measure (the UI shows an
 * indeterminate bar instead of a fake number).
 */
export function percentFromSteps(steps) {
  if (!Array.isArray(steps) || steps.length === 0) return null
  let score = 0
  for (const step of steps) {
    if (step?.status === 'done') score += 1
    else if (step?.status === 'in_progress') score += 0.5
  }
  return clamp(Math.round((score / steps.length) * 100), 0, 100)
}

/** Normalize a `todo_write`/`progress_update` step list into the page model. */
export function normalizeSteps(input, limit = 40) {
  if (!Array.isArray(input)) return []
  const steps = []
  for (const item of input.slice(0, limit)) {
    if (item === null || typeof item !== 'object') continue
    const text = truncate(item.text ?? item.content ?? item.title ?? '', 160)
    if (text.length === 0) continue
    steps.push({ text, status: normalizeStepStatus(item.status) })
  }
  return steps
}

/** Extract the visible text of a stored user message (no thinking blocks). */
export function extractMessageText(content, limit = 400) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return truncate(parts.join(' '), limit)
}

const SYNTHETIC_USER_MARKERS = [
  'Current runtime context. This snapshot supersedes',
  'This snapshot supersedes earlier runtime-context snapshots.',
  '（参考情報。断定せず、共有ファイルは現物を確認する',
  '（dsh-session-bus）',
  '<hindsight_knowledge',
  '<AEGIS_DSH_ROUTING_BOOTSTRAP>',
]

/**
 * The Harness injects runtime context, cross-session digests, and skill
 * catalogs as user-role messages. They are not the human's request and must
 * not replace the request line on the phone.
 */
export function cleanUserRequest(text, limit = 400) {
  let value = String(text ?? '').trim()
  if (value.length === 0) return ''
  if (value.startsWith('<')) return ''
  if (value.startsWith('background job ')) return ''
  if (value.startsWith('A skill is a reusable set of task-specific instructions.')) return ''
  if (value.includes('A skill is a reusable set of task-specific instructions.')) return ''
  if (/^Time sampled while preparing\b/.test(value)) return ''
  if (value.length < 900 && value.includes('Browser time zone for this request:')) return ''
  const runtimeAt = value.search(/Current runtime context\. This snapshot supersedes/)
  if (runtimeAt > 0) value = value.slice(0, runtimeAt).trim()
  for (const marker of [
    '\n\n### セッション間の進捗共有',
    '\n\n<hindsight_knowledge',
    '\n\n<AEGIS_DSH_ROUTING_BOOTSTRAP>',
    '\n\n<available_skills>',
  ]) {
    const at = value.indexOf(marker)
    if (at > 0) value = value.slice(0, at).trim()
  }
  if (value.length === 0) return ''
  for (const marker of SYNTHETIC_USER_MARKERS) {
    if (value.startsWith(marker)) return ''
  }
  return truncate(value, limit)
}

export function buildUrls({ host, port, accessToken, interfaces }) {
  const token = accessToken ? `?k=${encodeURIComponent(accessToken)}` : ''
  const urls = []
  const privateOnly = host !== '0.0.0.0' && host !== '::' && host !== ''
  if (!privateOnly) {
    for (const address of interfaces) {
      if (!address || address.startsWith('169.254.')) continue
      urls.push(`http://${address}:${port}/${token}`)
    }
  }
  urls.push(`http://127.0.0.1:${port}/${token}`)
  return [...new Set(urls)]
}

export function lanInterfaces() {
  const result = []
  try {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const info of list ?? []) {
        if (info.family === 'IPv4' && !info.internal) result.push(info.address)
      }
    }
  } catch {
    // No interfaces available; localhost remains.
  }
  return result
}

function nowIso() {
  return new Date().toISOString()
}

function shortId(id) {
  const value = String(id ?? '')
  const stripped = value.startsWith('session-') ? value.slice('session-'.length) : value
  return stripped.slice(0, 8)
}

function resolveConfig(input) {
  const raw = input && typeof input === 'object' ? input : {}
  const port = Number.isFinite(Number(raw.port)) ? Math.trunc(Number(raw.port)) : DEFAULT_CONFIG.port
  const storeDir =
    typeof raw.storeDir === 'string' && raw.storeDir.trim().length > 0
      ? raw.storeDir.trim()
      : path.join(os.homedir(), '.dsh', 'storages', 'mobile-progress')
  const tunnelInput = raw.tunnel
  const tunnelObject = tunnelInput !== null && typeof tunnelInput === 'object' ? tunnelInput : {}
  const keepAwakeInput = raw.keepAwake !== undefined ? raw.keepAwake : tunnelObject.keepAwake
  const tunnel = resolveTunnelConfig(
    typeof tunnelInput === 'boolean'
      ? tunnelInput
      : { ...tunnelObject, ...(keepAwakeInput !== undefined ? { keepAwake: keepAwakeInput } : {}) },
  )
  return {
    enabled: raw.enabled !== false,
    port: clamp(port, 1024, 65535),
    host: typeof raw.host === 'string' && raw.host.length > 0 ? raw.host : DEFAULT_CONFIG.host,
    accessToken: typeof raw.accessToken === 'string' ? raw.accessToken : DEFAULT_CONFIG.accessToken,
    title: typeof raw.title === 'string' && raw.title.trim().length > 0 ? raw.title.trim() : DEFAULT_CONFIG.title,
    autoClaim: raw.autoClaim !== false,
    persist: raw.persist !== false,
    storeDir,
    maxLogs: Number.isFinite(Number(raw.maxLogs))
      ? clamp(Math.trunc(Number(raw.maxLogs)), 5, 200)
      : DEFAULT_CONFIG.maxLogs,
    tunnel,
    keepAwake: tunnel.keepAwake,
  }
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export function apply(ctx, config = {}) {
  const settings = resolveConfig(config)

  const runtime = {
    settings,
    claimedSessionId: null,
    session: null,
    server: null,
    port: 0,
    urls: [],
    lanUrls: [],
    clients: new Set(),
    startedAt: Date.now(),
    disposed: false,
    ready: null,
    broadcastTimer: null,
    persistTimer: null,
    heartbeat: null,
    saveInFlight: false,
    dirty: false,
    tokenSource: 'none',
    tunnelChild: null,
    tunnelRestartTimer: null,
    awakeChild: null,
    tunnel: { status: 'off', url: '', error: '', binary: '', restarts: 0, startedAt: 0 },
    keepAwake: { active: false, pid: 0, error: '' },
  }

  const log = (message) => {
    try {
      ctx.logger?.warn?.(`dsh-mobile-progress: ${message}`)
    } catch {
      // Logging must never break the host.
    }
  }

  // -- session state ---------------------------------------------------------

  function blankSession(id, cwd) {
    return {
      id: String(id),
      short: shortId(id),
      title: '',
      request: '',
      status: 'idle',
      percent: null,
      currentStep: '',
      note: '',
      steps: [],
      logs: [],
      startedAt: Date.now(),
      updatedAt: Date.now(),
      lastActivityAt: Date.now(),
      turns: 0,
      toolCalls: 0,
      lastTool: '',
      agentRunning: false,
      cwdName: cwd ? path.basename(String(cwd)) : '',
      manualStatus: false,
      manualPercent: false,
    }
  }

  function pushLog(session, text, at = Date.now()) {
    const value = truncate(text, 180)
    if (value.length === 0) return
    session.logs.push({ at, text: value })
    if (session.logs.length > settings.maxLogs) {
      session.logs.splice(0, session.logs.length - settings.maxLogs)
    }
  }

  function claimSession(sessionId, cwd) {
    const id = String(sessionId)
    if (runtime.claimedSessionId === id && runtime.session !== null) return runtime.session
    runtime.claimedSessionId = id
    runtime.session = blankSession(id, cwd)
    pushLog(runtime.session, '進捗フィードを開始')
    schedulePersist()
    scheduleBroadcast()
    return runtime.session
  }

  function currentSession() {
    return runtime.session
  }

  function publicState() {
    const session = runtime.session
    const selected = session === null ? null : {
      id: session.id,
      short: session.short,
      title: session.title,
      request: session.request,
      status: session.status,
      percent: session.percent,
      currentStep: session.currentStep,
      note: session.note,
      steps: session.steps,
      logs: session.logs.slice(-8),
      startedAt: session.startedAt,
      updatedAt: session.updatedAt,
      lastActivityAt: session.lastActivityAt,
      turns: session.turns,
      toolCalls: session.toolCalls,
      lastTool: session.lastTool,
      agentRunning: session.agentRunning,
      cwdName: session.cwdName,
      stale: Date.now() - session.updatedAt > 15 * 60 * 1000,
    }
    return {
      ok: true,
      version: PLUGIN_VERSION,
      title: settings.title,
      now: Date.now(),
      server: {
        port: runtime.port,
        urls: runtime.urls,
        lanUrls: runtime.lanUrls,
        startedAt: runtime.startedAt,
        host: settings.host,
        hasToken: settings.accessToken.length > 0,
        tokenSource: runtime.tokenSource,
        publicUrl: publicUrlValue(),
        tunnel: {
          enabled: settings.tunnel.enabled,
          provider: settings.tunnel.provider,
          mode: settings.tunnel.mode,
          status: runtime.tunnel.status,
          error: runtime.tunnel.error,
          binary: runtime.tunnel.binary,
          restarts: runtime.tunnel.restarts,
        },
        keepAwake: {
          enabled: settings.keepAwake.enabled,
          active: runtime.keepAwake.active,
          pid: runtime.keepAwake.pid,
          error: runtime.keepAwake.error,
        },
      },
      session: selected,
    }
  }

  function primaryUrl() {
    return runtime.urls[0] ?? `http://127.0.0.1:${runtime.port || settings.port}/`
  }

  // -- broadcasting & persistence -------------------------------------------

  function markChanged({ activity = true } = {}) {
    if (runtime.session !== null) {
      runtime.session.updatedAt = Date.now()
      if (activity) runtime.session.lastActivityAt = runtime.session.updatedAt
    }
    scheduleBroadcast()
    schedulePersist()
  }

  function scheduleBroadcast() {
    if (runtime.disposed || runtime.broadcastTimer !== null) return
    runtime.broadcastTimer = setTimeout(() => {
      runtime.broadcastTimer = null
      broadcast()
    }, 60)
  }

  function broadcast() {
    if (runtime.disposed) return
    const payload = `data: ${JSON.stringify(publicState())}\n\n`
    for (const res of runtime.clients) {
      try {
        res.write(payload)
      } catch {
        runtime.clients.delete(res)
      }
    }
  }

  function schedulePersist() {
    if (!settings.persist || runtime.persistTimer !== null) return
    runtime.persistTimer = setTimeout(() => {
      runtime.persistTimer = null
      void persistState()
    }, 900)
  }

  async function persistState() {
    if (!settings.persist || runtime.session === null) return
    if (runtime.saveInFlight) {
      runtime.dirty = true
      return
    }
    runtime.saveInFlight = true
    try {
      await fsp.mkdir(settings.storeDir, { recursive: true })
      const file = path.join(settings.storeDir, 'state.json')
      const body = JSON.stringify({
        version: 1,
        plugin: PLUGIN_VERSION,
        savedAt: nowIso(),
        claimedSessionId: runtime.claimedSessionId,
        session: runtime.session,
      })
      await fsp.writeFile(file, body, 'utf8')
    } catch (error) {
      log(`could not persist state: ${String(error?.message ?? error)}`)
    } finally {
      runtime.saveInFlight = false
      if (runtime.dirty) {
        runtime.dirty = false
        schedulePersist()
      }
    }
  }

  async function loadState() {
    if (!settings.persist) return
    try {
      const file = path.join(settings.storeDir, 'state.json')
      const text = await fsp.readFile(file, 'utf8')
      const saved = JSON.parse(text)
      if (saved?.version !== 1 || !saved.session || typeof saved.session.id !== 'string') return
      const base = blankSession(saved.session.id, null)
      const session = { ...base, ...saved.session }
      session.steps = normalizeSteps(session.steps)
      session.logs = Array.isArray(session.logs) ? session.logs.slice(-settings.maxLogs) : []
      session.agentRunning = false
      session.stale = true
      session.lastActivityAt = Number(session.lastActivityAt) || Number(session.updatedAt) || Date.now()
      session.updatedAt = Number(session.updatedAt) || Date.now()
      runtime.claimedSessionId = typeof saved.claimedSessionId === 'string' ? saved.claimedSessionId : session.id
      runtime.session = session
      pushLog(session, '前回の状態を復元')
    } catch (error) {
      if (error?.code !== 'ENOENT') log(`could not restore state: ${String(error?.message ?? error)}`)
    }
  }

  // -- fold session events ---------------------------------------------------

  function applySteps(session, steps, { manual = false } = {}) {
    const list = normalizeSteps(steps)
    if (list.length === 0) return
    session.steps = list
    session.manualPercent = false
    session.percent = percentFromSteps(list)
    const active = list.find((step) => step.status === 'in_progress')
    if (active) session.currentStep = active.text
    else if (list.every((step) => step.status === 'done')) session.currentStep = 'すべてのステップが完了'
    if (list.every((step) => step.status === 'done') && session.percent === null && !manual) {
      session.percent = 100
    }
  }

  function onTrackedEvent(session, event) {
    if (!session || !event || typeof event !== 'object') return
    const data = event.data ?? {}
    let activity = true

    switch (event.type) {
      case 'turn/start':
        session.turns = Math.max(session.turns, Number(data.turn) || 0)
        session.agentRunning = true
        if (!session.manualStatus || session.status === 'idle') session.status = 'working'
        pushLog(session, `ターン ${data.turn ?? session.turns} を開始`, Number(event.time) || Date.now())
        break
      case 'turn/end':
        session.agentRunning = false
        if (session.status === 'working') {
          session.status = 'idle'
          pushLog(session, `ターン ${data.turn ?? session.turns} を終了`, Number(event.time) || Date.now())
        }
        break
      case 'user/message': {
        const text = extractMessageText(data.content, 1200)
        const request = cleanUserRequest(text, 400)
        if (request.length > 0) {
          session.request = request
          if (session.title.length === 0) {
            const firstLine = request.split('\n').find((line) => line.trim().length > 0) ?? request
            session.title = truncate(firstLine, 80)
          }
          pushLog(session, `依頼: ${truncate(request, 90)}`, Number(event.time) || Date.now())
        }
        break
      }
      case 'tool/call': {
        session.toolCalls += 1
        session.lastTool = truncate(data.name ?? '', 60)
        if (data.name === 'todo_write') {
          try {
            const args = JSON.parse(String(data.arguments ?? '{}'))
            if (Array.isArray(args?.todos)) {
              applySteps(session, args.todos)
              pushLog(session, 'タスクリストを同期', Number(event.time) || Date.now())
            }
          } catch {
            // A malformed tool argument never breaks the feed.
          }
        }
        break
      }
      case 'tool/result':
      case 'assistant/message':
        break
      default:
        activity = false
        break
    }

    session.updatedAt = Date.now()
    if (activity) session.lastActivityAt = session.updatedAt
    scheduleBroadcast()
    schedulePersist()
  }

  function onSessionEvent(session, event) {
    if (runtime.disposed) return
    const id = String(session?.id ?? '')
    if (id.length === 0) return

    let tracked = currentSession()
    if (tracked !== null && tracked.id !== id) tracked = null

    if (tracked === null && settings.autoClaim && runtime.session === null) {
      const header = session.header ?? {}
      if (!header.parentSession) {
        tracked = claimSession(id, header.cwd)
      }
    }

    if (tracked === null) return
    onTrackedEvent(tracked, event)
  }

  function onAgentStatus(payload) {
    const session = currentSession()
    if (session === null) return
    const agent = payload?.agent
    if (!agent?.session || String(agent.session.id) !== session.id) return
    session.agentRunning = payload.status === 'running'
    if (session.agentRunning && (session.status === 'idle' || session.status === 'working')) {
      session.status = 'working'
    } else if (!session.agentRunning && session.status === 'working' && !session.manualStatus) {
      session.status = 'idle'
    }
    session.updatedAt = Date.now()
    scheduleBroadcast()
    schedulePersist()
  }

  function onAgentError(payload) {
    const session = currentSession()
    if (session === null) return
    const agent = payload?.agent
    if (agent?.session && String(agent.session.id) !== session.id) return
    session.status = 'error'
    session.agentRunning = false
    const message = payload?.error?.message ?? payload?.error?.code ?? 'unknown'
    pushLog(session, `エラー: ${truncate(message, 120)}`)
    session.updatedAt = Date.now()
    scheduleBroadcast()
    schedulePersist()
  }

  // -- HTTP server -----------------------------------------------------------

  function authorized(req, url) {
    if (settings.accessToken.length === 0) return true
    const query = url.searchParams.get('k')
    if (query === settings.accessToken) return true
    return req.headers['x-progress-token'] === settings.accessToken
  }

  async function serveStatic(res, fileName, method) {
    const file = path.join(PUBLIC_DIR, fileName)
    try {
      const body = await fsp.readFile(file)
      const type = MIME_TYPES[path.extname(fileName)] ?? 'application/octet-stream'
      res.writeHead(200, {
        'content-type': type,
        'cache-control': 'no-store',
        'content-length': body.byteLength,
        'x-content-type-options': 'nosniff',
      })
      res.end(method === 'HEAD' ? undefined : body)
    } catch {
      sendJson(res, 404, { ok: false, error: 'not found' })
    }
  }

  /**
   * The manifest is generated per request: when an access token is required,
   * `start_url` and the shortcuts must already carry it, otherwise installing
   * the PWA would launch a 401 page.
   */
  async function serveManifest(res, method) {
    let manifest
    try {
      const text = await fsp.readFile(path.join(PUBLIC_DIR, 'manifest.webmanifest'), 'utf8')
      manifest = JSON.parse(text)
    } catch (error) {
      log(`manifest unavailable: ${String(error?.message ?? error)}`)
      sendJson(res, 500, { ok: false, error: 'manifest unavailable' })
      return
    }
    const token = settings.accessToken
    manifest.name = manifest.name || settings.title
    manifest.short_name = manifest.short_name || settings.title
    manifest.start_url = withToken('/', token)
    manifest.scope = '/'
    if (Array.isArray(manifest.shortcuts)) {
      manifest.shortcuts = manifest.shortcuts.map((shortcut) => ({
        ...shortcut,
        url: withToken(shortcut.url ?? '/', token),
      }))
    }
    const body = Buffer.from(JSON.stringify(manifest, null, 2))
    res.writeHead(200, {
      'content-type': 'application/manifest+json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': body.byteLength,
      'x-content-type-options': 'nosniff',
    })
    res.end(method === 'HEAD' ? undefined : body)
  }

  function sendJson(res, status, value) {
    const body = Buffer.from(JSON.stringify(value))
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': body.byteLength,
      'x-content-type-options': 'nosniff',
    })
    res.end(body)
  }

  function openEventStream(req, res, url) {
    if (!authorized(req, url)) {
      sendJson(res, 401, { ok: false, error: 'unauthorized' })
      return
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'x-content-type-options': 'nosniff',
    })
    res.write('retry: 3000\n\n')
    res.write(`data: ${JSON.stringify(publicState())}\n\n`)
    runtime.clients.add(res)
    const cleanup = () => runtime.clients.delete(res)
    req.on('close', cleanup)
    req.on('error', cleanup)
  }

  async function handleRequest(req, res) {
    let url
    try {
      url = new URL(req.url ?? '/', 'http://localhost')
    } catch {
      sendJson(res, 400, { ok: false, error: 'bad request' })
      return
    }
    const method = req.method ?? 'GET'

    // The app shell (HTML/CSS/JS/icons/manifest) is public: `<script src>` and
    // `<link href>` do not inherit the page query string, so gating them would
    // break the page itself whenever a token is configured. Only the data
    // endpoints require the token.
    const needsToken = url.pathname === '/api/state' || url.pathname === '/api/stream'
    if (needsToken && !authorized(req, url)) {
      sendJson(res, 401, { ok: false, error: 'unauthorized' })
      return
    }

    if (method !== 'GET' && method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' })
      res.end()
      return
    }

    if (url.pathname === '/healthz') {
      sendJson(res, 200, { ok: true, version: PLUGIN_VERSION, uptimeSeconds: Math.round((Date.now() - runtime.startedAt) / 1000) })
      return
    }

    if (url.pathname === '/api/state') {
      sendJson(res, 200, publicState())
      return
    }

    if (url.pathname === '/api/stream') {
      openEventStream(req, res, url)
      return
    }

    if (url.pathname === '/manifest.webmanifest') {
      await serveManifest(res, method)
      return
    }

    const fileName = STATIC_ROUTES[url.pathname]
    if (fileName !== undefined) {
      await serveStatic(res, fileName, method)
      return
    }

    sendJson(res, 404, { ok: false, error: 'not found' })
  }

  function listen(server, port, host) {
    return new Promise((resolve, reject) => {
      const onError = (error) => {
        server.off('listening', onListening)
        reject(error)
      }
      const onListening = () => {
        server.off('error', onError)
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(port, host)
    })
  }

  async function startServer() {
    if (!settings.enabled) return
    const server = http.createServer((req, res) => {
      void handleRequest(req, res).catch((error) => {
        log(`request failed: ${String(error?.message ?? error)}`)
        try {
          if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'internal error' })
          else res.end()
        } catch {
          // The socket may already be gone.
        }
      })
    })
    runtime.server = server

    let port = settings.port
    let lastError
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        await listen(server, port, settings.host)
        lastError = undefined
        break
      } catch (error) {
        lastError = error
        if (error?.code === 'EADDRINUSE') {
          port += 1
          continue
        }
        break
      }
    }
    if (lastError !== undefined) {
      log(`could not listen on ${settings.host}:${settings.port}: ${String(lastError.message ?? lastError)}`)
      try {
        server.close()
      } catch {
        // Already closed.
      }
      runtime.server = null
      return
    }

    const address = server.address()
    runtime.port = typeof address === 'object' && address !== null ? address.port : port
    runtime.urls = buildUrls({
      host: settings.host,
      port: runtime.port,
      accessToken: settings.accessToken,
      interfaces: lanInterfaces(),
    })
    runtime.lanUrls = runtime.urls.filter(
      (value) => !value.includes('127.0.0.1') && !value.includes('localhost'),
    )
    server.on('error', (error) => log(`server error: ${String(error?.message ?? error)}`))

    runtime.heartbeat = setInterval(() => {
      for (const res of runtime.clients) {
        try {
          res.write(': heartbeat\n\n')
        } catch {
          runtime.clients.delete(res)
        }
      }
    }, 15_000)
    if (typeof runtime.heartbeat.unref === 'function') runtime.heartbeat.unref()

    log(`serving on ${runtime.urls.join(' , ')}`)
    scheduleBroadcast()
  }

  // -- remote access (tunnel) & sleep guard ---------------------------------

  function authTokenFile() {
    return path.join(settings.storeDir, 'access-token')
  }

  /**
   * A public tunnel must never expose the feed without a token. When the user
   * did not configure one, generate it once and keep it in the storage dir so
   * the URL and the phone bookmark stay valid across restarts.
   */
  async function ensureAccessToken() {
    if (settings.accessToken.length > 0) {
      runtime.tokenSource = 'config'
      return
    }
    if (!settings.tunnel.enabled || !settings.tunnel.requireToken) {
      runtime.tokenSource = 'none'
      if (settings.tunnel.enabled) log('warning: tunnel is enabled without an access token')
      return
    }
    try {
      const stored = (await fsp.readFile(authTokenFile(), 'utf8')).trim()
      if (/^[A-Za-z0-9_-]{16,}$/.test(stored)) {
        settings.accessToken = stored
        runtime.tokenSource = 'stored'
        return
      }
    } catch {
      // First run with the tunnel on.
    }
    const generated = randomBytes(18).toString('base64url')
    settings.accessToken = generated
    runtime.tokenSource = 'generated'
    try {
      await fsp.mkdir(settings.storeDir, { recursive: true })
      await fsp.writeFile(authTokenFile(), `${generated}\n`, { mode: 0o600 })
    } catch (error) {
      log(`could not persist the access token: ${String(error?.message ?? error)}`)
    }
    log('generated an access token (the feed URL now ends with ?k=…)')
  }

  function publicUrlValue() {
    if (runtime.tunnel.url.length === 0) return ''
    return withToken(runtime.tunnel.url, settings.accessToken)
  }

  function setTunnelStatus(patch) {
    runtime.tunnel = { ...runtime.tunnel, ...patch }
    scheduleBroadcast()
  }

  async function ensureTunnelBinary() {
    const found = await locateCloudflared({
      binaryPath: settings.tunnel.binaryPath,
      storeDir: settings.storeDir,
    })
    if (found !== null) return found
    if (!settings.tunnel.autoDownload) return null
    setTunnelStatus({ status: 'installing' })
    log('cloudflared not found; downloading it once (~53 MB)')
    const result = await installCloudflared({ storeDir: settings.storeDir, log })
    if (!result.ok) {
      setTunnelStatus({ status: 'error', error: result.error })
      log(`cloudflared could not be installed: ${result.error}`)
      return null
    }
    return { path: result.path, source: 'download' }
  }

  function startTunnel() {
    const tunnel = settings.tunnel
    if (!tunnel.enabled || runtime.disposed) return
    if (runtime.tunnelChild !== null) return
    if (runtime.port === 0) return
    if (tunnel.provider !== 'cloudflared') {
      setTunnelStatus({ status: 'error', error: `unknown tunnel provider: ${tunnel.provider}` })
      return
    }
    if (tunnel.mode === 'named' && tunnel.token.length === 0) {
      setTunnelStatus({ status: 'error', error: 'named mode needs tunnel.token' })
      return
    }
    if (tunnel.mode === 'custom' && tunnel.command.length === 0) {
      setTunnelStatus({ status: 'error', error: 'custom mode needs tunnel.command' })
      return
    }

    setTunnelStatus({ status: 'starting', error: '' })
    void (async () => {
      const binary = await ensureTunnelBinary()
      if (binary === null || runtime.disposed) return
      const args = tunnelArgs(tunnel, { port: runtime.port })
      if (args === null) {
        setTunnelStatus({ status: 'error', error: 'could not build tunnel arguments' })
        return
      }
      setTunnelStatus({ binary: describePath(binary.path) })
      log(`tunnel: starting (${tunnel.mode}) via ${describePath(binary.path)}`)

      const child = spawnTracked(binary.path, args, {
        onLine: (line) => {
          const url = findPublicUrl(line)
          if (url !== null && url !== runtime.tunnel.url) {
            setTunnelStatus({ status: 'running', url, startedAt: Date.now(), error: '' })
            log(`tunnel: public URL ${withToken(url, settings.accessToken)}`)
          }
        },
        onExit: ({ code, error }) => {
          runtime.tunnelChild = null
          if (runtime.disposed) return
          const reason = error?.message ?? `cloudflared exited with code ${code}`
          const restarts = runtime.tunnel.restarts + 1
          setTunnelStatus({ status: 'error', url: '', error: reason, restarts })
          if (restarts > settings.tunnel.maxRestarts) {
            log(`tunnel: giving up after ${restarts} attempts (${reason})`)
            return
          }
          const delay = Math.min(45_000, 2_000 * 2 ** Math.min(restarts, 5))
          log(`tunnel: restart in ${Math.round(delay / 1000)}s (${reason})`)
          runtime.tunnelRestartTimer = setTimeout(() => {
            runtime.tunnelRestartTimer = null
            startTunnel()
          }, delay)
        },
      })
      runtime.tunnelChild = child
      if (tunnel.mode === 'named' && tunnel.publicHostname.length > 0) {
        setTunnelStatus({
          status: 'running',
          url: `https://${tunnel.publicHostname}`,
          startedAt: Date.now(),
          error: '',
        })
      }
    })()
  }

  function stopTunnel() {
    if (runtime.tunnelRestartTimer !== null) {
      clearTimeout(runtime.tunnelRestartTimer)
      runtime.tunnelRestartTimer = null
    }
    const child = runtime.tunnelChild
    runtime.tunnelChild = null
    if (child !== null) killTree(child)
    setTunnelStatus({ status: 'off', url: '' })
  }

  /**
   * Keep the machine from suspending while the feed is live. A sleeping PC
   * cannot answer the phone, so this is part of "view progress from anywhere".
   */
  async function startKeepAwake() {
    if (!settings.keepAwake.enabled || runtime.disposed || runtime.awakeChild !== null) return
    let scriptPath = ''
    if (process.platform === 'win32') {
      scriptPath = path.join(settings.storeDir, 'keep-awake.ps1')
      try {
        await fsp.mkdir(settings.storeDir, { recursive: true })
        await fsp.writeFile(scriptPath, keepAwakeScript(), 'utf8')
      } catch (error) {
        log(`could not write the keep-awake script: ${String(error?.message ?? error)}`)
        scriptPath = ''
      }
    }
    const spec = keepAwakeSpawn({ keepDisplayOn: settings.keepAwake.keepDisplayOn, scriptPath })
    if (spec === null) {
      runtime.keepAwake = { active: false, pid: 0, error: 'unsupported platform' }
      return
    }
    try {
      const child = spawnTracked(spec.command, spec.args, {
        stdio: 'ignore',
        onExit: ({ code, error }) => {
          runtime.awakeChild = null
          runtime.keepAwake = {
            active: false,
            pid: 0,
            error: error?.message ?? `keep-awake helper exited with code ${code}`,
          }
          if (!runtime.disposed) log(`keep-awake helper stopped: ${runtime.keepAwake.error}`)
        },
      })
      runtime.awakeChild = child
      runtime.keepAwake = { active: true, pid: child.pid ?? 0, error: '' }
      log(`keep-awake enabled (pid ${child.pid})`)
    } catch (error) {
      runtime.keepAwake = { active: false, pid: 0, error: String(error?.message ?? error) }
      log(`keep-awake failed: ${runtime.keepAwake.error}`)
    }
  }

  function stopKeepAwake() {
    const child = runtime.awakeChild
    runtime.awakeChild = null
    if (child !== null) killTree(child)
    runtime.keepAwake = { active: false, pid: 0, error: '' }
  }

  async function bootstrap() {
    await ensureAccessToken()
    await loadState()
    await startServer()
    startTunnel()
    await startKeepAwake()
    scheduleBroadcast()
  }

  // -- tools -----------------------------------------------------------------

  function updateOutput() {
    const session = runtime.session
    const publicUrl = publicUrlValue()
    return {
      ok: true,
      status: session?.status ?? 'idle',
      percent: session?.percent === null || session?.percent === undefined ? -1 : session.percent,
      phone_url: primaryUrl(),
      public_url: publicUrl,
      updated_at: session === null ? '' : new Date(session.updatedAt).toISOString(),
      message: session === null
        ? 'No progress state yet.'
        : `Live at ${publicUrl || primaryUrl()} (${session.percent === null ? 'indeterminate' : `${session.percent}%`}).`,
    }
  }

  const UPDATE_OUTPUT = {
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['ok', 'status', 'percent', 'phone_url', 'updated_at', 'message'],
      properties: {
        ok: { type: 'boolean' },
        status: { type: 'string' },
        percent: { type: 'number', description: '0-100, or -1 when indeterminate.' },
        phone_url: { type: 'string', description: 'LAN URL for a phone on the same Wi-Fi.' },
        public_url: { type: 'string', description: 'Public HTTPS URL when a tunnel is running (empty otherwise). Works from any network.' },
        updated_at: { type: 'string' },
        message: { type: 'string' },
      },
    },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
  }

  const STATUS_OUTPUT = {
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['ok', 'phone_url', 'public_url', 'state'],
      properties: {
        ok: { type: 'boolean' },
        phone_url: { type: 'string' },
        public_url: { type: 'string' },
        state: { type: 'object' },
      },
    },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
  }

  ctx.tools.register({
    name: 'progress_update',
    description:
      'Publish live progress to the user\'s phone (dsh-mobile-progress). Call at the start of a multi-step request with a title, the request, and a step list; call again at milestones, blockers, and completion. `todo_write` calls are mirrored automatically. The phone page updates over SSE; no acknowledgement is needed.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        title: { type: 'string', description: 'Short overall task title shown on the phone.' },
        request: { type: 'string', description: 'The current user request in one or two lines.' },
        status: {
          type: 'string',
          enum: ['working', 'idle', 'done', 'blocked', 'error'],
          description: 'Overall state. Use done at 100% and blocked/error with a note.',
        },
        percent: { type: 'number', minimum: 0, maximum: 100, description: 'Explicit percentage; omit when steps can derive it.' },
        current_step: { type: 'string', description: 'What is happening right now, one short line.' },
        steps: {
          type: 'array',
          maxItems: 40,
          description: 'Replace the step checklist. Prefer this over percent.',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['text', 'status'],
            properties: {
              text: { type: 'string', description: 'One short step label.' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'done'] },
            },
          },
        },
        note: { type: 'string', description: 'A short note or blocker shown under the bar.' },
      },
    },
    output: UPDATE_OUTPUT,
    async execute(args, exec) {
      await runtime.ready?.catch(() => {})
      const agent = exec?.agent ?? ctx.get('agents')?.currentInitiator?.()
      const sessionId = agent?.session?.id
      if (sessionId === undefined || sessionId === null) {
        throw new Error('progress_update requires a live calling session')
      }
      const cwd = ctx.get('workingDirectory')?.get(agent.session) ?? agent.session.header?.cwd
      const session = claimSession(sessionId, cwd)

      if (typeof args.title === 'string' && args.title.trim().length > 0) session.title = truncate(args.title, 120)
      if (typeof args.request === 'string' && args.request.trim().length > 0) session.request = truncate(args.request, 400)
      if (typeof args.current_step === 'string' && args.current_step.trim().length > 0) {
        session.currentStep = truncate(args.current_step, 160)
      }
      if (Array.isArray(args.steps)) applySteps(session, args.steps, { manual: true })
      if (typeof args.percent === 'number' && Number.isFinite(args.percent)) {
        session.percent = clamp(Math.round(args.percent), 0, 100)
        session.manualPercent = true
        if (session.percent === 100 && args.status === undefined && !session.manualStatus) session.status = 'working'
      }
      if (typeof args.status === 'string') {
        session.status = normalizeStatus(args.status, session.status)
        session.manualStatus = session.status === 'done' || session.status === 'blocked' || session.status === 'error'
        if (session.status === 'done') {
          session.percent = 100
          session.manualPercent = true
          if (session.steps.length > 0) session.steps = session.steps.map((step) => ({ ...step, status: 'done' }))
          session.currentStep = '完了'
        }
        if (session.status === 'working') session.manualStatus = false
      }
      if (typeof args.note === 'string' && args.note.trim().length > 0) {
        session.note = truncate(args.note, 300)
        pushLog(session, `メモ: ${session.note}`)
      }
      if (typeof args.title === 'string' || Array.isArray(args.steps)) {
        pushLog(session, `進捗を更新: ${session.percent === null ? '—' : `${session.percent}%`}${session.currentStep ? ` · ${session.currentStep}` : ''}`)
      }

      session.updatedAt = Date.now()
      session.lastActivityAt = session.updatedAt
      if (session.status === 'working') session.agentRunning = true
      scheduleBroadcast()
      schedulePersist()
      return updateOutput()
    },
    presentCall: () => ({ card: 'generic', title: 'Update phone progress', kind: 'other' }),
  })

  ctx.tools.register({
    name: 'progress_status',
    description:
      'Read the current phone progress state (session, percentage, steps, LAN URL, and the public HTTPS URL when a tunnel is running). Use it to check what the mobile page shows or to hand the user the exact URL — prefer public_url when the phone is not on the same Wi-Fi.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: STATUS_OUTPUT,
    async execute() {
      await runtime.ready?.catch(() => {})
      return { ok: true, phone_url: primaryUrl(), public_url: publicUrlValue(), state: publicState() }
    },
    presentCall: () => ({ card: 'generic', title: 'Read phone progress', kind: 'other' }),
  })

  // -- wiring ----------------------------------------------------------------

  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt !== undefined) {
    systemPrompt.section({ name: SECTION_NAME, order: SECTION_ORDER, text: PROMPT_SECTION })
  }

  ctx.on('session/event', onSessionEvent, { global: true })
  ctx.on('agent/status', onAgentStatus, { global: true })
  ctx.on('agent/error', onAgentError, { global: true })

  runtime.ready = bootstrap().catch((error) => {
    log(`bootstrap failed: ${String(error?.message ?? error)}`)
  })

  ctx.effect(() => () => {
    runtime.disposed = true
    stopTunnel()
    stopKeepAwake()
    if (runtime.broadcastTimer !== null) clearTimeout(runtime.broadcastTimer)
    if (runtime.persistTimer !== null) clearTimeout(runtime.persistTimer)
    if (runtime.heartbeat !== null) clearInterval(runtime.heartbeat)
    runtime.broadcastTimer = null
    runtime.persistTimer = null
    runtime.heartbeat = null
    for (const res of runtime.clients) {
      try {
        res.end()
      } catch {
        // Already closed.
      }
    }
    runtime.clients.clear()
    const server = runtime.server
    runtime.server = null
    if (server !== null) {
      try {
        server.closeAllConnections?.()
        server.close()
      } catch {
        // Already closed.
      }
    }
    void persistState()
  })
}

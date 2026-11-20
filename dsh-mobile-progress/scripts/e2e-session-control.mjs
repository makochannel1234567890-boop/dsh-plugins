#!/usr/bin/env node
/**
 * Independent contract test for the phone's session-control API.
 *
 * This script is deliberately separate from `test/*.test.mjs`: it boots the real
 * plugin (`apply(ctx, config)`) against a fake Cordis context, a fake
 * `sessionController` and a temporary workspace ledger, then drives the HTTP
 * surface the phone page uses. It asserts the *frozen contract* only — no
 * product code is imported except `apply`, and nothing here is a substitute for
 * reading the implementation.
 *
 * Contract under test
 * -------------------
 *   config.control = { enabled: true, workspacesFile, maxPromptChars, resultMaxChars }
 *
 *   GET  /api/workspaces?k=<token>
 *        200 { ok: true, workspaces: [{id,title,path,updatedAt,sessionCount,exists}],
 *              control: { enabled, available } }
 *        no token -> 401, entries sorted by updatedAt descending.
 *   POST /api/session?k=<token>          (content-type: application/json)
 *        body { workspaceId, prompt }
 *        201 { ok: true, session: {id,short,cwd}, workspace: {...} }
 *        400 `prompt_required` when the prompt is missing.
 *        415 when the request carries no JSON content-type.
 *   GET  /api/state?k=<token>
 *        session.result is null or { text, ... }; session.resultState is
 *        'none' | 'ready'. An `assistant/message` event fills the result, the
 *        next `user/message` clears it back to null.
 *   GET  /api/stream?k=<token>
 *        SSE; every state change is pushed as `data: {...}`.
 *
 *   The new session is created with
 *   `sessionController.create({cwd})` and prompted with
 *   `prompt({requestId,sessionId,mode:'queue',content:[{type:'text',text}],
 *            clientTimeZone}, AbortSignal)`.
 *
 * The ledger fixture mirrors the Host-owned format this module reads
 * (`~/.dsh/storages/workspace.json`):
 *
 *   { unit, global: {defaultWorkspaceId}, tables: { workspaces: { <id>: {
 *       path, title, sessionIds, createdAt, updatedAt } } } }
 *
 * Usage
 * -----
 *   node dsh-mobile-progress/scripts/e2e-session-control.mjs
 *
 *   E2E_WAIT_MS       wait up to this long for the endpoints to appear
 *                     (default 0 = fail fast; poll interval 10 s, max 10 min)
 *   E2E_TIMEOUT_MS    hang guard armed right before apply() (default 8000)
 *   E2E_KEEP=1        keep the temporary ledger/state directories
 *
 * Exit codes: 0 = every assertion passed (`E2E PASS`), 1 = failed or blocked.
 */

import http from 'node:http'
import net from 'node:net'
import { existsSync } from 'node:fs'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = path.resolve(HERE, '..')
const INDEX_FILE = path.join(PLUGIN_DIR, 'index.js')
const WORKSPACES_LIB = path.join(PLUGIN_DIR, 'lib', 'workspaces.js')
const CONTROL_LIB = path.join(PLUGIN_DIR, 'lib', 'session-control.js')

const TOKEN = 'e2e-token'
const PROMPT_TEXT = 'E2E: テストして'
const RESULT_TEXT = 'E2E RESULT'
const STREAM_RESULT_TEXT = 'E2E STREAM RESULT'

const WAIT_MS = nonNegative(process.env.E2E_WAIT_MS, 0)
const WATCHDOG_MS = nonNegative(process.env.E2E_TIMEOUT_MS, 8000) || 8000
const KEEP_TEMP = process.env.E2E_KEEP === '1'

/** Static markers proving the endpoints were actually wired into index.js. */
const READY_MARKERS = ['/api/workspaces', '/api/session', 'sessionController']

// ---------------------------------------------------------------------------
// Tiny utilities
// ---------------------------------------------------------------------------

function nonNegative(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : fallback
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Normalize a directory for comparison: absolute, no trailing separator, case-insensitive. */
function samePath(left, right) {
  const key = (value) => {
    if (typeof value !== 'string' || value.trim().length === 0) return ''
    let resolved = value.trim()
    try {
      resolved = path.win32.resolve(resolved)
    } catch {
      // Keep the raw string.
    }
    return resolved.replace(/[\\/]+$/, '').toLowerCase()
  }
  const a = key(left)
  return a.length > 0 && a === key(right)
}

function show(value) {
  if (value === undefined) return 'undefined'
  try {
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    return text.length > 300 ? `${text.slice(0, 300)}…` : text
  } catch {
    return String(value)
  }
}

// ---------------------------------------------------------------------------
// Assertion bookkeeping
// ---------------------------------------------------------------------------

const checks = []
const notes = []

/**
 * Record one assertion. Failures print immediately (so a crash mid-run still
 * shows them) and are counted for the final verdict.
 */
function check(id, title, ok, detail = '') {
  const passed = ok === true
  checks.push({ id, title, ok: passed })
  if (passed) {
    console.log(`  ok   ${id}  ${title}`)
  } else {
    console.error(`  FAIL ${id}  ${title}${detail ? `\n         ${detail}` : ''}`)
  }
  return passed
}

function checkEqual(id, title, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  return check(id, title, ok, ok ? '' : `expected ${show(expected)}\n         actual   ${show(actual)}`)
}

function checkStatus(id, title, response, expected) {
  return check(
    id,
    title,
    response.status === expected,
    `expected HTTP ${expected}, got ${response.status}; body ${show(response.text)}`,
  )
}

/** A soft observation: noteworthy, but not a contract violation. */
function note(id, message) {
  notes.push(`${id}: ${message}`)
}

// ---------------------------------------------------------------------------
// HTTP helpers (node:http, `agent:false` so no keep-alive socket survives)
// ---------------------------------------------------------------------------

function request(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    let target
    try {
      target = new URL(url)
    } catch (error) {
      reject(error)
      return
    }
    const payload =
      body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8')
    const requestHeaders = { ...headers }
    if (payload !== null) requestHeaders['content-length'] = String(payload.length)

    const req = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method,
        headers: requestHeaders,
        agent: false,
      },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let json = null
          try {
            json = text.trim().length === 0 ? null : JSON.parse(text)
          } catch {
            json = null
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json })
        })
        res.on('error', reject)
      },
    )
    req.setTimeout(5000, () => req.destroy(new Error(`request timeout: ${method} ${url}`)))
    req.on('error', reject)
    if (payload !== null) req.write(payload)
    req.end()
  })
}

/** `body.error` is the documented field; `body.code` is accepted as a fallback. */
function errorCode(body) {
  if (body === null || typeof body !== 'object') return ''
  const value = body.error ?? body.code ?? ''
  return typeof value === 'string' ? value : ''
}

/**
 * A minimal SSE consumer: parses `data:` frames and lets a caller wait for the
 * next frame matching a predicate. Frames that arrive before a waiter is
 * registered are kept, so the initial state frame is never lost.
 */
function openStream(url) {
  const frames = []
  let buffer = ''
  let closed = false
  const pending = new Set()

  function settle() {
    for (const waiter of [...pending]) {
      const hit = frames.slice(waiter.index).find(waiter.predicate)
      if (hit === undefined) continue
      pending.delete(waiter)
      clearTimeout(waiter.timer)
      waiter.resolve(hit)
    }
  }

  const target = new URL(url)
  const req = http.request(
    {
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: 'GET',
      headers: { accept: 'text/event-stream' },
      agent: false,
    },
    (res) => {
      res.setEncoding('utf8')
      res.on('data', (chunk) => {
        buffer += chunk
        let cut = buffer.indexOf('\n\n')
        while (cut >= 0) {
          const frame = buffer.slice(0, cut)
          buffer = buffer.slice(cut + 2)
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data:')) continue
            const raw = line.slice('data:'.length).trim()
            if (raw.length === 0) continue
            try {
              frames.push(JSON.parse(raw))
            } catch {
              // Ignore a frame we cannot parse; the next one may be fine.
            }
          }
          settle()
          cut = buffer.indexOf('\n\n')
        }
      })
      res.on('end', () => {
        closed = true
        for (const waiter of pending) {
          clearTimeout(waiter.timer)
          waiter.resolve(null)
        }
        pending.clear()
      })
    },
  )
  req.on('error', () => {
    closed = true
  })
  req.end()

  return {
    get frameCount() {
      return frames.length
    },
    get closed() {
      return closed
    },
    /** Wait for a frame at or after the current position that satisfies `predicate`. */
    waitFor(predicate, timeoutMs) {
      const existing = frames.find((frame, index) => index >= 0 && predicate(frame))
      if (existing !== undefined) return Promise.resolve(existing)
      return new Promise((resolve) => {
        const waiter = { index: frames.length, predicate, resolve, timer: null }
        waiter.timer = setTimeout(() => {
          pending.delete(waiter)
          resolve(null)
        }, timeoutMs)
        pending.add(waiter)
      })
    },
    close() {
      try {
        req.destroy()
      } catch {
        // Already closed.
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Mock Cordis context
// ---------------------------------------------------------------------------

/**
 * The smallest context `apply()` needs: tool registration, event handlers,
 * service lookups, and an effect disposer.
 */
function createContext({ cwd, sessionController }) {
  const tools = []
  const handlers = new Map()
  const disposers = []
  const services = {
    sessionController,
    systemPrompt: { section: () => () => {} },
    workingDirectory: { get: () => cwd },
    agents: { currentInitiator: () => undefined },
  }

  const ctx = {
    tools: {
      register(definition) {
        tools.push(definition)
      },
    },
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, [])
      handlers.get(event).push(handler)
    },
    get(serviceName) {
      return services[serviceName]
    },
    effect(factory) {
      const disposer = typeof factory === 'function' ? factory() : undefined
      if (typeof disposer === 'function') disposers.push(disposer)
      return disposer
    },
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
  }

  return {
    ctx,
    tools,
    handlers,
    dispose() {
      for (const disposer of disposers.splice(0)) {
        try {
          disposer()
        } catch {
          // A failing disposer must not hide the test verdict.
        }
      }
    },
    /** Call every registered handler for one event, like the Host would. */
    emit(eventName, ...args) {
      const list = handlers.get(eventName) ?? []
      for (const handler of list) handler(...args)
      return list.length
    },
  }
}

// ---------------------------------------------------------------------------
// Readiness gate
// ---------------------------------------------------------------------------

async function inspectWiring() {
  const [indexText, hasWorkspacesLib, hasControlLib] = await Promise.all([
    fsp.readFile(INDEX_FILE, 'utf8').catch(() => ''),
    fsp.access(WORKSPACES_LIB).then(() => true).catch(() => false),
    fsp.access(CONTROL_LIB).then(() => true).catch(() => false),
  ])
  const missing = []
  if (!hasWorkspacesLib) missing.push('lib/workspaces.js')
  if (!hasControlLib) missing.push('lib/session-control.js')
  for (const marker of READY_MARKERS) {
    if (!indexText.includes(marker)) missing.push(`index.js contains '${marker}'`)
  }
  if (!indexText.includes('resultState')) missing.push("index.js contains 'resultState'")
  return { missing, ready: missing.length === 0, indexText }
}

async function waitForWiring(timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let last = await inspectWiring()
  if (last.ready || timeoutMs === 0) return last
  const started = Date.now()
  while (Date.now() < deadline) {
    console.log(`  … waiting ${Math.round((Date.now() - started) / 1000)}s for the control API to land`)
    await delay(10_000)
    last = await inspectWiring()
    if (last.ready) return last
  }
  return last
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Ledger written in the Host-owned shape `lib/workspaces.js` documents. */
function ledgerFixture({ idA, idB, dirA, dirB }) {
  return {
    unit: { name: 'workspace', version: 2 },
    global: {
      initialized: true,
      defaultWorkspaceId: idB,
      workspaceIds: [idA, idB],
    },
    tables: {
      workspaces: {
        [idA]: {
          path: dirA,
          title: 'E2E Alpha',
          sessionIds: ['session-e2e-alpha-1'],
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
        [idB]: {
          path: dirB,
          title: 'E2E Beta',
          sessionIds: ['session-e2e-beta-1', 'session-e2e-beta-2'],
          createdAt: '2026-01-02T00:00:00.000Z',
          updatedAt: '2026-02-02T00:00:00.000Z',
        },
      },
    },
  }
}

/** A `sessionController` that records what the plugin asked for. */
function createFakeSessionController() {
  const created = []
  const prompts = []
  let counter = 0

  return {
    created,
    prompts,
    get sessionId() {
      return created.length === 0 ? '' : created[created.length - 1].sessionId
    },
    async create(args) {
      counter += 1
      const sessionId = `session-e2e-${Date.now()}-${counter}`
      created.push({ cwd: args?.cwd, sessionId, args })
      return { sessionId }
    },
    async prompt(args, signal) {
      prompts.push({ args, signal })
      return { ok: true }
    },
  }
}

/** Reserve a free TCP port, then release it for the plugin to bind. */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = address !== null && typeof address === 'object' ? address.port : 0
      server.close(() => (port > 0 ? resolve(port) : reject(new Error('could not reserve a port'))))
    })
  })
}

async function waitForHealth(baseUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let lastError = 'no attempt'
  while (Date.now() < deadline) {
    try {
      const response = await request(`${baseUrl}/healthz`)
      if (response.status === 200) return { ok: true, response }
      lastError = `HTTP ${response.status}`
    } catch (error) {
      lastError = String(error?.message ?? error)
    }
    await delay(50)
  }
  return { ok: false, error: lastError }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

let base = ''
let tempRoot = ''
let context = null
let stream = null
let watchdog = null
let phase = 'setup'
let finished = false

function clearWatchdog() {
  if (watchdog !== null) {
    clearTimeout(watchdog)
    watchdog = null
  }
}

async function finish(code) {
  if (finished) return
  finished = true
  clearWatchdog()
  phase = 'cleanup'
  if (stream !== null) {
    stream.close()
    stream = null
  }
  if (context !== null) {
    context.dispose()
    context = null
  }
  // Give the just-closed server a moment, then stop for certain: the explicit
  // timer keeps the loop alive briefly and guarantees the exit code.
  await delay(120)
  if (tempRoot.length > 0 && !KEEP_TEMP) {
    await fsp.rm(tempRoot, { recursive: true, force: true }).catch(() => {})
  }

  const total = checks.length
  const failed = checks.filter((item) => !item.ok)
  console.log('')
  console.log('=== assertion summary ===')
  for (const item of checks) console.log(`  ${item.ok ? 'PASS' : 'FAIL'}  ${item.id}  ${item.title}`)
  if (notes.length > 0) {
    console.log('')
    console.log('=== observations (not counted as failures) ===')
    for (const line of notes) console.log(`  - ${line}`)
  }
  console.log('')
  if (failed.length === 0 && total > 0) {
    console.log(`E2E PASS — ${total}/${total} assertions passed`)
  } else {
    console.log(`E2E FAIL — ${total - failed.length}/${total} assertions passed`)
    for (const item of failed) console.error(`  failed: ${item.id} ${item.title}`)
  }
  process.exitCode = code
  setTimeout(() => process.exit(code), 100)
}

/** A deviation that is not an assertion failure: the API is simply not there. */
async function blocked(wiring) {
  console.error('E2E BLOCKED — the session-control API is not integrated yet')
  console.error(`  index.js: ${INDEX_FILE}`)
  for (const line of wiring.missing) console.error(`  missing: ${line}`)
  console.error('  The contract cannot be exercised until the Host side lands.')
  console.error('  Re-run this script after the implementation is merged.')
  await finish(1)
}

function armWatchdog() {
  watchdog = setTimeout(() => {
    console.error(`\nE2E FAIL — watchdog fired after ${WATCHDOG_MS}ms while "${phase}" (hang guard)`)
    void finish(1)
  }, WATCHDOG_MS)
}

async function runAssertions({ ledgerPath, idA, idB, dirA, dirB, fake }) {
  const tokenQuery = `k=${encodeURIComponent(TOKEN)}`
  const stateUrl = `${base}/api/state?${tokenQuery}`
  const workspacesUrl = `${base}/api/workspaces?${tokenQuery}`
  const sessionUrl = `${base}/api/session?${tokenQuery}`

  // -- (a) token enforcement -------------------------------------------------
  phase = 'assertions: token'
  const noToken = await request(`${base}/api/workspaces`)
  checkStatus('A1', 'GET /api/workspaces without a token -> 401', noToken, 401)

  // -- (b) workspace list ----------------------------------------------------
  phase = 'assertions: workspace list'
  const listResponse = await request(workspacesUrl)
  checkStatus('B1', 'GET /api/workspaces with a token -> 200', listResponse, 200)
  const list = listResponse.json
  check('B2', 'response has ok:true', list?.ok === true, `body ${show(listResponse.text)}`)
  const workspaces = Array.isArray(list?.workspaces) ? list.workspaces : []
  check('B3', 'workspace list has exactly the two fixture entries', workspaces.length === 2,
    `ids ${show(workspaces.map((item) => item?.id))}`)
  checkEqual('B4', 'workspaces are sorted by updatedAt descending',
    workspaces.map((item) => item?.id), [idB, idA])
  check('B5', 'every workspace reports exists:true',
    workspaces.length === 2 && workspaces.every((item) => item?.exists === true),
    `exists ${show(workspaces.map((item) => item?.exists))}`)
  const shapeOk = workspaces.length === 2 && workspaces.every((item) =>
    typeof item?.id === 'string' && item.id.length > 0 &&
    typeof item?.title === 'string' && item.title.length > 0 &&
    typeof item?.path === 'string' && item.path.length > 0 &&
    typeof item?.updatedAt === 'number' && Number.isFinite(item.updatedAt) &&
    typeof item?.sessionCount === 'number')
  check('B6', 'each entry has id/title/path/updatedAt(number)/sessionCount(number)', shapeOk,
    `first entry ${show(workspaces[0])}`)
  checkEqual('B7', "sessionCount counts the ledger's sessionIds", workspaces[0]?.sessionCount, 2)
  checkEqual('B8', 'control.enabled is true', list?.control?.enabled, true)
  check('B9', 'control.available is true with a live controller', list?.control?.available === true,
    `control ${show(list?.control)}`)

  // -- (c) prompt validation -------------------------------------------------
  phase = 'assertions: validation'
  const noPrompt = await request(sessionUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: { workspaceId: idB },
  })
  checkStatus('C1', 'POST /api/session without a prompt -> 400', noPrompt, 400)
  checkEqual('C2', 'error code is prompt_required', errorCode(noPrompt.json), 'prompt_required')

  const noContentType = await request(sessionUrl, {
    method: 'POST',
    body: { workspaceId: idB, prompt: PROMPT_TEXT },
  })
  checkStatus('C3', 'POST /api/session without a JSON content-type -> 415', noContentType, 415)
  note('C3', `415 body code: ${show(errorCode(noContentType.json) || noContentType.text)}`)

  // -- (d) start a session ---------------------------------------------------
  phase = 'assertions: create session'
  const createResponse = await request(sessionUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: { workspaceId: idB, prompt: PROMPT_TEXT },
  })
  checkStatus('D1', 'POST /api/session with a prompt -> 201', createResponse, 201)
  const created = createResponse.json
  check('D2', 'response has ok:true', created?.ok === true, `body ${show(createResponse.text)}`)

  const controllerCalls = fake.created.length
  checkEqual('D3', 'sessionController.create() was called exactly once', controllerCalls, 1)
  const createdCall = fake.created[0] ?? {}
  checkEqual('D4', 'create() received the chosen workspace cwd', samePath(createdCall.cwd, dirB), true)
  check('D5', 'response session.id matches the controller-created id',
    typeof created?.session?.id === 'string' && created.session.id === createdCall.sessionId,
    `response ${show(created?.session)} / controller ${show(createdCall.sessionId)}`)
  check('D6', 'response session.short is a non-empty string',
    typeof created?.session?.short === 'string' && created.session.short.length > 0 && created.session.short.length <= 16,
    `short ${show(created?.session?.short)}`)
  checkEqual('D7', 'response session.cwd is the workspace path', samePath(created?.session?.cwd, dirB), true)
  check('D8', 'response echoes the workspace',
    created?.workspace?.id === idB && samePath(created?.workspace?.path, dirB),
    `workspace ${show(created?.workspace)}`)

  const promptCall = fake.prompts[0] ?? {}
  const promptArgs = promptCall.args ?? {}
  check('D9', 'sessionController.prompt() was called exactly once', fake.prompts.length === 1,
    `calls ${fake.prompts.length}`)
  checkEqual('D10', 'prompt targets the created session', promptArgs.sessionId, createdCall.sessionId)
  checkEqual('D11', "prompt uses mode 'queue'", promptArgs.mode, 'queue')
  check('D12', 'prompt carries the typed text as one text block',
    Array.isArray(promptArgs.content) &&
      promptArgs.content.length === 1 &&
      promptArgs.content[0]?.type === 'text' &&
      promptArgs.content[0]?.text === PROMPT_TEXT,
    `content ${show(promptArgs.content)}`)
  check('D13', 'prompt carries a requestId',
    typeof promptArgs.requestId === 'string' && promptArgs.requestId.length > 0,
    `requestId ${show(promptArgs.requestId)}`)
  check('D14', 'prompt receives an AbortSignal', promptCall.signal instanceof AbortSignal,
    `signal ${show(promptCall.signal)}`)

  // -- (e) fold the assistant result ----------------------------------------
  phase = 'assertions: assistant result'
  const sessionDescriptor = { id: createdCall.sessionId, header: { cwd: dirB } }
  const assistantContent = [
    { type: 'reasoning', text: 'internal reasoning that must not leak' },
    { type: 'text', text: RESULT_TEXT },
  ]
  const assistantEvent = {
    type: 'assistant/message',
    time: Date.now(),
    // The Host puts the payload under `data`; both placements are filled so the
    // fixture stays valid whichever member of the pair the fold reads.
    data: { content: assistantContent },
    content: assistantContent,
  }
  const subscribers = context.emit('session/event', sessionDescriptor, assistantEvent)
  check('E1', "a 'session/event' handler is registered", subscribers > 0, `handlers ${subscribers}`)

  let state = await pollState(stateUrl, (body) => body?.session?.result?.text === RESULT_TEXT, 2000)
  checkEqual('E2', 'session.result.text is the assistant text block',
    state?.json?.session?.result?.text, RESULT_TEXT)
  checkEqual('E3', "session.resultState is 'ready'", state?.json?.session?.resultState, 'ready')
  note('E3', `result object: ${show(state?.json?.session?.result)}`)

  // -- (f) a new user message clears the result ------------------------------
  phase = 'assertions: result reset'
  const userContent = [{ type: 'text', text: 'E2E: 続けて' }]
  context.emit('session/event', sessionDescriptor, {
    type: 'user/message',
    time: Date.now(),
    data: { content: userContent },
    content: userContent,
  })
  state = await pollState(stateUrl, (body) => body?.session?.resultState === 'none', 2000)
  checkEqual('F1', 'user/message clears session.result to null', state?.json?.session?.result, null)
  checkEqual('F2', "session.resultState returns to 'none'", state?.json?.session?.resultState, 'none')

  // -- (g) the same fold over SSE -------------------------------------------
  phase = 'assertions: sse'
  stream = openStream(`${base}/api/stream?${tokenQuery}`)
  const initialFrame = await stream.waitFor(() => true, 4000)
  check('G1', 'SSE sends an initial state frame', initialFrame !== null && initialFrame?.ok === true,
    initialFrame === null ? 'no data frame within 4s' : `frame ${show(initialFrame)}`)

  const streamed = stream.waitFor((frame) => frame?.session?.result?.text === STREAM_RESULT_TEXT, 5000)
  const streamContent = [
    { type: 'reasoning', text: 'reasoning stays out of the stream result' },
    { type: 'text', text: STREAM_RESULT_TEXT },
  ]
  context.emit('session/event', sessionDescriptor, {
    type: 'assistant/message',
    time: Date.now(),
    data: { content: streamContent },
    content: streamContent,
  })
  const pushed = await streamed
  check('G2', 'SSE pushes the folded result after assistant/message', pushed !== null,
    pushed === null ? 'no matching data frame within 5s' : '')
  checkEqual('G3', 'the pushed frame carries the same result text',
    pushed?.session?.result?.text, STREAM_RESULT_TEXT)

  // Sanity: the ledger we wrote is the one the API read (guards a silent fallback
  // to the real Host ledger, which would make B3/B4 meaningless).
  const onDisk = JSON.parse(await fsp.readFile(ledgerPath, 'utf8'))
  check('H1', 'the fixture ledger still holds both workspaces',
    Object.keys(onDisk?.tables?.workspaces ?? {}).length === 2,
    `keys ${show(Object.keys(onDisk?.tables?.workspaces ?? {}))}`)
  note('H1', `fixture dirs: ${show({ dirA, dirB })}`)
}

async function pollState(url, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    try {
      last = await request(url)
    } catch (error) {
      last = { status: 0, text: String(error?.message ?? error), json: null }
    }
    if (last.json !== null && predicate(last.json)) return last
    await delay(50)
  }
  return last
}

async function main() {
  console.log('dsh-mobile-progress — E2E: phone session control')

  // 1. Wait (optionally) for the implementation to land, then fail informatively.
  const wiring = await waitForWiring(WAIT_MS)
  if (!wiring.ready) {
    await blocked(wiring)
    return
  }

  // 2. Temporary ledger + two real directories (exists:true comes from disk).
  tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-mobile-e2e-'))
  const storeDir = path.join(tempRoot, 'store')
  const dirA = path.join(tempRoot, 'ws-alpha')
  const dirB = path.join(tempRoot, 'ws-beta')
  await Promise.all([
    fsp.mkdir(storeDir, { recursive: true }),
    fsp.mkdir(dirA, { recursive: true }),
    fsp.mkdir(dirB, { recursive: true }),
  ])
  const idA = 'e2e-ws-alpha'
  const idB = 'e2e-ws-beta'
  const ledgerPath = path.join(tempRoot, 'workspace.json')
  await fsp.writeFile(ledgerPath, `${JSON.stringify(ledgerFixture({ idA, idB, dirA, dirB }), null, 2)}\n`, 'utf8')

  // 3. Fake host services.
  const fake = createFakeSessionController()
  context = createContext({ cwd: dirB, sessionController: fake })

  // 4. Import the plugin only now: a transient syntax error while the
  //    implementation is edited must read as "not integrated", not a crash.
  let apply
  try {
    const module = await import(pathToFileURL(INDEX_FILE).href)
    apply = module.apply
  } catch (error) {
    console.error(`E2E BLOCKED — index.js could not be imported: ${String(error?.message ?? error)}`)
    await finish(1)
    return
  }
  if (typeof apply !== 'function') {
    console.error('E2E BLOCKED — index.js does not export apply()')
    await finish(1)
    return
  }

  // 5. Boot the plugin on a reserved port.
  phase = 'boot'
  armWatchdog()
  const port = await freePort()
  base = `http://127.0.0.1:${port}`
  apply(context.ctx, {
    enabled: true,
    port,
    host: '127.0.0.1',
    accessToken: TOKEN,
    persist: false,
    storeDir,
    tunnel: false,
    keepAwake: false,
    control: {
      enabled: true,
      workspacesFile: ledgerPath,
      maxPromptChars: 8000,
      resultMaxChars: 4000,
    },
  })

  phase = 'waiting for /healthz'
  const health = await waitForHealth(base, 10_000)
  if (!health.ok) {
    check('A0', 'GET /healthz answers 200 within 10s', false, `last error: ${show(health.error)}`)
    await finish(1)
    return
  }
  check('A0', 'GET /healthz answers 200 within 10s', true)

  // The plugin walks port+1 on EADDRINUSE; follow it if that happened.
  const stateProbe = await request(`${base}/api/state?k=${encodeURIComponent(TOKEN)}`)
  const actualPort = stateProbe?.json?.server?.port
  if (typeof actualPort === 'number' && actualPort > 0 && actualPort !== port) {
    note('A0', `plugin bound port ${actualPort}, not the reserved ${port}; following it`)
    base = `http://127.0.0.1:${actualPort}`
  }

  // 6. Contract assertions.
  await runAssertions({ ledgerPath, idA, idB, dirA, dirB, fake })

  const failed = checks.filter((item) => !item.ok).length
  await finish(failed === 0 ? 0 : 1)
}

main().catch(async (error) => {
  console.error(`E2E FAIL — unhandled error while "${phase}": ${String(error?.stack ?? error)}`)
  await finish(1)
})

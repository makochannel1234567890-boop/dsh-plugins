/**
 * End-to-end tests for the phone's session-control API.
 *
 * `apply()` is started against a mock Harness context on a real HTTP port, and
 * every assertion goes through `fetch`, so the routing, the auth gate, the
 * error ordering and the SSE/state fold are all exercised as the phone would.
 *
 * The session controller is a fake: what matters here is the contract with
 * `index.js` (which cwd it creates, what it is prompted with), not the Host.
 */

import test_ from 'node:test'
import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

import { apply } from '../index.js'

/**
 * Every case runs on a real socket, so each gets a budget: a server that never
 * answers must fail the test instead of hanging the suite.
 */
function test(name, fn) {
  test_(name, { timeout: 15_000 }, fn)
}

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

/** Ask the OS for a port that is free right now. */
async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

async function makeTempDir() {
  return await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-mp-control-'))
}

/** The Host's ledger shape, from the fields a test cares about. */
function ledgerText(entries) {
  const workspaces = {}
  for (const entry of entries) {
    workspaces[entry.id] = {
      path: entry.path,
      title: entry.title,
      sessionIds: entry.sessionIds ?? [],
      createdAt: entry.updatedAt,
      updatedAt: entry.updatedAt,
    }
  }
  return JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    global: { defaultWorkspaceId: entries[0]?.id ?? null, workspaceIds: entries.map((entry) => entry.id) },
    tables: { workspaces },
  })
}

/** A fake `sessionController` that records exactly what it was asked to do. */
function fakeController({ sessionId = 'session-test-1', onCreate, onPrompt } = {}) {
  const calls = { created: [], prompted: [] }
  return {
    calls,
    async create(request) {
      calls.created.push(request)
      if (typeof onCreate === 'function') return await onCreate(request)
      return { sessionId }
    },
    async prompt(request, signal) {
      calls.prompted.push({ request, signal })
      if (typeof onPrompt === 'function') return await onPrompt(request, signal)
      return undefined
    },
  }
}

/** Poll `/healthz` until the plugin answers; the port can shift by a few. */
async function waitForServer(port, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    for (let offset = 0; offset < 12; offset += 1) {
      const candidate = port + offset
      try {
        const response = await fetch(`http://127.0.0.1:${candidate}/healthz`)
        if (response.ok) {
          await response.arrayBuffer()
          return candidate
        }
      } catch {
        // Not listening (yet).
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
  throw new Error(`dsh-mobile-progress did not start near port ${port}`)
}

/**
 * Start the plugin exactly as the Host would, and return a tiny HTTP client.
 *
 * `controller` is read on every `ctx.get('sessionController')` call, so a test
 * can swap or drop the service between requests.
 */
async function startPlugin({ config = {}, controller = fakeController(), ledger } = {}) {
  const port = await freePort()
  const storeDir = await makeTempDir()
  const workspacesFile = path.join(storeDir, 'workspace.json')
  if (ledger !== undefined) await fsp.writeFile(workspacesFile, ledger, 'utf8')

  const handlers = new Map()
  const disposers = []
  let currentController = controller
  /** Services that appear after `apply()`; `provide()` adds them. */
  const lateServices = new Map()
  const injections = []

  function runInjectable(pending) {
    if (pending.done) return
    if (!pending.names.every((name) => ctx.get(name) !== undefined)) return
    pending.done = true
    // Cordis also exposes each injected service as a property of the scope.
    const scope = Object.create(ctx)
    for (const name of pending.names) {
      Object.defineProperty(scope, name, { value: ctx.get(name), configurable: true })
    }
    pending.body(scope, undefined)
  }

  const ctx = {
    tools: { register: () => () => {} },
    on(event, handler) {
      handlers.set(event, handler)
      return () => handlers.delete(event)
    },
    get(name) {
      if (lateServices.has(name)) return lateServices.get(name)
      if (name === 'systemPrompt') return { section: () => () => undefined }
      if (name === 'workingDirectory') return { get: () => storeDir }
      if (name === 'agents') return { currentInitiator: () => undefined }
      if (name === 'sessionController') return currentController
      return undefined
    },
    effect(factory) {
      const disposer = factory()
      disposers.push(disposer)
      return disposer
    },
    /**
     * Cordis `ctx.inject(deps, body)`: the body waits until its services exist.
     * A service added later runs it then — the behaviour the sidebar bridge
     * depends on, because the Web server composes in parallel with the plugin.
     */
    inject(deps, body) {
      const pending = {
        names: Array.isArray(deps) ? deps : Object.keys(deps ?? {}),
        body,
        done: false,
      }
      injections.push(pending)
      runInjectable(pending)
      return () => {}
    },
    logger: { warn: () => {} },
  }

  apply(ctx, {
    enabled: true,
    port,
    host: '127.0.0.1',
    accessToken: '',
    title: 'dsh-mobile-progress test',
    autoClaim: false,
    persist: false,
    storeDir,
    // The tunnel default is on, and a public tunnel force-generates an access
    // token; a test must stay offline and token-free unless it asks for one.
    tunnel: false,
    keepAwake: false,
    control: { enabled: true, workspacesFile },
    ...config,
  })

  const actualPort = await waitForServer(port)
  const base = `http://127.0.0.1:${actualPort}`

  async function request(pathname, { method = 'GET', headers = {}, body } = {}) {
    const init = { method, headers }
    if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body)
    const response = await fetch(`${base}${pathname}`, init)
    const text = await response.text()
    let json
    try {
      json = JSON.parse(text)
    } catch {
      json = undefined
    }
    return { status: response.status, headers: response.headers, text, json }
  }

  return {
    base,
    storeDir,
    workspacesFile,
    handlers,
    request,
    get: (pathname, options) => request(pathname, options),
    post: (pathname, body, headers = { 'content-type': 'application/json' }) =>
      request(pathname, { method: 'POST', body, headers }),
    setController(next) {
      currentController = next
    },
    /** Add a service that was not available while `apply()` ran. */
    provide(name, service) {
      lateServices.set(name, service)
      for (const pending of injections) runInjectable(pending)
    },
    /** Dispatch a Host session event for the tracked session. */
    emit(sessionId, event) {
      handlers.get('session/event')?.({ id: sessionId, header: { cwd: storeDir } }, event)
    },
    async close() {
      for (const disposer of disposers) {
        try {
          disposer()
        } catch {
          // The server may already be closed.
        }
      }
      await fsp.rm(storeDir, { recursive: true, force: true }).catch(() => {})
    },
  }
}

// ---------------------------------------------------------------------------
// static surface & auth
// ---------------------------------------------------------------------------

test('healthz and the app shell stay public', async (t) => {
  const app = await startPlugin()
  t.after(() => app.close())

  const health = await app.get('/healthz')
  assert.equal(health.status, 200)
  assert.equal(health.json.ok, true)

  const shell = await app.get('/')
  assert.equal(shell.status, 200)
  assert.match(shell.headers.get('content-type') ?? '', /text\/html/)
})

test('every /api/ endpoint requires the access token', async (t) => {
  const app = await startPlugin({ config: { accessToken: 'sekret' } })
  t.after(() => app.close())

  for (const pathname of ['/api/state', '/api/workspaces', '/api/stream']) {
    const denied = await app.get(pathname)
    assert.equal(denied.status, 401, pathname)
    assert.equal(denied.json.ok, false)
  }

  const header = await app.get('/api/state', { headers: { 'x-progress-token': 'sekret' } })
  assert.equal(header.status, 200)
  const query = await app.get('/api/state?k=sekret')
  assert.equal(query.status, 200)

  // The shell still loads without the token, or the page could never ask.
  const shell = await app.get('/')
  assert.equal(shell.status, 200)
})

// ---------------------------------------------------------------------------
// GET /api/workspaces
// ---------------------------------------------------------------------------

test('GET /api/workspaces lists the ledger newest first with exists flags', async (t) => {
  const tmp = await makeTempDir()
  const realDir = path.join(tmp, 'real-workspace')
  await fsp.mkdir(realDir, { recursive: true })
  const missingDir = path.join(tmp, 'gone-workspace')

  const ledger = ledgerText([
    { id: 'older', title: '古い方', path: realDir, updatedAt: '2026-01-02T03:04:05.000Z', sessionIds: ['a'] },
    { id: 'newer', title: '', path: missingDir, updatedAt: '2026-05-06T07:08:09.000Z', sessionIds: ['a', 'b', 'c'] },
  ])
  const app = await startPlugin({ ledger })
  t.after(async () => {
    await app.close()
    await fsp.rm(tmp, { recursive: true, force: true })
  })

  const response = await app.get('/api/workspaces')
  assert.equal(response.status, 200)
  assert.equal(response.json.ok, true)
  assert.equal(response.json.workspaces.length, 2)

  const [first, second] = response.json.workspaces
  assert.equal(first.id, 'newer', 'newest updatedAt first')
  assert.equal(first.title, 'gone-workspace', 'an untitled workspace falls back to its folder')
  assert.equal(first.path, missingDir)
  assert.equal(first.exists, false)
  assert.equal(first.sessionCount, 3)
  assert.equal(typeof first.updatedAt, 'number')

  assert.equal(second.id, 'older')
  assert.equal(second.exists, true)
  assert.equal(second.sessionCount, 1)

  assert.deepEqual(response.json.control, { enabled: true, available: true, error: '' })
})

test('a broken ledger still answers 200 with an error instead of 500', async (t) => {
  const tmp = await makeTempDir()
  const app = await startPlugin({
    config: { control: { workspacesFile: path.join(tmp, 'missing', 'workspace.json') } },
  })
  t.after(async () => {
    await app.close()
    await fsp.rm(tmp, { recursive: true, force: true })
  })

  // No ledger file: the page still has to render, so the list is empty and
  // `error` explains why instead of the API failing with a 500.
  const missing = await app.get('/api/workspaces')
  assert.equal(missing.status, 200)
  assert.equal(missing.json.ok, true)
  assert.deepEqual(missing.json.workspaces, [])
  assert.equal(missing.json.control.error, 'not_found')

  // A directory is not a ledger either: same 200, different reason.
  const asDirectory = await startPlugin({
    config: { control: { workspacesFile: tmp } },
  })
  t.after(() => asDirectory.close())
  const unreadable = await asDirectory.get('/api/workspaces')
  assert.equal(unreadable.status, 200)
  assert.deepEqual(unreadable.json.workspaces, [])
  assert.equal(unreadable.json.control.error, 'read_failed')
})

test('GET /api/state exposes the result slot and the control summary', async (t) => {
  const app = await startPlugin({
    ledger: ledgerText([{ id: 'w1', title: 'W', path: os.tmpdir(), updatedAt: '2026-01-01T00:00:00.000Z' }]),
  })
  t.after(() => app.close())

  const list = await app.get('/api/workspaces')
  assert.equal(list.status, 200)

  const response = await app.get('/api/state')
  assert.equal(response.status, 200)
  assert.equal(response.json.session, null)
  assert.deepEqual(response.json.server.control, { enabled: true, available: true, workspaces: 1 })
})

// ---------------------------------------------------------------------------
// POST /api/session — request validation
// ---------------------------------------------------------------------------

test('POST /api/session rejects a non-JSON content type', async (t) => {
  const app = await startPlugin({ ledger: ledgerText([]) })
  t.after(() => app.close())

  const plain = await app.request('/api/session', {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: 'prompt=x',
  })
  assert.equal(plain.status, 415)
  assert.equal(plain.json.error, 'unsupported_media_type')

  const missing = await app.request('/api/session', { method: 'POST', body: '{}' })
  assert.equal(missing.status, 415)
})

test('POST /api/session rejects an oversized body', async (t) => {
  const app = await startPlugin({ ledger: ledgerText([]) })
  t.after(() => app.close())

  const response = await app.post('/api/session', {
    workspaceId: 'w1',
    prompt: 'あ'.repeat(40_000),
  })
  assert.equal(response.status, 413)
  assert.equal(response.json.error, 'payload_too_large')
})

test('POST /api/session requires a prompt and caps its length', async (t) => {
  const controller = fakeController()
  const app = await startPlugin({
    controller,
    ledger: ledgerText([{ id: 'w1', title: 'W', path: os.tmpdir(), updatedAt: '2026-01-01T00:00:00.000Z' }]),
    config: { control: { maxPromptChars: 20 } },
  })
  t.after(() => app.close())

  const empty = await app.post('/api/session', { workspaceId: 'w1', prompt: '   ' })
  assert.equal(empty.status, 400)
  assert.equal(empty.json.error, 'prompt_required')

  const long = await app.post('/api/session', { workspaceId: 'w1', prompt: 'x'.repeat(21) })
  assert.equal(long.status, 400)
  assert.equal(long.json.error, 'prompt_too_long')

  assert.equal(controller.calls.created.length, 0, 'nothing is created for an invalid prompt')
})

test('POST /api/session honours control.enabled', async (t) => {
  const controller = fakeController()
  const app = await startPlugin({
    controller,
    ledger: ledgerText([{ id: 'w1', title: 'W', path: os.tmpdir(), updatedAt: '2026-01-01T00:00:00.000Z' }]),
    config: { control: { enabled: false } },
  })
  t.after(() => app.close())

  const response = await app.post('/api/session', { workspaceId: 'w1', prompt: 'hello' })
  assert.equal(response.status, 403)
  assert.equal(response.json.error, 'control_disabled')
  assert.equal(controller.calls.created.length, 0)
})

test('POST /api/session resolves the workspace id, or an exact cwd', async (t) => {
  const controller = fakeController()
  const app = await startPlugin({
    controller,
    ledger: ledgerText([{ id: 'w1', title: 'W', path: os.tmpdir(), updatedAt: '2026-01-01T00:00:00.000Z' }]),
  })
  t.after(() => app.close())

  const none = await app.post('/api/session', { prompt: 'hello' })
  assert.equal(none.status, 400)
  assert.equal(none.json.error, 'workspace_required')

  const unknownId = await app.post('/api/session', { workspaceId: 'nope', prompt: 'hello' })
  assert.equal(unknownId.status, 400)
  assert.equal(unknownId.json.error, 'workspace_not_found')

  const unknownCwd = await app.post('/api/session', { cwd: path.join(os.tmpdir(), 'not-in-ledger'), prompt: 'hello' })
  assert.equal(unknownCwd.status, 400)
  assert.equal(unknownCwd.json.error, 'workspace_not_found')
  assert.equal(controller.calls.created.length, 0)
})

test('POST /api/session reports a missing sessionController as 503', async (t) => {
  const app = await startPlugin({
    // `null`, not `undefined`: the helper's default parameter would otherwise
    // install a fake controller.
    controller: null,
    ledger: ledgerText([{ id: 'w1', title: 'W', path: os.tmpdir(), updatedAt: '2026-01-01T00:00:00.000Z' }]),
  })
  t.after(() => app.close())

  const response = await app.post('/api/session', { workspaceId: 'w1', prompt: 'hello' })
  assert.equal(response.status, 503)
  assert.equal(response.json.error, 'session_control_unavailable')

  const workspaces = await app.get('/api/workspaces')
  assert.equal(workspaces.json.control.available, false)
})

// ---------------------------------------------------------------------------
// POST /api/session — the happy path, then the result fold
// ---------------------------------------------------------------------------

test('POST /api/session creates and prompts a session in the chosen workspace', async (t) => {
  const workspacePath = await makeTempDir()
  const controller = fakeController({ sessionId: 'session-phone-1234567890' })
  const app = await startPlugin({
    controller,
    ledger: ledgerText([{ id: 'w1', title: 'My Workspace', path: workspacePath, updatedAt: '2026-01-01T00:00:00.000Z' }]),
  })
  t.after(async () => {
    await app.close()
    await fsp.rm(workspacePath, { recursive: true, force: true })
  })

  const response = await app.post('/api/session', {
    workspaceId: 'w1',
    prompt: '  ログイン画面を直して\nついでにテストも  ',
  })
  assert.equal(response.status, 201)
  assert.equal(response.json.ok, true)
  assert.equal(response.json.session.id, 'session-phone-1234567890')
  assert.equal(response.json.session.short, 'phone-12')
  assert.equal(response.json.session.cwd, workspacePath)
  assert.deepEqual(response.json.workspace, { id: 'w1', title: 'My Workspace', path: workspacePath })

  assert.equal(controller.calls.created.length, 1)
  assert.deepEqual(controller.calls.created[0], { cwd: workspacePath })

  const { request, signal } = controller.calls.prompted[0]
  assert.equal(request.sessionId, 'session-phone-1234567890')
  assert.equal(request.mode, 'queue')
  assert.deepEqual(request.content, [{ type: 'text', text: 'ログイン画面を直して\nついでにテストも' }])
  assert.match(request.requestId, /^mobile-\d+-session-phone-1234567890$/)
  assert.equal(typeof request.clientTimeZone, 'string')
  assert.ok(signal instanceof AbortSignal, 'prompt receives an abortable signal')

  const state = await app.get('/api/state')
  assert.equal(state.json.session.id, 'session-phone-1234567890')
  assert.equal(state.json.session.status, 'working')
  assert.equal(state.json.session.agentRunning, true)
  assert.equal(state.json.session.title, 'ログイン画面を直して')
  assert.equal(state.json.session.request, 'ログイン画面を直して\nついでにテストも')
  assert.equal(state.json.session.result, null)
  assert.equal(state.json.session.resultState, 'none')
  assert.equal(state.json.session.cwdName, path.basename(workspacePath))
  assert.ok(state.json.session.logs.some((entry) => entry.text.includes('スマホから依頼を送信')))
})

test('the assistant answer is folded into the state and cleared by the next request', async (t) => {
  const workspacePath = await makeTempDir()
  const app = await startPlugin({
    controller: fakeController({ sessionId: 'session-fold-1' }),
    ledger: ledgerText([{ id: 'w1', title: 'W', path: workspacePath, updatedAt: '2026-01-01T00:00:00.000Z' }]),
  })
  t.after(async () => {
    await app.close()
    await fsp.rm(workspacePath, { recursive: true, force: true })
  })

  const created = await app.post('/api/session', { workspaceId: 'w1', prompt: 'result please' })
  assert.equal(created.status, 201)

  app.emit('session-fold-1', {
    type: 'assistant/message',
    time: Date.now(),
    data: {
      turn: 2,
      step: 1,
      message: {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'internal thinking' },
          { type: 'text', text: '直しました。' },
          { type: 'text', text: 'テストは 12/12 PASS です。' },
        ],
      },
    },
  })

  const ready = await app.get('/api/state')
  assert.equal(ready.json.session.resultState, 'ready')
  assert.equal(ready.json.session.result.text, '直しました。\n\nテストは 12/12 PASS です。')
  assert.equal(ready.json.session.result.turn, 2)
  assert.equal(ready.json.session.result.truncated, false)
  assert.equal(ready.json.session.result.chars, [...ready.json.session.result.text].length)
  assert.equal(typeof ready.json.session.result.at, 'number')

  // A new user turn invalidates the previous answer.
  app.emit('session-fold-1', {
    type: 'user/message',
    time: Date.now(),
    data: { content: [{ type: 'text', text: 'もう一つ直して' }] },
  })
  const cleared = await app.get('/api/state')
  assert.equal(cleared.json.session.result, null)
  assert.equal(cleared.json.session.resultState, 'none')
})

test('an assistant message with no visible text does not become the result', async (t) => {
  const workspacePath = await makeTempDir()
  const app = await startPlugin({
    controller: fakeController({ sessionId: 'session-fold-2' }),
    ledger: ledgerText([{ id: 'w1', title: 'W', path: workspacePath, updatedAt: '2026-01-01T00:00:00.000Z' }]),
  })
  t.after(async () => {
    await app.close()
    await fsp.rm(workspacePath, { recursive: true, force: true })
  })

  await app.post('/api/session', { workspaceId: 'w1', prompt: 'no text answer' })
  app.emit('session-fold-2', {
    type: 'assistant/message',
    time: Date.now(),
    data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'reasoning', text: 'thinking only' }] } },
  })

  const state = await app.get('/api/state')
  assert.equal(state.json.session.result, null)
  assert.equal(state.json.session.resultState, 'none')
})

test('a failing sessionController is reported as 502 without leaking details', async (t) => {
  const workspacePath = await makeTempDir()
  const controller = fakeController({
    onCreate: async () => {
      throw new Error('internal host path C:\\secret\\thing failed')
    },
  })
  const app = await startPlugin({
    controller,
    ledger: ledgerText([{ id: 'w1', title: 'W', path: workspacePath, updatedAt: '2026-01-01T00:00:00.000Z' }]),
  })
  t.after(async () => {
    await app.close()
    await fsp.rm(workspacePath, { recursive: true, force: true })
  })

  const response = await app.post('/api/session', { workspaceId: 'w1', prompt: 'hello' })
  assert.equal(response.status, 502)
  assert.equal(response.json.error, 'session_create_failed')
  assert.doesNotMatch(JSON.stringify(response.json), /secret/)
})

// ---------------------------------------------------------------------------
// methods
// ---------------------------------------------------------------------------

test('only POST is allowed on /api/session, and only reads elsewhere', async (t) => {
  const app = await startPlugin({ ledger: ledgerText([]) })
  t.after(() => app.close())

  const getSession = await app.get('/api/session')
  assert.equal(getSession.status, 405)
  assert.equal(getSession.headers.get('allow'), 'POST')

  const postState = await app.post('/api/state', {})
  assert.equal(postState.status, 405)
  assert.equal(postState.headers.get('allow'), 'GET, HEAD')
})

// ---------------------------------------------------------------------------
// sidebar bridge
// ---------------------------------------------------------------------------

test('the sidebar bridge mounts even when the Web server appears after apply()', async (t) => {
  const app = await startPlugin()
  t.after(() => app.close())

  // A composition without a Web server (TUI) has no panel; that is not an error.
  const before = await app.get('/api/state')
  assert.equal(before.json.server.bridge.mounted, false, 'nothing to mount yet')

  // The Host composes the Web server in parallel with its plugins, so the
  // service usually exists only after apply() has returned. Resolving it once,
  // synchronously, skipped the mount in silence: the panel then printed
  // 「トンネル未接続」 while the phone feed and its tunnel were healthy.
  const routes = []
  app.provide('webServer', {
    register(route) {
      routes.push(route)
      return () => {
        const index = routes.indexOf(route)
        if (index >= 0) routes.splice(index, 1)
      }
    },
  })

  assert.equal(routes.length, 1, 'exactly one bridge route')
  assert.equal(routes[0].kind, 'prefix')
  assert.equal(routes[0].path, '/mobile-progress-api')
  assert.equal(typeof routes[0].handler, 'function')

  const after = await app.get('/api/state')
  assert.equal(after.json.server.bridge.mounted, true)
  assert.equal(after.json.server.bridge.path, '/mobile-progress-api')
  assert.equal(after.json.server.bridge.error, '')
})


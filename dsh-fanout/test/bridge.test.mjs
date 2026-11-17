/**
 * bridge.test.mjs — loopback HTTP carrier in `lib/bridge.js`.
 *
 * Only localhost networking is used. The bridge binds to `config.bridgePort`
 * (DESIGN default 51337); this test uses a fixed free-ish port, 51999, so it
 * never collides with a running Harness bridge. Override if the machine already
 * needs 51999:
 *
 *   FANOUT_TEST_PORT=52001 node bridge.test.mjs
 *
 * Requests deliberately send `connection: close` so `bridge.stop()` (which is
 * `server.close()`) settles immediately instead of depending on idle keep-alive
 * sockets; nothing else is left listening when the file finishes.
 *
 * Plain ESM + node:assert/strict. Run with: node bridge.test.mjs
 */
import assert from 'node:assert/strict'
import http from 'node:http'

import { FRONT_PREFIX, startBridge } from '../lib/bridge.js'

const TEST_PORT = Number(process.env.FANOUT_TEST_PORT ?? 51999)
const ORIGIN = 'http://127.0.0.1:58507'

let checks = 0
const failures = []
const logs = []

function log(message) {
  logs.push(String(message))
}

/** One HTTP request against the bridge; JSON-only, connection: close. */
function call(method, requestPath, options = {}) {
  const { token, body, rawBody, origin } = options
  return new Promise((resolve, reject) => {
    const payload = rawBody !== undefined ? rawBody : body === undefined ? undefined : JSON.stringify(body)
    const headers = { connection: 'close' }
    if (token !== undefined) headers['x-fanout-token'] = token
    if (origin !== undefined) headers.origin = origin
    if (payload !== undefined) {
      headers['content-type'] = 'application/json'
      headers['content-length'] = Buffer.byteLength(payload)
    }
    const request = http.request(
      { host: '127.0.0.1', port: TEST_PORT, path: requestPath, method, headers, agent: false },
      (response) => {
        let text = ''
        response.setEncoding('utf8')
        response.on('data', (chunk) => {
          text += chunk
        })
        response.on('end', () => {
          let parsed
          if (text.length > 0) {
            try {
              parsed = JSON.parse(text)
            } catch {
              parsed = { __unparsed: text }
            }
          }
          resolve({ status: response.statusCode ?? 0, headers: response.headers, body: parsed, raw: text })
        })
      },
    )
    request.on('error', reject)
    request.setTimeout(5000, () => request.destroy(new Error(`timeout ${method} ${requestPath}`)))
    if (payload !== undefined) request.write(payload)
    request.end()
  })
}

async function check(name, fn) {
  try {
    await fn()
    checks += 1
    console.log(`ok  bridge · ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.error(`FAIL bridge · ${name}`)
    console.error(error instanceof Error ? error.stack : String(error))
  }
}

function withTimeout(promise, ms, label) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

// ---------------------------------------------------------------------------
// Fakes: the bridge only needs these four engine methods and three store calls.
// ---------------------------------------------------------------------------

const persisted = { config: undefined, bridge: undefined, configWrites: [], bridgeWrites: [] }

const store = {
  async loadConfig() {
    return persisted.config
  },
  async saveConfig(value) {
    persisted.config = value
    persisted.configWrites.push(value)
  },
  async saveBridge(value) {
    persisted.bridge = value
    persisted.bridgeWrites.push(value)
  },
}

const engine = {
  state: { uiCalls: 0, starts: [], stops: [] },
  // Same object identity as the bridge config, exactly like index.js does.
  config: undefined,
  uiState() {
    engine.state.uiCalls += 1
    return {
      runs: [
        {
          run_id: 'run-fake-1',
          status: 'running',
          total: 2,
          settled: 0,
          failed: 0,
          updated_at: new Date(0).toISOString(),
          objective: 'fake objective',
          estimate_tokens: 1234,
        },
      ],
      active_run_id: 'run-fake-1',
    }
  },
  async start(request, caller) {
    engine.state.starts.push({ request, caller })
    return {
      run_id: 'run-fake-1',
      workers: [{ session_id: 'sess-1', task_ids: ['t1'], weight: 1, state: 'running' }],
    }
  },
  async stop(runId, reason) {
    engine.state.stops.push({ runId, reason })
    return { run_id: runId ?? 'run-fake-1', status: 'stopped', cancelled: ['sess-1'] }
  },
}

const config = {
  bridgePort: TEST_PORT,
  maxWorkers: 3,
  defaultWorkers: 2,
  maxExpansion: 100,
  defaultExpansion: 40,
  resultDigestChars: 1200,
}
engine.config = config

const watchdog = setTimeout(() => {
  console.error('FAIL bridge · watchdog: still running after 30s (dangling server?)')
  process.exit(1)
}, 30000)
watchdog.unref()

let bridge

try {
  try {
    bridge = await startBridge({ engine, store, config, log })
  } catch (error) {
    throw new Error(
      `startBridge failed on 127.0.0.1:${TEST_PORT} (${error?.code ?? 'error'}): ${error?.message ?? error}. ` +
        'Set FANOUT_TEST_PORT to a free port if 51999 is taken.',
    )
  }

  await check('startBridge returns port/token/handler/stop and persists bridge.json', async () => {
    assert.equal(bridge.port, TEST_PORT)
    assert.equal(typeof bridge.token, 'string')
    assert.ok(bridge.token.length > 0)
    assert.equal(typeof bridge.handler, 'function')
    assert.equal(typeof bridge.stop, 'function')
    assert.equal(persisted.bridgeWrites.length, 1)
    assert.equal(persisted.bridge.port, TEST_PORT)
    assert.equal(persisted.bridge.token, bridge.token)
    assert.equal(typeof persisted.bridge.startedAt, 'number')
  })

  await check('GET /health needs no token and returns the bridge token', async () => {
    const response = await call('GET', '/health')
    assert.equal(response.status, 200)
    assert.match(response.headers['content-type'], /application\/json/)
    assert.equal(response.body.ok, true)
    assert.equal(response.body.token, bridge.token)
    assert.equal(typeof response.body.version, 'number')
    assert.equal(response.body.port, TEST_PORT)
  })

  await check('GET /state without x-fanout-token is 401', async () => {
    const response = await call('GET', '/state')
    assert.equal(response.status, 401)
    assert.equal(response.body.ok, false)
    assert.equal(response.body.error, 'unauthorized')
  })

  await check('GET /state with a wrong token is 401', async () => {
    const response = await call('GET', '/state', { token: 'not-the-token' })
    assert.equal(response.status, 401)
    assert.equal(response.body.ok, false)
  })

  await check('GET /state with the token returns config + engine.uiState()', async () => {
    const response = await call('GET', '/state', { token: bridge.token })
    assert.equal(response.status, 200)
    assert.equal(response.body.ok, true)
    assert.deepEqual(response.body.config, { workers: 2, expansion: 40 })
    assert.ok(Array.isArray(response.body.runs))
    assert.equal(response.body.runs.length, 1)
    assert.equal(response.body.runs[0].run_id, 'run-fake-1')
    assert.equal(response.body.active_run_id, 'run-fake-1')
    assert.ok(engine.state.uiCalls >= 1)
  })

  await check(`routes also work under the same-origin prefix ${FRONT_PREFIX}`, async () => {
    const health = await call('GET', `${FRONT_PREFIX}/health`)
    assert.equal(health.status, 200)
    assert.equal(health.body.token, bridge.token)
    const state = await call('GET', `${FRONT_PREFIX}/state`, { token: bridge.token })
    assert.equal(state.status, 200)
    assert.equal(state.body.ok, true)
  })

  await check('OPTIONS preflight for a loopback origin is 204 with CORS headers', async () => {
    const response = await call('OPTIONS', '/state', { origin: ORIGIN })
    assert.equal(response.status, 204)
    assert.equal(response.headers['access-control-allow-origin'], ORIGIN)
    assert.match(response.headers['access-control-allow-methods'], /POST/)
    assert.match(response.headers['access-control-allow-headers'], /x-fanout-token/i)
  })

  await check('POST /start without objective is 400 and never reaches the engine', async () => {
    const missing = await call('POST', '/start', { token: bridge.token, body: { tasks: [] } })
    assert.equal(missing.status, 400)
    assert.equal(missing.body.ok, false)
    assert.match(missing.body.error, /objective/i)

    const blank = await call('POST', '/start', { token: bridge.token, body: { objective: '   ' } })
    assert.equal(blank.status, 400)
    assert.equal(blank.body.ok, false)
    assert.equal(engine.state.starts.length, 0)
  })

  await check('POST /start forwards a trimmed objective and the run options', async () => {
    const response = await call('POST', '/start', {
      token: bridge.token,
      body: {
        objective: '  Ship the shared pipeline  ',
        tasks: [{ title: 'A', brief: 'do a' }],
        workers: 5,
        expansion: 61,
        verify: ['npm test'],
        cwd: 'fake/project',
        session_id: 'caller-1',
      },
    })
    assert.equal(response.status, 200)
    assert.equal(response.body.ok, true)
    assert.equal(response.body.run_id, 'run-fake-1')
    assert.ok(Array.isArray(response.body.workers))
    assert.equal(engine.state.starts.length, 1)

    const { request, caller } = engine.state.starts[0]
    assert.equal(request.objective, 'Ship the shared pipeline')
    assert.equal(request.tasks.length, 1)
    assert.equal(request.workers, 5)
    assert.equal(request.expansion, 61)
    assert.deepEqual(request.verify, ['npm test'])
    assert.equal(request.cwd, 'fake/project')
    assert.equal(request.requireTasks, false)
    assert.equal(request.callerSessionId, 'caller-1')
    assert.equal(caller, undefined)
  })

  await check('POST /config clamps workers to maxWorkers and persists via the store', async () => {
    const response = await call('POST', '/config', {
      token: bridge.token,
      body: { workers: 99, expansion: 130 },
    })
    assert.equal(response.status, 200)
    assert.equal(response.body.ok, true)
    assert.deepEqual(response.body.config, { workers: 3, expansion: 100 })
    assert.equal(persisted.configWrites.length, 1)
    assert.deepEqual(persisted.config, { workers: 3, expansion: 100 })
    assert.equal(engine.config.defaultWorkers, 3)
    assert.equal(engine.config.defaultExpansion, 100)
  })

  await check('GET /state reflects the persisted config', async () => {
    const response = await call('GET', '/state', { token: bridge.token })
    assert.equal(response.status, 200)
    assert.deepEqual(response.body.config, { workers: 3, expansion: 100 })
  })

  await check('POST /config accepts a lower in-range value', async () => {
    const response = await call('POST', '/config', {
      token: bridge.token,
      body: { workers: 1, expansion: 25 },
    })
    assert.equal(response.status, 200)
    assert.deepEqual(response.body.config, { workers: 1, expansion: 25 })
    assert.deepEqual(persisted.configWrites.at(-1), { workers: 1, expansion: 25 })
  })

  await check('POST /stop returns ok and calls engine.stop(run_id, "ui-stop")', async () => {
    const response = await call('POST', '/stop', {
      token: bridge.token,
      body: { run_id: 'run-fake-1' },
    })
    assert.equal(response.status, 200)
    assert.equal(response.body.ok, true)
    assert.equal(response.body.run_id, 'run-fake-1')
    assert.equal(response.body.status, 'stopped')
    assert.deepEqual(response.body.cancelled, ['sess-1'])
    assert.equal(engine.state.stops.length, 1)
    assert.deepEqual(engine.state.stops[0], { runId: 'run-fake-1', reason: 'ui-stop' })
  })

  await check('POST routes require the token too', async () => {
    const response = await call('POST', '/stop', { body: { run_id: 'run-fake-1' } })
    assert.equal(response.status, 401)
    assert.equal(response.body.ok, false)
    assert.equal(engine.state.stops.length, 1)
  })

  await check('unknown route with a token is 404 JSON', async () => {
    const response = await call('GET', '/nope', { token: bridge.token })
    assert.equal(response.status, 404)
    assert.equal(response.body.ok, false)
    assert.equal(response.body.error, 'not found')
  })

  await check('malformed JSON body fails as JSON, not a stack', async () => {
    const response = await call('POST', '/config', { token: bridge.token, rawBody: '{oops' })
    assert.ok(response.status >= 400, `status ${response.status}`)
    assert.equal(response.body.ok, false)
    assert.equal(typeof response.body.error, 'string')
    assert.ok(!response.raw.includes('    at '), 'no stack trace in the response')
  })

  // FINDINGS.md F1 (fixed 23:22): the expansion slider's legal value 0 (= off)
  // must persist. Regression guard for the `||` fallback that replaced it.
  await check('POST /config persists expansion 0 (slider "off")', async () => {
    const response = await call('POST', '/config', {
      token: bridge.token,
      body: { workers: 2, expansion: 0 },
    })
    assert.equal(response.status, 200)
    assert.equal(
      response.body.config.expansion,
      0,
      'expansion 0 must be stored as 0 (0=off), not replaced by defaultExpansion',
    )
    assert.equal(persisted.config.expansion, 0, 'store.saveConfig must receive expansion 0')
  })
} finally {
  if (bridge !== undefined) {
    try {
      await withTimeout(bridge.stop(), 5000, 'bridge.stop()')
    } catch (error) {
      console.error(`FAIL bridge · ${error.message}`)
      clearTimeout(watchdog)
      process.exit(1)
    }
  }
  clearTimeout(watchdog)
}

if (failures.length > 0) {
  console.error(`not ok bridge.test.mjs — ${failures.length} of ${checks + failures.length} checks failed`)
  throw new Error(
    `bridge.test.mjs: ${failures.length} check(s) failed: ${failures.map((item) => item.name).join(', ')}`,
  )
}
console.log(`ok bridge.test.mjs (${checks} checks)`)

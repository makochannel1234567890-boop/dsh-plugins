/**
 * JSON control surface for the dsh-fanout Web panel.
 *
 * Bundle client halves cannot call Host code directly, so the Host half exposes
 * a tiny JSON API through two carriers:
 *   1. the existing Web server under the `/fanout-api` prefix (same origin, no
 *      CORS and no CSP `connect-src` surprises),
 *   2. a loopback-only HTTP listener (fallback when the prefix route is taken or
 *      the Web composition is different).
 *
 * Security model: loopback only, a per-installation token guards every route
 * except `GET /health` (which returns the token so the panel can bootstrap),
 * CORS is reflected only for loopback origins, and request bodies are capped.
 *
 * @module dsh-fanout/lib/bridge
 */

import { randomUUID } from 'node:crypto'
import http from 'node:http'

const MAX_BODY_BYTES = 1_000_000
export const FRONT_PREFIX = '/fanout-api'

function isLoopbackOrigin(origin) {
  if (typeof origin !== 'string' || origin.length === 0) return false
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(origin)
}

function send(res, status, value, origin) {
  const body = `${JSON.stringify(value)}\n`
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  }
  if (isLoopbackOrigin(origin)) {
    headers['access-control-allow-origin'] = origin
    headers.vary = 'origin'
  }
  res.writeHead(status, headers)
  res.end(body)
}

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  const parsed = JSON.parse(text)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('request body must be a JSON object')
  }
  return parsed
}

function routePath(rawUrl) {
  const pathname = new URL(rawUrl ?? '/', 'http://127.0.0.1').pathname
  if (pathname === FRONT_PREFIX) return '/'
  if (pathname.startsWith(`${FRONT_PREFIX}/`)) return pathname.slice(FRONT_PREFIX.length)
  return pathname
}

/**
 * Build the request handler shared by both carriers.
 *
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void}
 */
export function createBridgeHandler({ engine, store, config, log, token, team, worktree }) {
  return function handle(req, res) {
    const origin = req.headers.origin
    const method = req.method ?? 'GET'
    const path = routePath(req.url)
    const route = `${method} ${path}`

    if (method === 'OPTIONS') {
      const headers = {}
      if (isLoopbackOrigin(origin)) {
        headers['access-control-allow-origin'] = origin
        headers['access-control-allow-methods'] = 'GET, POST, OPTIONS'
        headers['access-control-allow-headers'] = 'content-type, x-fanout-token'
        headers['access-control-max-age'] = '600'
        headers.vary = 'origin'
      }
      res.writeHead(204, headers)
      res.end()
      return
    }

    void (async () => {
      try {
        if (route === 'GET /health') {
          send(res, 200, { ok: true, token, version: 1, port: config.bridgePort }, origin)
          return
        }
        if (req.headers['x-fanout-token'] !== token) {
          send(res, 401, { ok: false, error: 'unauthorized' }, origin)
          return
        }
        if (route === 'GET /state') {
          const saved = (await store.loadConfig().catch(() => undefined)) ?? {}
          const workers = saved.workers ?? config.defaultWorkers
          const expansion = saved.expansion ?? config.defaultExpansion
          // The composer checkbox is per session; a request without one just
          // reports the disarmable default so the panel can render "off".
          const sessionId = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('session_id') ?? ''
          send(res, 200, { ok: true, config: { workers, expansion }, armed: engine.armedState(sessionId), ...engine.uiState() }, origin)
          return
        }
        if (route === 'POST /arm') {
          const body = await readBody(req)
          const result = engine.arm({
            sessionId: typeof body.session_id === 'string' ? body.session_id : '',
            armed: body.armed === true,
            mode: body.mode,
            workers: body.workers,
            expansion: body.expansion,
          })
          send(res, result.ok === false ? 400 : 200, result, origin)
          return
        }
        if (route === 'POST /config') {
          const body = await readBody(req)
          // 0 is a legal value for the expansion slider (オフ) — never use `||`.
          const rawWorkers = Number(body.workers)
          const rawExpansion = Number(body.expansion)
          const workers = Math.min(
            config.maxWorkers,
            Math.max(1, Number.isFinite(rawWorkers) ? Math.floor(rawWorkers) : config.defaultWorkers),
          )
          const expansion = Math.min(
            config.maxExpansion,
            Math.max(0, Number.isFinite(rawExpansion) ? Math.floor(rawExpansion) : config.defaultExpansion),
          )
          await store.saveConfig({ workers, expansion })
          engine.config.defaultWorkers = workers
          engine.config.defaultExpansion = expansion
          send(res, 200, { ok: true, config: { workers, expansion } }, origin)
          return
        }
        // Team mode and the shared task board: the panel is their only UI, so
        // these two routes carry the whole surface. A missing service answers
        // 409 rather than inventing an "off" state the panel could show.
        if (route === 'GET /team') {
          if (team === undefined) {
            send(res, 409, { ok: false, error: 'team-unavailable' }, origin)
            return
          }
          const sessionId = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('session_id') ?? ''
          const view = team.read(sessionId)
          send(res, view.ok === false ? 409 : 200, view, origin)
          return
        }
        if (route === 'POST /team') {
          if (team === undefined) {
            send(res, 409, { ok: false, error: 'team-unavailable' }, origin)
            return
          }
          const body = await readBody(req)
          const result = await team.setEnabled(
            typeof body.session_id === 'string' ? body.session_id : '',
            body.enabled === true,
          )
          send(res, result.ok === false ? 409 : 200, result, origin)
          return
        }
        // One checkout control: the panel asks whether creation is possible at
        // all, then creates one branch and enters it in a single operation.
        if (route === 'GET /worktree') {
          if (worktree === undefined) {
            send(res, 409, { ok: false, error: 'worktree-unavailable' }, origin)
            return
          }
          send(res, 200, worktree.status(), origin)
          return
        }
        if (route === 'POST /worktree') {
          if (worktree === undefined) {
            send(res, 409, { ok: false, error: 'worktree-unavailable' }, origin)
            return
          }
          const body = await readBody(req)
          const result = await worktree.create(
            typeof body.session_id === 'string' ? body.session_id : '',
            typeof body.from === 'string' ? body.from : '',
          )
          send(res, result.ok === false ? 400 : 200, result, origin)
          return
        }
        if (route === 'POST /start') {
          const body = await readBody(req)
          const objective = typeof body.objective === 'string' ? body.objective.trim() : ''
          if (objective.length === 0) {
            send(res, 400, { ok: false, error: 'objective is required' }, origin)
            return
          }
          const tasks = Array.isArray(body.tasks) ? body.tasks : []
          const workers = body.workers
          const expansion = body.expansion
          const verify = Array.isArray(body.verify) ? body.verify : []
          const sessionId = typeof body.session_id === 'string' ? body.session_id : ''
          // No task list from the panel: ask the calling session's model to
          // decompose the objective and call fanout_start with tasks, instead of
          // degrading the slider to a single worker.
          if (tasks.length === 0 && sessionId.length > 0) {
            const planned = await engine.requestPlan({
              objective,
              workers: workers ?? config.defaultWorkers,
              expansion: expansion ?? config.defaultExpansion,
              verify,
              sessionId,
            })
            send(res, 200, { ok: true, planning: true, ...planned }, origin)
            return
          }
          const result = await engine.start(
            {
              objective,
              tasks,
              workers,
              expansion,
              verify,
              cwd: typeof body.cwd === 'string' ? body.cwd : undefined,
              requireTasks: false,
              callerSessionId: sessionId,
            },
            undefined,
          )
          send(res, 200, { ok: true, run_id: result.run_id, workers: result.workers }, origin)
          return
        }
        if (route === 'POST /stop') {
          const body = await readBody(req)
          const result = await engine.stop(
            typeof body.run_id === 'string' ? body.run_id : undefined,
            'ui-stop',
          )
          send(res, 200, { ok: true, ...result }, origin)
          return
        }
        send(res, 404, { ok: false, error: 'not found' }, origin)
      } catch (error) {
        log(`bridge ${route} failed: ${String(error)}`)
        try {
          send(res, 500, { ok: false, error: String(error?.message ?? error) }, origin)
        } catch {
          // Response already closed; nothing useful to do.
        }
      }
    })()
  }
}

/**
 * Start the loopback carrier. Returns `{ port, token, handler, stop() }`; the
 * same `handler` can be mounted on the Web server under `FRONT_PREFIX`.
 */
export async function startBridge({ engine, store, config, log, team, worktree }) {
  const token = randomUUID()
  const port = config.bridgePort
  const handler = createBridgeHandler({ engine, store, config, log, token, team, worktree })
  const server = http.createServer(handler)

  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.off('error', onError)
      resolve(undefined)
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, '127.0.0.1')
  })

  await store.saveBridge({ port, token, startedAt: Date.now() }).catch(() => {})

  return {
    port,
    token,
    handler,
    stop() {
      return new Promise((resolve) => {
        try {
          server.close(() => resolve(undefined))
        } catch {
          resolve(undefined)
        }
      })
    },
  }
}

/**
 * apply.test.mjs — the Host half actually mounts.
 *
 * Runs `apply()` against a fake Cordis context: six tools, the prompt section,
 * the global listeners, the loopback bridge, and a clean disposer. No real
 * Harness is involved.
 */

import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

import { apply } from '../index.js'

let checks = 0
function check(name, fn) {
  fn()
  checks += 1
  console.log(`ok  apply · ${name}`)
}

async function settle(milliseconds = 120) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function fakeContext() {
  const tools = new Map()
  const sections = []
  const listeners = []
  const effects = []
  const sessions = []
  const controller = {
    async create() {
      const sessionId = `s${sessions.length + 1}`
      sessions.push(sessionId)
      return { sessionId }
    },
    async prompt() {
      return { accepted: true }
    },
    cancel() {
      return { accepted: true }
    },
    async list() {
      return { items: sessions.map((sessionId) => ({ sessionId, running: true })) }
    },
    async inspect() {
      return { events: [] }
    },
  }
  const ctx = {
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
      },
    },
    get(name) {
      if (name === 'sessionController') return controller
      if (name === 'systemPrompt') return { section: (section) => sections.push(section) }
      if (name === 'agents') return { get: () => undefined }
      if (name === 'workingDirectory') return { get: () => process.cwd() }
      return undefined
    },
    on(eventName, handler) {
      listeners.push({ eventName, handler })
    },
    effect(fn) {
      effects.push(fn)
    },
  }
  return { ctx, tools, sections, listeners, effects, sessions }
}

function getJson(port, routePath, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: '127.0.0.1', port, path: routePath, method: 'GET', headers },
      (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let body
          try {
            body = JSON.parse(text)
          } catch {
            body = text
          }
          resolve({ status: response.statusCode, body })
        })
      },
    )
    request.on('error', reject)
    request.end()
  })
}

const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'fanout-apply-'))
const bridgePort = 51399
const fake = fakeContext()
apply(fake.ctx, {
  bridgePort,
  storeDir: temp,
  injectPrompt: true,
  defaultWorkers: 2,
  approvalDefault: 'automatic',
})

try {
  await settle(250)

  check('registers the v2 tools plus the append-only queue tool', () => {
    assert.deepEqual(
      [...fake.tools.keys()].sort(),
      [
        'divergence_check',
        'fanout_approve',
        'fanout_control',
        'fanout_enqueue',
        'fanout_start',
        'fanout_status',
        'fanout_stop',
      ],
    )
  })

  check('fanout_start advertises the graph contract', () => {
    const start = fake.tools.get('fanout_start')
    assert.deepEqual([...start.parameters.required].sort(), ['objective', 'tasks'])
    const task = start.parameters.properties.tasks.items
    assert.ok(task.properties.dependsOn, 'dependsOn is part of the task schema')
    assert.ok(task.properties.kind, 'kind is part of the task schema')
    assert.ok(task.properties.acceptance, 'acceptance is part of the task schema')
    assert.ok(task.properties.experts, 'experts (the summoned-expert lens) is part of the task schema')
  })

  check('injects the prompt sections and the two global listeners', () => {
    assert.equal(fake.sections.length, 2)
    assert.equal(fake.sections[0].name, 'tool:fanout')
    assert.ok(fake.sections[0].text.includes('fanout_control'))
    // The queue layer documents itself in its own section, so the fan-out section
    // stays about deciding *whether* to split.
    assert.equal(fake.sections[1].name, 'tool:fanout-queue')
    assert.ok(fake.sections[1].text.includes('fanout_enqueue'))
    const names = fake.listeners.map((listener) => listener.eventName).sort()
    assert.deepEqual(names, ['api-session/status', 'session/event'])
  })

  const health = await getJson(bridgePort, '/health')
  check('the loopback bridge answers /health and gates the state route', async () => {
    assert.equal(health.status, 200)
    assert.equal(health.body.ok, true)
    assert.equal(typeof health.body.token, 'string')
  })

  const denied = await getJson(bridgePort, '/state')
  check('an unauthenticated /state is refused', () => {
    assert.equal(denied.status, 401)
  })

  const state = await getJson(bridgePort, '/state', { 'x-fanout-token': health.body.token })
  check('an authenticated /state carries the dock contract', () => {
    assert.equal(state.status, 200)
    assert.ok(state.body.config, 'config is present')
    assert.ok(Array.isArray(state.body.runs), 'runs is an array')
    assert.equal(typeof state.body.active_run_id, 'string')
  })

  const start = fake.tools.get('fanout_start')
  const started = await start.execute(
    { objective: 'smoke', tasks: [{ title: 'a', brief: 'do a' }], requireTasks: true, workers: 1 },
    { agent: undefined },
  )
  check('fanout_start through the registered tool creates a run', () => {
    assert.ok(started.run_id)
    assert.ok(Array.isArray(started.tasks))
    assert.equal(started.tasks.length, 1)
    assert.equal(fake.sessions.length, 1)
  })

  const status = fake.tools.get('fanout_status')
  const reported = await status.execute({ run_id: started.run_id }, {})
  check('fanout_status reports the task graph', () => {
    assert.equal(reported.run.run_id, started.run_id)
    assert.equal(reported.run.tasks.length, 1)
    assert.equal(reported.run.tasks[0].state, 'running')
    assert.ok(reported.run.gates)
  })

  const control = fake.tools.get('fanout_control')
  const paused = await control.execute({ action: 'pause', run_id: started.run_id }, {})
  check('fanout_control pauses a running run', () => {
    assert.equal(paused.status, 'paused')
    assert.equal(paused.paused, true)
  })

  const enqueue = fake.tools.get('fanout_enqueue')
  const appended = await enqueue.execute(
    { run_id: started.run_id, tasks: [{ title: 'later', brief: 'do later', scope: ['src/later.ts'] }] },
    {},
  )
  await check('fanout_enqueue appends to the queue instead of starting a second run', () => {
    assert.equal(appended.mode, 'appended')
    assert.deepEqual(appended.appended, ['t2'])
    assert.equal(appended.tasks.length, 2)
    assert.equal(fake.sessions.length, 1, 'a paused queue takes work without spawning a session')
    assert.ok(appended.queue, 'the queue view rides along with the append')
  })

  // Resolve/await the work *before* check() so the assertion cannot race the
  // stop below (check() does not await its callback).
  const badAppend = await enqueue
    .execute({ run_id: started.run_id, tasks: [{ title: 'bad', brief: 'bad', dependsOn: ['nope'] }] }, {})
    .then((value) => ({ rejected: false, value }), (error) => ({ rejected: true, error }))
  const afterBadAppend = await status.execute({ run_id: started.run_id }, {})
  check('fanout_enqueue rejects a dependency that does not exist and leaves the queue untouched', () => {
    assert.equal(badAppend.rejected, true, `expected a rejection, got ${JSON.stringify(badAppend.value ?? null)}`)
    assert.match(String(badAppend.error?.message ?? ''), /unknown dependency/)
    assert.equal(afterBadAppend.run.tasks.length, 2)
  })

  const stopped = await fake.tools.get('fanout_stop').execute({ run_id: started.run_id, reason: 'smoke' }, {})
  check('fanout_stop cancels the live session', () => {
    assert.equal(stopped.status, 'stopped')
    assert.ok(stopped.cancelled_count >= 1)
  })
} finally {
  for (const effect of fake.effects) {
    const disposer = effect()
    if (typeof disposer === 'function') disposer()
  }
  await settle(120)
  await fsp.rm(temp, { recursive: true, force: true }).catch(() => {})
}

console.log(`ok  apply.test.mjs (${checks} checks)`)

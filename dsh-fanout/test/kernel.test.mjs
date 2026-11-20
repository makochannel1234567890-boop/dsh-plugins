/**
 * kernel.test.mjs — the v2 state machine against a fake Cordis context.
 *
 * Covers: fan-out + settle, stale/contract-violating attempts, the
 * review→repair→escalate loop, integration report validation, controls
 * (pause/resume/steer/edit/takeover/stop), staged approval, and restart
 * recovery from run.json.
 */

import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { FanoutKernel } from '../lib/kernel.js'
import { FanoutStore } from '../lib/store.js'

const CONFIG = {
  maxWorkers: 4,
  defaultWorkers: 2,
  maxExpansion: 100,
  defaultExpansion: 0,
  workerTimeoutMinutes: 5,
  runTimeoutMinutes: 30,
  integrate: false,
  archiveWorkers: false,
  review: false,
  maxReviewRounds: 3,
  maxAttempts: 2,
  approvalDefault: 'automatic',
  injectPrompt: false,
  resultDigestChars: 1200,
  notifyCaller: false,
}

let checks = 0
async function check(name, fn) {
  await fn()
  checks += 1
  console.log(`ok  kernel · ${name}`)
}

async function makeEnv(options = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'fanout-kernel-'))
  const cwd = path.join(dir, 'ws')
  await fsp.mkdir(cwd, { recursive: true })
  const state = { sessions: [], prompts: [], cancelled: [], running: new Set(), seq: 0 }
  const known = options.knownSessions ?? undefined
  const controller = {
    async create() {
      const sessionId = `s${++state.seq}`
      state.sessions.push(sessionId)
      state.running.add(sessionId)
      return { sessionId }
    },
    async prompt(request) {
      state.prompts.push({
        sessionId: request.sessionId,
        mode: request.mode,
        text: (request.content ?? []).map((block) => block.text).join('\n'),
      })
      state.running.add(request.sessionId)
      return { accepted: true }
    },
    cancel({ sessionId }) {
      state.cancelled.push(sessionId)
      state.running.delete(sessionId)
      return { accepted: true }
    },
    async list() {
      if (Array.isArray(known)) return { items: known }
      return { items: state.sessions.map((sessionId) => ({ sessionId, running: state.running.has(sessionId) })) }
    },
    async inspect() {
      return { events: [] }
    },
  }
  const ctx = {
    get(name) {
      if (name === 'sessionController') return controller
      if (name === 'agents') return { get: () => undefined }
      if (name === 'workingDirectory') return { get: () => cwd }
      return undefined
    },
    on() {},
    effect() {},
  }
  return { dir, cwd, ctx, state, controller }
}

async function boot(env, overrides = {}) {
  const storeDir = overrides.storeDir ?? path.join(env.dir, 'store')
  const store = new FanoutStore(storeDir)
  const config = { ...CONFIG, ...(overrides.config ?? {}) }
  const kernel = new FanoutKernel({ ctx: env.ctx, store, config, log: () => {} })
  await kernel.init()
  return { kernel, store, config }
}

async function flush(kernel, rounds = 10) {
  for (let index = 0; index < rounds; index += 1) {
    await kernel.chain
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  await kernel.chain
}

function acceptanceOf(task) {
  return (task.contract?.acceptance ?? []).map((criterion) => ({
    criterion,
    status: 'passed',
    evidence: 'observed',
  }))
}

function resultBody(task, options = {}) {
  const attemptId = options.attemptId ?? task.attemptId
  const acceptance = options.acceptance ?? acceptanceOf(task)
  const lines = [
    `<!-- fanout-result task=${task.id} attempt=${attemptId} -->`,
    `# Task ${task.id} — result`,
    '## Summary',
    options.summary ?? `${task.id} done`,
    '## What changed',
    '- src/a.js: implemented',
    '## Verification',
    '- `node --test` → exit 0',
    '## Acceptance',
  ]
  for (const item of acceptance) {
    lines.push(`- ACCEPT: ${item.criterion} | ${item.status} | ${item.evidence}`)
  }
  lines.push('## Changed paths', '- src/a.js', '## Closed findings')
  for (const id of options.closed ?? []) lines.push(`- CLOSED: ${id}`)
  lines.push('## Open issues', '- none')
  return `${lines.join('\n')}\n`
}

async function writeResult(env, run, fileName, text) {
  const file = path.join(env.cwd, '.dsh-fanout', 'runs', run.id, 'results', `${fileName}.md`)
  await fsp.mkdir(path.dirname(file), { recursive: true })
  await fsp.writeFile(file, text, 'utf8')
}

async function settle(env, kernel, sessionId, reason = 'completed') {
  env.state.running.delete(sessionId)
  kernel.observeSessionEvent({ id: sessionId }, { type: 'turn/start' })
  kernel.observeSessionEvent({ id: sessionId }, { type: 'turn/end', data: { reason: { kind: reason } } })
  await flush(kernel)
}

function taskByName(kernel, runId, predicate) {
  const run = kernel.runs.get(runId)
  return run.tasks.find(predicate)
}

await check('fan-out: two independent tasks complete and settle the run', async () => {
  const env = await makeEnv()
  const { kernel } = await boot(env)
  try {
    const started = await kernel.start({
      objective: 'two independent slices',
      tasks: [
        { title: 'a', brief: 'do a' },
        { title: 'b', brief: 'do b' },
      ],
      requireTasks: true,
      workers: 2,
    })
    const run = kernel.runs.get(started.run_id)
    assert.equal(run.tasks.length, 2)
    assert.equal(run.sessions.filter((session) => session.role === 'task').length, 2)
    assert.ok(run.tasks.every((task) => task.state === 'running'))
    for (const task of run.tasks) {
      await writeResult(env, run, task.attemptId, resultBody(task))
      await settle(env, kernel, task.sessionId)
    }
    assert.ok(run.tasks.every((task) => task.state === 'completed'))
    assert.equal(run.status, 'completed')
    assert.ok(run.tasks.every((task) => task.digest.includes('done')))
    assert.ok(run.tasks.every((task) => task.resultPath.startsWith(env.cwd)))
  } finally {
    kernel.dispose()
  }
})

await check('a dependency gates the second task until the first completes', async () => {
  const env = await makeEnv()
  const { kernel } = await boot(env)
  try {
    const started = await kernel.start({
      objective: 'ordered slices',
      tasks: [
        { id: 'a', title: 'a', brief: 'do a' },
        { id: 'b', title: 'b', brief: 'do b', dependsOn: ['a'] },
      ],
      requireTasks: true,
      workers: 2,
    })
    const run = kernel.runs.get(started.run_id)
    assert.equal(run.tasks[0].state, 'running')
    assert.equal(run.tasks[1].state, 'pending')
    await writeResult(env, run, run.tasks[0].attemptId, resultBody(run.tasks[0]))
    await settle(env, kernel, run.tasks[0].sessionId)
    assert.equal(run.tasks[1].state, 'running')
    await writeResult(env, run, run.tasks[1].attemptId, resultBody(run.tasks[1]))
    await settle(env, kernel, run.tasks[1].sessionId)
    assert.ok(run.tasks.every((task) => task.state === 'completed'))
    assert.equal(run.status, 'completed')
  } finally {
    kernel.dispose()
  }
})

await check('a stale attempt is rejected and retried, then accepted', async () => {
  const env = await makeEnv()
  const { kernel } = await boot(env)
  try {
    const started = await kernel.start({
      objective: 'quality slice',
      tasks: [
        {
          title: 'impl',
          brief: 'implement',
          kind: 'implementation',
          acceptance: ['works'],
          verify: ['node --test'],
        },
      ],
      requireTasks: true,
      workers: 1,
    })
    const run = kernel.runs.get(started.run_id)
    const task = run.tasks[0]
    await writeResult(env, run, task.attemptId, resultBody(task, { attemptId: 'wrong-attempt' }))
    await settle(env, kernel, task.sessionId)
    assert.equal(task.state, 'running', 'a stale answer must not complete the task')
    assert.equal(task.attempt, 2)
    await writeResult(env, run, task.attemptId, resultBody(task))
    await settle(env, kernel, task.sessionId)
    assert.equal(task.state, 'completed')
    assert.equal(run.status, 'completed')
  } finally {
    kernel.dispose()
  }
})

await check('review failure splices a repair, then escalates at the round limit', async () => {
  const env = await makeEnv()
  const { kernel } = await boot(env, { config: { review: true, maxReviewRounds: 2 } })
  try {
    const started = await kernel.start({
      objective: 'gated slice',
      tasks: [
        {
          title: 'impl',
          brief: 'implement',
          kind: 'implementation',
          acceptance: ['works'],
          verify: ['node --test'],
        },
      ],
      requireTasks: true,
      workers: 2,
    })
    const run = kernel.runs.get(started.run_id)
    const source = run.tasks.find((task) => task.kind === 'implementation')
    await writeResult(env, run, source.attemptId, resultBody(source))
    await settle(env, kernel, source.sessionId)

    const review1 = taskByName(kernel, run.id, (task) => task.kind === 'review' && task.round === 1)
    assert.ok(review1, 'a review node is inserted after an implementation task')
    assert.deepEqual(review1.deps, [source.id])
    assert.equal(review1.state, 'running')
    const reviewText = (verdict, findingId) => `VERDICT: ${verdict}
ACCEPT: works | failed | the command output was never attached
FINDING: ${findingId} | high | no evidence | run the verify command and attach output | src/a.js | 1
`
    await writeResult(env, run, review1.attemptId, reviewText('needs_revision', 'F1'))
    await settle(env, kernel, review1.sessionId)

    const repair = taskByName(kernel, run.id, (task) => task.kind === 'repair')
    assert.ok(repair, 'a needs_revision verdict inserts a repair node')
    assert.deepEqual(repair.deps, [review1.id])
    assert.deepEqual(repair.sourceFindingIds, ['F1'])
    assert.equal(source.reviewVerdict, 'needs_revision')
    await writeResult(env, run, repair.attemptId, resultBody(repair, { closed: ['F1'] }))
    await settle(env, kernel, repair.sessionId)

    const review2 = taskByName(kernel, run.id, (task) => task.kind === 'review' && task.round === 2)
    assert.ok(review2, 'a completed repair queues the next review round')
    assert.deepEqual(review2.deps, [repair.id])
    await writeResult(env, run, review2.attemptId, reviewText('reject', 'F2'))
    await settle(env, kernel, review2.sessionId)

    assert.equal(run.status, 'escalated')
    assert.equal(run.gates.escalated, true)
  } finally {
    kernel.dispose()
  }
})

await check('integration: an invalid report is retried once, a valid one completes', async () => {
  const env = await makeEnv()
  const { kernel } = await boot(env, { config: { integrate: true } })
  try {
    const started = await kernel.start({
      objective: 'integrated slice',
      tasks: [{ title: 'a', brief: 'do a' }],
      requireTasks: true,
      workers: 1,
    })
    const run = kernel.runs.get(started.run_id)
    await writeResult(env, run, run.tasks[0].attemptId, resultBody(run.tasks[0]))
    await settle(env, kernel, run.tasks[0].sessionId)
    assert.equal(run.status, 'integrating')
    const integrator = run.integrator
    assert.ok(integrator?.sessionId, 'an integrator session is spawned')

    const finalFile = path.join(env.cwd, '.dsh-fanout', 'runs', run.id, 'final.md')
    await fsp.mkdir(path.dirname(finalFile), { recursive: true })
    await fsp.writeFile(finalFile, '# Fan-out final report\n## Outcome\ntoo short\n', 'utf8')
    await settle(env, kernel, integrator.sessionId)
    assert.equal(run.status, 'integrating', 'a report without evidence is rejected, not accepted')
    assert.equal(run.integrator.attempt, 2)

    await fsp.writeFile(finalFile, `# Fan-out final report
## Outcome
The slice is implemented and the test command passed after the final change.
## Conflicts and how they were resolved
None.
## Verification
| command | exit code | evidence |
| --- | --- | --- |
| \`node --test\` | 0 | all checks passed |
## Remaining gaps
None.
## Files of record
src/a.js
`, 'utf8')
    await settle(env, kernel, run.integrator.sessionId)
    assert.equal(run.status, 'completed')
    assert.equal(run.integrator.state, 'settled')
    assert.equal(run.finalPath, finalFile)
  } finally {
    kernel.dispose()
  }
})

await check('controls: pause holds the queue, edit only touches never-started tasks, steer reaches the session', async () => {
  const env = await makeEnv()
  const { kernel } = await boot(env)
  try {
    const started = await kernel.start({
      objective: 'control slice',
      tasks: [
        { id: 'a', title: 'a', brief: 'do a' },
        { id: 'b', title: 'b', brief: 'do b' },
      ],
      requireTasks: true,
      workers: 1,
    })
    const run = kernel.runs.get(started.run_id)
    const [first, second] = run.tasks
    await kernel.control('pause', { run_id: run.id })
    assert.equal(run.status, 'paused')
    await writeResult(env, run, first.attemptId, resultBody(first))
    await settle(env, kernel, first.sessionId)
    assert.equal(first.state, 'completed')
    assert.equal(second.state, 'pending', 'no new session may spawn while paused')
    const editOk = await kernel.control('edit', { run_id: run.id, task_id: 'b', patch: { title: 'renamed' } })
    assert.equal(editOk.ok, true)
    assert.equal(second.title, 'renamed')
    await kernel.control('resume', { run_id: run.id })
    assert.equal(run.status, 'running')
    await flush(kernel)
    assert.equal(second.state, 'running')
    await kernel.control('steer', { run_id: run.id, task_id: 'b', message: 'prefer the smaller fix' })
    const steered = env.state.prompts.filter((prompt) => prompt.mode === 'steer')
    assert.equal(steered.length, 1)
    assert.ok(steered[0].text.includes('smaller fix'))
    await writeResult(env, run, second.attemptId, resultBody(second))
    await settle(env, kernel, second.sessionId)
    assert.equal(run.status, 'completed')
  } finally {
    kernel.dispose()
  }
})

await check('approval: a staged plan spawns nothing until it is approved', async () => {
  const env = await makeEnv()
  const { kernel } = await boot(env)
  try {
    const staged = await kernel.start({
      objective: 'needs a human look',
      tasks: [{ title: 'a', brief: 'do a' }],
      requireTasks: true,
      approval: 'required',
    })
    assert.equal(staged.staged, true)
    assert.equal(env.state.sessions.length, 0, 'staging must not create sessions')
    const run = kernel.runs.get(staged.run_id)
    assert.equal(run.status, 'staged')
    const approved = await kernel.approve(staged.run_id)
    assert.equal(approved.approved, true)
    assert.equal(run.status, 'running')
    assert.equal(env.state.sessions.length, 1)
  } finally {
    kernel.dispose()
  }
})

await check('recovery: an in-flight run is adopted from disk and finishes', async () => {
  const envA = await makeEnv()
  const storeDir = path.join(envA.dir, 'store')
  const first = await boot(envA, { storeDir })
  const started = await first.kernel.start({
    objective: 'survives a reload',
    tasks: [{ title: 'a', brief: 'do a' }],
    requireTasks: true,
    workers: 1,
  })
  const original = first.kernel.runs.get(started.run_id)
  const task = original.tasks[0]
  const sessionId = task.sessionId
  const attemptId = task.attemptId
  await writeResult(envA, original, attemptId, resultBody(task))
  first.kernel.dispose()

  const envB = await makeEnv({ knownSessions: [{ sessionId, running: false }] })
  const store = new FanoutStore(storeDir)
  const kernelB = new FanoutKernel({ ctx: envB.ctx, store, config: { ...CONFIG }, log: () => {} })
  await kernelB.init()
  try {
    await flush(kernelB)
    const recovered = kernelB.runs.get(original.id)
    assert.ok(recovered, 'the run is rehydrated from run.json')
    assert.equal(recovered.tasks[0].state, 'completed')
    assert.equal(recovered.status, 'completed')
  } finally {
    kernelB.dispose()
  }
})

await check('a v1 run record is migrated and adopted, not discarded', async () => {
  const env = await makeEnv()
  const storeDir = path.join(env.dir, 'store')
  const store = new FanoutStore(storeDir)
  await store.ensure()
  const legacy = {
    v: 1,
    id: 'run-20260101000000-legacy',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    status: 'running',
    objective: 'legacy objective',
    cwd: env.cwd,
    callerSessionId: '',
    expansion: 0,
    verify: [],
    integrateRequested: false,
    tasks: [{ id: 't1', title: 'legacy slice', brief: 'do it', weight: 1, scope: [] }],
    workers: [
      { index: 0, taskIds: ['t1'], weight: 1, sessionId: 's1', state: 'settled', digest: 'old work', summary: 'old summary', error: '' },
    ],
    settledWorkers: 1,
    deadlineAt: Date.now() + 600000,
    workerTimeoutMs: 600000,
    resultDigestChars: 1200,
    runDir: store.runDir('run-20260101000000-legacy'),
    finalPath: '',
    estimate: { approx_tokens: 100 },
    error: '',
  }
  await store.createRun(legacy)
  const kernel = new FanoutKernel({ ctx: env.ctx, store, config: { ...CONFIG, integrate: false }, log: () => {} })
  await kernel.init()
  try {
    await flush(kernel)
    const adopted = kernel.runs.get(legacy.id)
    assert.ok(adopted, 'the v1 run is adopted')
    assert.equal(adopted.tasks.length, 1)
    assert.equal(adopted.tasks[0].id, 'w1')
    assert.equal(adopted.tasks[0].state, 'completed')
    assert.ok(adopted.warnings.some((warning) => warning.includes('v1')))
  } finally {
    kernel.dispose()
  }
})

await check('every attempt is filed and the manifest indexes it', async () => {
  const env = await makeEnv()
  const { kernel } = await boot(env)
  try {
    const started = await kernel.start({
      objective: 'file the evidence instead of re-sending it',
      tasks: [{ title: 'a', brief: 'do a' }],
      requireTasks: true,
      workers: 1,
    })
    const run = kernel.runs.get(started.run_id)
    const base = path.join(env.cwd, '.dsh-fanout', 'runs', run.id)
    const objective = await fsp.readFile(path.join(base, 'objective.md'), 'utf8')
    assert.ok(objective.includes('file the evidence instead of re-sending it'))
    const first = JSON.parse(await fsp.readFile(path.join(base, 'manifest.json'), 'utf8'))
    assert.equal(first.run_id, run.id)
    assert.equal(first.prefix.sha256, run.context.prefixSha256)
    assert.ok(first.artifacts.some((item) => item.role === 'prompt' && item.task === 't1' && item.sha256.length === 64))
    const task = run.tasks[0]
    await writeResult(env, run, task.attemptId, resultBody(task))
    await settle(env, kernel, task.sessionId)
    const manifest = JSON.parse(await fsp.readFile(path.join(base, 'manifest.json'), 'utf8'))
    const result = manifest.artifacts.find((item) => item.role === 'result' && item.task === 't1')
    assert.ok(result, 'the settled result is indexed')
    assert.ok(result.bytes > 0 && result.sha256.length === 64)
    assert.equal(run.manifestPath, `.dsh-fanout/runs/${run.id}/manifest.md`)
    assert.ok(manifest.tasks.some((row) => row.id === 't1' && row.state === 'completed'))
  } finally {
    kernel.dispose()
  }
})

await check('a duplicate active run is refused unless explicitly allowed', async () => {
  const env = await makeEnv()
  const { kernel } = await boot(env)
  try {
    const first = await kernel.start({
      objective: 'the same objective',
      tasks: [{ title: 'a', brief: 'do a' }],
      requireTasks: true,
      workers: 1,
    })
    const second = await kernel.start({
      objective: 'the same   objective',
      tasks: [{ title: 'b', brief: 'do b' }],
      requireTasks: true,
      workers: 1,
    })
    assert.equal(second.duplicate, true, 'a duplicate objective is refused')
    assert.equal(second.duplicate_of, first.run_id)
    assert.ok(second.message.includes('allowDuplicate'))
    const third = await kernel.start({
      objective: 'the same objective',
      tasks: [{ title: 'c', brief: 'do c' }],
      requireTasks: true,
      workers: 1,
      allowDuplicate: true,
    })
    assert.ok(third.run_id !== first.run_id, 'allowDuplicate starts a second run')
    assert.equal(kernel.runs.size, 2)
  } finally {
    kernel.dispose()
  }
})

console.log(`ok  kernel.test.mjs (${checks} checks)`)

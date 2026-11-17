/**
 * Standalone state-machine tests for dsh-deliberation.
 *
 * The plugin file is copied into `test/.tmp/` so its bare imports resolve to
 * the local shims under `test/node_modules` (a plain Node process cannot read
 * the DSH installation packed inside app.asar). The copied source is the exact
 * bytes of `../index.js`.
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const tempModuleDir = path.join(here, '.tmp')
await mkdir(tempModuleDir, { recursive: true })
const pluginSource = await readFile(path.join(here, '..', 'index.js'), 'utf8')
const pluginModulePath = path.join(tempModuleDir, 'plugin.mjs')
await writeFile(pluginModulePath, pluginSource, 'utf8')
const { apply, labels } = await import(`${pathToFileURL(pluginModulePath).href}?v=${Date.now()}`)

assert.equal(typeof apply, 'function', 'apply export')
assert.equal(labels.approve, '承認して開始 (Approve)')

function approvalAnswer({ custom, worktree } = {}) {
  const items = [{ id: 'approve', selected: [labels.approve] }]
  if (custom !== undefined) items[0].custom = custom
  if (worktree !== undefined) {
    items.push({ id: 'worktree', selected: [worktree ? labels.worktreeYes : labels.worktreeNo] })
  }
  return { answers: items }
}

function cancelAnswer() {
  return { answers: [{ id: 'approve', selected: [labels.cancel] }] }
}

async function makeHarness({ answers = [], config = {}, worktree = null } = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'dsh-deliberation-'))
  const events = []
  const followups = []
  const questions = []
  const sections = []
  const tools = new Map()
  const listeners = new Map()
  const recorded = { toolCalls: [] }

  const agent = {
    id: 'session-test-1',
    status: 'running',
    session: { id: 'session-test-1', snapshotEvents: () => events },
    inbox: { nextTurn: [], nextStep: [] },
    followup(message) {
      followups.push(message)
      agent.status = 'running'
    },
    steer() {},
    cancel() {},
  }
  agent.cwd = base

  const services = {
    workingDirectory: {
      get: () => agent.cwd,
      set: async (_agent, value) => {
        agent.cwd = value
        recorded.lastCwdSet = value
        return value
      },
    },
    worktrees: {
      create: async () => {
        if (worktree === null) throw new Error('worktree unavailable')
        agent.cwd = worktree.path
        return worktree
      },
    },
    systemPrompt: {
      section: (section) => {
        sections.push(section)
      },
    },
  }

  const ctx = {
    logger: { warn() {} },
    on(name, listener) {
      listeners.set(name, [...(listeners.get(name) ?? []), listener])
    },
    effect(fn) {
      return fn()
    },
    get(name) {
      return services[name]
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
      },
    },
    agents: {
      get: (id) => (id === agent.id ? agent : undefined),
      roots: () => [agent],
    },
    userQuestions: {
      async ask(request) {
        questions.push(request)
        const next = answers.shift()
        if (next === undefined) throw new Error('no scripted answer')
        if (next instanceof Error) throw next
        return next
      },
    },
  }

  apply(ctx, config)

  const emit = (name, payload) => {
    for (const listener of listeners.get(name) ?? []) listener(payload)
  }
  const settle = async () => {
    for (let index = 0; index < 25; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 4))
    }
  }
  const waitFor = async (predicate, timeoutMs = 2000) => {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      if (predicate()) return true
      await new Promise((resolve) => setTimeout(resolve, 4))
    }
    return false
  }

  return { base, agent, events, followups, questions, sections, tools, listeners, emit, settle, waitFor, recorded }
}

function execution(agent, callId) {
  return { agent, callId, signal: new AbortController().signal, arguments: {} }
}

async function startTool(harness, args) {
  return harness.tools.get('deliberation_start').execute(args, execution(harness.agent, 'call-start'))
}

async function endTool(harness, args) {
  return harness.tools.get('deliberation_end').execute(args, execution(harness.agent, 'call-end'))
}

function closeTurn(harness, reason = 'completed', options = {}) {
  if (options.text !== undefined) {
    harness.events.push({
      type: 'assistant/message',
      data: { message: { role: 'assistant', content: [{ type: 'text', text: options.text }] } },
    })
  }
  for (const [index, call] of (options.toolCalls ?? []).entries()) {
    harness.events.push({
      type: 'tool/call',
      data: {
        name: call.name,
        arguments: call.arguments ?? '',
        callId: call.callId ?? `call-${index}`,
      },
    })
  }
  harness.events.push({ type: 'turn/end', data: { reason: { kind: reason } } })
  harness.agent.status = 'idle'
  harness.emit('agent/status', { agent: harness.agent, status: 'idle' })
}

const tests = []
function test(name, fn) {
  tests.push({ name, fn })
}

test('registers both tools and the policy prompt section', async () => {
  const harness = await makeHarness()
  try {
    assert.ok(harness.tools.has('deliberation_start'), 'start tool registered')
    assert.ok(harness.tools.has('deliberation_end'), 'end tool registered')
    assert.equal(harness.sections.length, 1)
    assert.equal(harness.sections[0].name, 'tool:deliberation')
    assert.equal(harness.sections[0].order, 2450)
    assert.match(harness.sections[0].text, /deliberation_start/)
  } finally {
    await rm(harness.base, { recursive: true, force: true })
  }
})

test('a declined approval never arms the supervisor', async () => {
  const harness = await makeHarness({ answers: [cancelAnswer()] })
  try {
    const result = await startTool(harness, { objective: 'Compare A and B' })
    assert.equal(result.status, 'declined')
    assert.equal(harness.questions.length, 1)
    assert.equal(harness.questions[0].wait.callId, 'call-start')
    assert.equal(harness.questions[0].questions.length, 1, 'non-git session asks only the approval question')
    closeTurn(harness)
    await harness.settle()
    assert.equal(harness.followups.length, 0)
  } finally {
    await rm(harness.base, { recursive: true, force: true })
  }
})

test('an approval arms the supervisor and queues round one', async () => {
  const harness = await makeHarness({ answers: [approvalAnswer()] })
  try {
    const result = await startTool(harness, { objective: 'Design a caching layer' })
    assert.equal(result.status, 'started')
    assert.equal(result.rounds, 8)
    assert.equal(result.minutes, 45)
    assert.equal(result.worktree_path, '')
    assert.ok(result.scratchpad.endsWith('.md'))

    closeTurn(harness)
    assert.equal(await harness.waitFor(() => harness.followups.length === 1), true)
    const prompt = harness.followups[0].content[0].text
    assert.match(prompt, /<deliberation_round>/)
    assert.match(prompt, /Round: 1\/8/)
    assert.match(prompt, /Design a caching layer/)
    assert.equal(harness.followups[0].source.kind, 'deliberation')

    const scratchpad = await readFile(result.scratchpad, 'utf8')
    assert.match(scratchpad, /# Extended deliberation/)
    assert.match(scratchpad, /Round 1 started/)
  } finally {
    await rm(harness.base, { recursive: true, force: true })
  }
})

test('the round budget ends with one final report turn', async () => {
  const harness = await makeHarness({
    answers: [approvalAnswer()],
    config: { defaultRounds: 1, maxRounds: 1 },
  })
  try {
    await startTool(harness, { objective: 'One bounded round' })
    closeTurn(harness)
    assert.equal(await harness.waitFor(() => harness.followups.length === 1), true)

    closeTurn(harness, 'completed', { text: 'round one output' })
    assert.equal(await harness.waitFor(() => harness.followups.length === 2), true)
    const finalPrompt = harness.followups[1].content[0].text
    assert.match(finalPrompt, /<deliberation_finished reason="rounds">/)
    assert.match(finalPrompt, /Rounds used: 1\/1/)

    closeTurn(harness)
    await harness.settle()
    assert.equal(harness.followups.length, 2, 'no continuation after the final report turn')
  } finally {
    await rm(harness.base, { recursive: true, force: true })
  }
})

test('repeated assistant output is detected as stagnation', async () => {
  const harness = await makeHarness({
    answers: [approvalAnswer()],
    config: { defaultRounds: 10, maxRounds: 10, stagnationRepeats: 1 },
  })
  try {
    await startTool(harness, { objective: 'Avoid a useless loop' })
    closeTurn(harness)
    assert.equal(await harness.waitFor(() => harness.followups.length === 1), true)

    closeTurn(harness, 'completed', { text: 'the same conclusion' })
    assert.equal(await harness.waitFor(() => harness.followups.length === 2), true)

    closeTurn(harness, 'completed', { text: 'the same conclusion' })
    assert.equal(await harness.waitFor(() => harness.followups.length === 3), true)
    assert.match(harness.followups[2].content[0].text, /<deliberation_finished reason="stagnation">/)

    closeTurn(harness)
    await harness.settle()
    assert.equal(harness.followups.length, 3)
  } finally {
    await rm(harness.base, { recursive: true, force: true })
  }
})

test('a new human message stops automatic continuation', async () => {
  const harness = await makeHarness({ answers: [approvalAnswer()] })
  try {
    await startTool(harness, { objective: 'Yield to the user' })
    const message = { id: 'user-1', source: { kind: 'user' }, content: [{ type: 'text', text: 'stop' }] }
    harness.agent.inbox.nextTurn.push(message)
    harness.emit('agent/inbox/inserted', { agent: harness.agent, message })
    closeTurn(harness)
    await harness.settle()
    assert.equal(harness.followups.length, 0)
  } finally {
    await rm(harness.base, { recursive: true, force: true })
  }
})

test('a non-completed turn end stops the loop without a final prompt', async () => {
  const harness = await makeHarness({ answers: [approvalAnswer()] })
  try {
    await startTool(harness, { objective: 'Do not continue after abort' })
    closeTurn(harness, 'aborted')
    await harness.settle()
    assert.equal(harness.followups.length, 0)
  } finally {
    await rm(harness.base, { recursive: true, force: true })
  }
})

test('deliberation_end stops the loop and persists the summary', async () => {
  const harness = await makeHarness({ answers: [approvalAnswer()] })
  try {
    await startTool(harness, { objective: 'Finish cleanly' })
    closeTurn(harness)
    assert.equal(await harness.waitFor(() => harness.followups.length === 1), true)

    const stopped = await endTool(harness, { summary: 'done with evidence', outcome: 'complete' })
    assert.equal(stopped.status, 'stopped')
    assert.equal(stopped.rounds_used, 1)
    const scratchpad = await readFile(stopped.scratchpad, 'utf8')
    assert.match(scratchpad, /Ended by model \(complete\)/)
    assert.match(scratchpad, /done with evidence/)

    closeTurn(harness)
    await harness.settle()
    assert.equal(harness.followups.length, 1, 'no continuation after an explicit end')
  } finally {
    await rm(harness.base, { recursive: true, force: true })
  }
})

test('worktree approval isolates the scratchpad and ending restores the directory', async () => {
  const worktreePath = path.join(os.tmpdir(), `dsh-deliberation-wt-${Date.now()}`)
  const harness = await makeHarness({
    answers: [approvalAnswer({ worktree: true })],
    worktree: { path: worktreePath, branch: 'deliberation/test', baseCommit: 'abc', repositoryRoot: '' },
  })
  try {
    await mkdir(path.join(harness.base, '.git'), { recursive: true })
    const result = await startTool(harness, { objective: 'Isolated investigation' })
    assert.equal(result.status, 'started')
    assert.equal(result.worktree_path, worktreePath)
    assert.equal(result.worktree_branch, 'deliberation/test')
    assert.equal(harness.questions[0].questions.length, 2)
    assert.equal(harness.questions[0].questions[1].id, 'worktree')
    assert.ok(result.scratchpad.startsWith(worktreePath))
    assert.equal(harness.agent.cwd, worktreePath)

    const stopped = await endTool(harness, { summary: 'isolated work done', outcome: 'complete' })
    assert.equal(stopped.status, 'stopped')
    assert.equal(stopped.worktree_path, worktreePath)
    assert.equal(harness.agent.cwd, harness.base, 'working directory restored')
  } finally {
    await rm(harness.base, { recursive: true, force: true })
    await rm(worktreePath, { recursive: true, force: true })
  }
})

test('isolate=false skips the worktree question even inside a repository', async () => {
  const harness = await makeHarness({ answers: [approvalAnswer()] })
  try {
    await mkdir(path.join(harness.base, '.git'), { recursive: true })
    const result = await startTool(harness, { objective: 'Stay in place', isolate: false })
    assert.equal(result.status, 'started')
    assert.equal(result.worktree_path, '')
    assert.equal(harness.questions[0].questions.length, 1)
  } finally {
    await rm(harness.base, { recursive: true, force: true })
  }
})

test('a second start is rejected while one is active', async () => {
  const harness = await makeHarness({ answers: [approvalAnswer()] })
  try {
    await startTool(harness, { objective: 'First' })
    await assert.rejects(
      () => startTool(harness, { objective: 'Second' }),
      /already active/,
    )
  } finally {
    await rm(harness.base, { recursive: true, force: true })
  }
})

test('an answerer failure declines safely', async () => {
  const harness = await makeHarness({ answers: [new Error('question cancelled')] })
  try {
    const result = await startTool(harness, { objective: 'No answerer' })
    assert.equal(result.status, 'declined')
    assert.match(result.message, /question cancelled/)
  } finally {
    await rm(harness.base, { recursive: true, force: true })
  }
})

let failures = 0
for (const entry of tests) {
  try {
    await entry.fn()
    console.log(`ok - ${entry.name}`)
  } catch (error) {
    failures += 1
    console.error(`not ok - ${entry.name}`)
    console.error(error)
  }
}

if (failures > 0) {
  console.error(`\n${failures} test(s) failed`)
  process.exitCode = 1
} else {
  console.log(`\nall ${tests.length} tests passed`)
}

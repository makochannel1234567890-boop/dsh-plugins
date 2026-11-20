/**
 * dsh-fanout — Host half (v2 kernel).
 *
 * Registers the tools, one prompt section, global settle listeners and the
 * loopback bridge the Web panel talks to. See DESIGN-V2.md for the contract.
 *
 * @module dsh-fanout
 */

import { FRONT_PREFIX, startBridge } from './lib/bridge.js'
import { FanoutKernel } from './lib/kernel.js'
import { DEFAULT_MODEL_EFFORT, DEFAULT_MODEL_PATTERN } from './lib/model.js'
import { clampInt } from './lib/plan.js'
import { registerQueueTools } from './lib/queue-tools.js'
import { defaultStoreDir, FanoutStore } from './lib/store.js'
import { createTeamFace } from './lib/team.js'
import { createWorktreeFace } from './lib/worktree.js'

export const name = 'fanout'

/** Hard dependency: the tool registry. Everything else is resolved lazily. */
export const inject = ['tools']

const SECTION_NAME = 'tool:fanout'
/** After session-bus (2480), before the workflow section (2600). */
const SECTION_ORDER = 2550

const PROMPT_SECTION = `## Fan-out orchestration (dsh-fanout)

This plugin exists for one case: a request that is both **wide** (several large, asymmetric jobs
that can run at the same time) and **deep** (each job is big enough that its own context is worth
keeping small). It is not a general-purpose parallelism switch.

### The composer checkbox
The composer has a fan-out checkbox. When it is checked the user has armed fan-out for the *next*
prompt in this session, and the Host will treat your \`fanout_start\` as the armed path. You are
the parent session: you already run as a single session first, decide the shape of the work, and
only then split it.

### Decide before you split
Judge the request yourself and state your choice in one line.

Do **not** fan out when any of these hold — run the work in this session instead:
- it is one job, or fewer than three genuinely independent jobs;
- it is a **chain**: each step depends on the previous one, so nothing ever runs in parallel;
- the jobs are small enough that reading the files and writing the result is most of the work.

On the armed path the Host enforces this: a narrow or chained task graph is refused with
\`single_session: true\`, and the correct response is to do the work in this session and report
normally — not to retry with \`force: true\`.

### Summon the experts before you split
The plan is where a run is won or lost: a wrong acceptance criterion is paid for by every attempt
plus a review round. When the expert tools are available (\`list_experts\`, \`summon_experts\`), use
them before \`fanout_start\`:

1. Name the 1–3 tasks where being wrong is most expensive — the contract, the risky restructure,
   the screen the user actually looks at.
2. Summon just those experts, in parallel, with a short brief: goal, constraints, and the file
   paths they must read. Experts read the files themselves; never paste the transcript, source,
   CSS, or HTML into the brief.
3. Carry the substance into the task rather than a pointer to it: the critic's criteria go into
   \`acceptance\`, the verifier's commands into \`verify\`, the designer's rules into \`brief\`.
   Record the slugs in \`tasks[].experts\` so the worker brief names the lens it inherits.
4. Say in one line which experts you called, or why none was needed.

Skip it when the roster is empty, the job is mechanical (rename, move, format), or the expert
would only restate the brief. An expert that changes no acceptance criterion was not needed, and
saying so is the right answer: this is an aim, not a toll.

### Decide the two dials yourself
When you do split, **you** choose \`workers\` (concurrent branch sessions) and \`expansion\`
(thought expansion). Do not ask the user, and do not fall back to a cheap default: asking for the
minimum removes the capability the user armed.

- Ask for what the job actually needs, **plus a deliberate margin**: if the widest layer of the
  graph has N jobs, use N + 1 so a freed slot is never idle; if the work is genuinely deep, raise
  \`expansion\` well above the floor.
- State the number you chose and why, in one line, before calling \`fanout_start\`.
- On the armed path the Host already applies a generous floor (widest layer + a spare slot, and a
  depth-scaled expansion floor plus headroom). Passing a *larger* value is honoured; passing a
  smaller one is clamped up.

### One parent session arbitrates the workspace
A workspace has ONE fan-out queue. Before you start anything else, call \`fanout_status\` and
compare what is already live in this directory with what you are about to start:

- **Same objective, or overlapping files** → do not start a second run. Extend the live one:
  \`fanout_enqueue\` for extra jobs (declare \`scope\` paths so two tasks never write one file) or
  \`fanout_control { action: "steer", session_id }\` to correct a running worker.
- **Disjoint scope** → a new run is legitimate; say so in one line.
- **Never** start two runs on the same files: they schedule independently and cancel each other's
  turns. State the decision (extend vs start) and its evidence before acting.

### Nesting: three levels, and no more
A run started from a session that another run created is that run's **child**. The lineage is
root run → child run → grandchild run (\`maxDepth\` 3); a deeper \`fanout_start\` is refused with
\`depth_refused: true\`. Nesting is for a genuinely independent sub-graph inside one branch, not for
splitting the same work twice — prefer \`fanout_enqueue\` into the run that already owns the work.

### The run itself
The run is a task graph, not a flat batch:
- \`tasks[].dependsOn\` turns the batch into a DAG; a task only starts when its dependencies completed.
- \`tasks[].kind\` may be \`work\` (default), \`requirements\`, \`implementation\`, \`verification\`.
  \`implementation\` / \`verification\` are quality kinds: they must carry \`acceptance\` and
  \`verify\` (exact commands), or the run is rejected before anything is spawned.
- A completed task is reviewed by a fresh reviewer session. A failing verdict splices in a
  repair task and another review round; the run escalates to you after \`maxReviewRounds\`.
- The final integrator session must run the verification set and write a parsable report;
  a report without a real command/exit-code table fails the run.

Cost and control:
- \`workers\` caps how many sessions run concurrently; \`expansion\` feeds the thought-expansion
  plan. Every brief is bounded: workers never see this conversation, the integrator only sees
  bounded result digests.
- \`approval: "required"\` stages the plan and spawns nothing until \`fanout_approve\` is called
  (use this for quality plans you want the human to see first). \`approval: "automatic"\` starts now.
- \`fanout_control\` drives a live run: \`pause\`, \`resume\`, \`retry\` (a failed task),
  \`steer\` (message the running session), \`edit\` (a never-started task), \`takeover\` (replace a
  stuck session), \`stop\`. \`fanout_status\` shows tasks, attempts, verdicts and findings.
- The same objective in the same workspace cannot be started twice while the first run is
  active: a duplicate run pays for its own review and integration sessions. Continue the
  existing run (\`resume\`/\`retry\`) or pass \`allowDuplicate: true\` deliberately.
- Runs are file-backed and recover themselves after a Host restart or plugin reload.

When you notice yourself narrowing — a plan that quietly dropped options because the
constraints felt tight — call \`divergence_check\` with the problem statement and your
proposal. It runs fresh probe sessions that never see your proposal, and keeps the gate
closed until you classify every option (adopt / reject / defer with a reason).

Neither tool is for ordinary single-job requests.`

function log(...args) {
  try {
    console.log('[fanout]', ...args)
  } catch {
    // Logging must never break the host loop.
  }
}

function resolveConfig(raw) {
  const config = raw !== null && typeof raw === 'object' ? raw : {}
  const maxWorkers = clampInt(config.maxWorkers, 8, 1, 16)
  const defaultWorkers = Math.min(maxWorkers, clampInt(config.defaultWorkers, 4, 1, 16))
  const maxExpansion = clampInt(config.maxExpansion, 100, 0, 100)
  const defaultExpansion = Math.min(maxExpansion, clampInt(config.defaultExpansion, 40, 0, 100))
  const approvalDefault = config.approvalDefault === 'required' ? 'required' : 'automatic'
  return {
    enabled: config.enabled !== false,
    maxWorkers,
    defaultWorkers,
    maxExpansion,
    defaultExpansion,
    workerTimeoutMinutes: clampInt(config.workerTimeoutMinutes, 25, 2, 240),
    runTimeoutMinutes: clampInt(config.runTimeoutMinutes, 120, 5, 720),
    integrate: config.integrate !== false,
    archiveWorkers: config.archiveWorkers === true,
    review: config.review !== false,
    strictReviewAcceptance: config.strictReviewAcceptance === true,
    maxReviewRounds: clampInt(config.maxReviewRounds, 3, 1, 5),
    maxAttempts: clampInt(config.maxAttempts, 2, 1, 4),
    approvalDefault,
    bridgePort: clampInt(config.bridgePort, 51337, 1024, 65535),
    storeDir:
      typeof config.storeDir === 'string' && config.storeDir.trim().length > 0
        ? config.storeDir.trim()
        : defaultStoreDir(),
    injectPrompt: config.injectPrompt !== false,
    resultDigestChars: clampInt(config.resultDigestChars, 1200, 200, 6000),
    // Context budget: the objective head inlined in every brief, and the cap on
    // one task's own instructions. The full objective is always filed on disk.
    objectiveHeadChars: clampInt(config.objectiveHeadChars, 600, 120, 2000),
    taskBriefChars: clampInt(config.taskBriefChars, 2000, 400, 4000),
    notifyCaller: config.notifyCaller !== false,
    // Which model the run is switched to. `modelPattern` is matched against the
    // live catalog (id, name, provider/id); nothing is ever hardcoded, so a
    // renamed family degrades to "keep the inherited model" instead of failing.
    modelPattern:
      typeof config.modelPattern === 'string' && config.modelPattern.trim().length > 0
        ? config.modelPattern.trim()
        : DEFAULT_MODEL_PATTERN,
    modelEffort: typeof config.modelEffort === 'string' && config.modelEffort.trim().length > 0
      ? config.modelEffort.trim()
      : DEFAULT_MODEL_EFFORT,
    // 3 levels of nesting: root run → child run → grandchild run.
    maxDepth: clampInt(config.maxDepth, 3, 1, 4),
  }
}

const JSON_OUTPUT = {
  schema: { type: 'object' },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
}

const TASK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'brief'],
  properties: {
    id: { type: 'string', description: 'Stable id (defaults to t1, t2, …). Referenced by dependsOn.' },
    title: { type: 'string', description: 'Short job name.' },
    brief: { type: 'string', description: 'Self-contained instructions for this job, including files and acceptance.' },
    weight: { type: 'number', description: 'Relative size (0.25–8); orders ready tasks. Default 1.' },
    scope: { type: 'array', items: { type: 'string' }, description: 'Workspace paths this job may touch.' },
    dependsOn: {
      type: 'array',
      items: { type: ['string', 'number'] },
      description: 'Task ids (or 1-based indexes) that must complete first. Turns the batch into a DAG.',
    },
    kind: {
      type: 'string',
      enum: ['work', 'requirements', 'implementation', 'verification'],
      description: 'Quality kinds (requirements/implementation/verification) require acceptance and verify.',
    },
    objective: { type: 'string', description: 'The contract objective for quality kinds (defaults to title).' },
    acceptance: { type: 'array', items: { type: 'string' }, description: 'Acceptance criteria each attempt must answer.' },
    verify: { type: 'array', items: { type: 'string' }, description: 'Exact commands whose evidence the attempt must attach.' },
    inScope: { type: 'array', items: { type: 'string' }, description: 'Files this task may change.' },
    outOfScope: { type: 'array', items: { type: 'string' }, description: 'Files this task must not change.' },
    review: { type: 'boolean', description: 'Set false to skip the independent review for this task.' },
    experts: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Expert slugs (Agency roster, e.g. engineering-code-reviewer) you actually summoned for this job before splitting. Put their substance in brief/acceptance/verify; the slug names the lens the worker brief inherits.',
    },
  },
}

export function apply(ctx, rawConfig = {}) {
  const settings = resolveConfig(rawConfig)
  if (!settings.enabled) {
    log('disabled by config')
    return
  }

  const store = new FanoutStore(settings.storeDir)
  const kernel = new FanoutKernel({ ctx, store, config: settings, log })
  // The panel is the only Team surface: this face reaches `agents`/`agentTeams`
  // lazily, so fan-out still hard-depends on nothing but `tools`.
  const team = createTeamFace(ctx, log)
  const worktree = createWorktreeFace(ctx, log)
  let bridge
  let unregisterPrefix

  void (async () => {
    try {
      const saved = await store.loadConfig()
      if (saved !== null && typeof saved === 'object') {
        if (Number.isFinite(saved.workers)) {
          settings.defaultWorkers = Math.min(settings.maxWorkers, Math.max(1, Math.floor(saved.workers)))
        }
        if (Number.isFinite(saved.expansion)) {
          settings.defaultExpansion = Math.min(settings.maxExpansion, Math.max(0, Math.floor(saved.expansion)))
        }
      }
    } catch (error) {
      log(`could not load saved UI config: ${String(error)}`)
    }
    await kernel.init()
    try {
      bridge = await startBridge({ engine: kernel, store, config: settings, log, team, worktree })
      log(`bridge listening on 127.0.0.1:${bridge.port}`)
    } catch (error) {
      log(`bridge failed to start: ${String(error)}`)
    }
    // Preferred carrier: the existing Web server, same origin as the page.
    try {
      const webServer = ctx.get('webServer')
      if (bridge !== undefined && webServer !== undefined && typeof webServer.register === 'function') {
        unregisterPrefix = webServer.register({ kind: 'prefix', path: FRONT_PREFIX, handler: bridge.handler })
        log(`mounted ${FRONT_PREFIX} on the web server`)
      }
    } catch (error) {
      log(`could not mount ${FRONT_PREFIX}: ${String(error)}`)
    }
  })()

  // ---------------------------------------------------------------------
  // Tools
  // ---------------------------------------------------------------------

  ctx.tools.register({
    name: 'fanout_start',
    description:
      'Start a fan-out run: a DAG of asymmetric jobs, each executed by its own bounded session on the fan-out model, reviewed by a fresh reviewer, auto-repaired when the review fails, and finally integrated by one session that must run the verification set and write a parsable report. Use when one request contains several large jobs or the user asks to delegate in parallel. Check fanout_status first: extend a live run (fanout_enqueue / fanout_control steer) when its scope overlaps instead of starting a second run. A run started by a session another run created becomes its child; nesting stops at three levels (depth_refused). Nothing spawns when approval is "required" until fanout_approve is called.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['objective', 'tasks'],
      properties: {
        objective: {
          type: 'string',
          description: 'The shared objective in one paragraph. Workers see this, not this conversation.',
        },
        tasks: { type: 'array', minItems: 1, maxItems: 24, items: TASK_SCHEMA, description: 'The job graph.' },
        workers: {
          type: 'number',
          description:
            'Max concurrent branch sessions. On the armed path the parent session sets this itself (widest layer + a spare slot); a smaller value is clamped up to the generous floor.',
        },
        expansion: {
          type: 'number',
          description:
            'Thought-expansion dial 0–100 (0 = no probing). On the armed path the parent session sets this itself, well above the floor when the work is deep.',
        },
        verify: { type: 'array', items: { type: 'string' }, description: 'Run-level verification commands the integrator must execute.' },
        cwd: { type: 'string', description: 'Working directory for every session.' },
        integrate: { type: 'boolean', description: 'Create the final integrator session. Default true.' },
        review: { type: 'boolean', description: 'Enable the independent review + repair loop. Default true.' },
        approval: {
          type: 'string',
          enum: ['automatic', 'required'],
          description: 'required stages the plan; nothing spawns until fanout_approve(run_id).',
        },
        maxReviewRounds: { type: 'number', description: 'Review→repair rounds before escalating (1–5, default 3).' },
        timeoutMinutes: { type: 'number', description: 'Per-session budget in minutes.' },
        allowDuplicate: {
          type: 'boolean',
          description: 'Start even when an active run already has the same objective in this workspace. Default false.',
        },
        force: {
          type: 'boolean',
          description:
            'Run the graph even when it is narrow or a pure chain. Only for an explicit user request: on the armed path the Host refuses such a graph so the work runs in one session instead.',
        },
      },
    },
    output: JSON_OUTPUT,
    timeoutMs: 180000,
    async execute(args, exec) {
      return kernel.start({ ...args, requireTasks: true }, exec?.agent)
    },
    presentCall: (args) => ({
      card: 'generic',
      title: 'Fan-out start',
      kind: 'other',
      rawInput: String(args?.objective ?? '').slice(0, 200),
    }),
  })

  ctx.tools.register({
    name: 'fanout_approve',
    description:
      'Approve a staged fan-out plan (fanout_start with approval:"required") and start it. Spawns the task graph; nothing was created before this call.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['run_id'],
      properties: { run_id: { type: 'string', description: 'The staged run id.' } },
    },
    output: JSON_OUTPUT,
    timeoutMs: 120000,
    async execute(args) {
      const runId = typeof args?.run_id === 'string' ? args.run_id.trim() : ''
      if (runId.length === 0) throw new Error('fanout_approve requires run_id')
      return kernel.approve(runId)
    },
    presentCall: () => ({ card: 'generic', title: 'Fan-out approve', kind: 'other' }),
  })

  ctx.tools.register({
    name: 'fanout_control',
    description:
      'Drive a live fan-out run: pause (stop scheduling), resume, retry a failed task, steer (send guidance into the running session), edit a never-started task, takeover (replace a stuck session), or stop (cancel). Reports the resulting state.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: ['pause', 'resume', 'retry', 'steer', 'edit', 'takeover', 'stop'],
        },
        run_id: { type: 'string', description: 'Run id; omit for the newest run.' },
        task_id: { type: 'string', description: 'Target task for retry/steer/edit/takeover.' },
        message: { type: 'string', description: 'Guidance text for steer.' },
        patch: {
          type: 'object',
          description: 'Fields to change for edit: title, brief, weight, dependsOn, acceptance, verify, inScope, objective.',
        },
        reason: { type: 'string', description: 'Why the run is being stopped.' },
      },
    },
    output: JSON_OUTPUT,
    timeoutMs: 60000,
    async execute(args) {
      return kernel.control(String(args?.action ?? ''), args ?? {})
    },
    presentCall: (args) => ({ card: 'generic', title: `Fan-out ${String(args?.action ?? 'control')}`, kind: 'other' }),
  })

  ctx.tools.register({
    name: 'fanout_status',
    description:
      'Report the state of fan-out runs: task graph with kind/state/deps/attempt/round, review verdicts and findings, gates (staged/paused/escalated), integrator and final report path. Falls back to run.json on disk when the run is not in this process.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { run_id: { type: 'string', description: 'Optional run id; omit for every known run.' } },
    },
    output: JSON_OUTPUT,
    timeoutMs: 15000,
    async execute(args) {
      return kernel.status(typeof args?.run_id === 'string' ? args.run_id : undefined)
    },
    presentCall: () => ({ card: 'generic', title: 'Fan-out status', kind: 'other' }),
  })

  ctx.tools.register({
    name: 'fanout_stop',
    description:
      'Stop a fan-out run: cancels the sessions that are still running, marks the run stopped, and reports which sessions were cancelled. State and result files stay on disk.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        run_id: { type: 'string', description: 'Optional run id; omit for the newest active run.' },
        reason: { type: 'string', description: 'Why the run is being stopped.' },
      },
    },
    output: JSON_OUTPUT,
    timeoutMs: 30000,
    async execute(args) {
      return kernel.stop(
        typeof args?.run_id === 'string' ? args.run_id : undefined,
        typeof args?.reason === 'string' && args.reason.trim().length > 0 ? args.reason.trim() : 'model-request',
      )
    },
    presentCall: () => ({ card: 'generic', title: 'Fan-out stop', kind: 'other' }),
  })

  ctx.tools.register({
    name: 'divergence_check',
    description:
      'Run an independent expansion gate against premature narrowing. Spawns fresh probe sessions that never see your proposal (each gets one orthogonal lens) and returns candidate options. The gate stays closed until you call again with divergence_id and a decision (adopt / reject / defer + reason) for every option; the classification is recorded on disk.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        objective: { type: 'string', description: 'The problem statement, verbatim. Probes see this and one lens — not your proposal.' },
        proposal: { type: 'string', description: 'Your current plan or conclusion. Stored for the record; never sent to the probes.' },
        constraints: { type: 'array', items: { type: 'string' }, description: 'Constraints you believe bind the problem.' },
        intensity: { type: 'number', description: '1–5. Maps to 1/2/3/5/8 orthogonal probe axes. Default from the expansion slider.' },
        divergence_id: { type: 'string', description: 'Report-phase id; required when sending decisions.' },
        decisions: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['option_id', 'decision', 'reason'],
            properties: {
              option_id: { type: 'string' },
              decision: { type: 'string', enum: ['adopt', 'reject', 'defer'] },
              reason: { type: 'string' },
            },
          },
          description: 'One entry per option returned by the report phase.',
        },
      },
    },
    output: JSON_OUTPUT,
    timeoutMs: 150000,
    async execute(args, exec) {
      return kernel.divergence(args, exec?.agent)
    },
    presentCall: (args) => ({
      card: 'generic',
      title: 'Divergence gate',
      kind: 'other',
      rawInput: String(args?.objective ?? args?.divergence_id ?? '').slice(0, 200),
    }),
  })

  // ---------------------------------------------------------------------
  // Prompt + events
  // ---------------------------------------------------------------------

  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt !== undefined && settings.injectPrompt) {
    try {
      systemPrompt.section({ name: SECTION_NAME, order: SECTION_ORDER, text: PROMPT_SECTION })
    } catch (error) {
      log(`prompt section failed: ${String(error)}`)
    }
  }

  const listen = (eventName, handler) => {
    try {
      ctx.on(eventName, handler, { global: true })
    } catch (error) {
      log(`could not listen on ${eventName}: ${String(error)}`)
    }
  }
  listen('api-session/status', (sessionId, running) => {
    kernel.observeStatus(sessionId, running)
  })
  listen('session/event', (session, event) => {
    kernel.observeSessionEvent(session, event)
  })

  ctx.effect(() => () => {
    kernel.dispose()
    if (typeof unregisterPrefix === 'function') {
      try {
        unregisterPrefix()
      } catch {
        // Route already removed.
      }
    }
    if (bridge !== undefined) void bridge.stop()
  })

  // The append-only queue layer: one queue per workspace, append instead of a
  // second run, write-claim admission so two sessions never edit one file.
  registerQueueTools({ ctx, kernel, settings, log })

  log(`active (store=${settings.storeDir}, bridge port ${settings.bridgePort}, kernel v2)`)
}

// v2 kernel — history entries read finalPath from run.json so a cleaned workspace never leaves a dead link.


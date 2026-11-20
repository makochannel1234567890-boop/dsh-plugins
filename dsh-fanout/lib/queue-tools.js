/**
 * dsh-fanout — the append-only queue tools (the parent's task list).
 *
 * Registered from `index.js` in one call so the queue layer stays a separate,
 * testable unit from the run lifecycle in `lib/kernel.js`.
 *
 * The contract this enforces:
 *   - one workspace has one queue; new work is appended to the live run instead
 *     of starting a competing run that schedules its own sessions;
 *   - a task may name an existing session (`session_id`) instead of spawning a
 *     new one, so a parent that already knows a session keeps using it;
 *   - the parent session orchestrates (append / steer / re-plan) and does not
 *     write the code itself.
 *
 * @module dsh-fanout/lib/queue-tools
 */

import path from 'node:path'

import { findQueueRun } from './queue.js'

const SECTION_NAME = 'tool:fanout-queue'
/** Directly after the main fan-out section (2550). */
const SECTION_ORDER = 2551

const PROMPT_SECTION = `## The fan-out queue (dsh-fanout)

One workspace has ONE queue. Once a run exists, further work goes into it with
\`fanout_enqueue\` — never a second \`fanout_start\` in the same directory. Two runs
schedule independently, so their sessions end up editing the same files and
cancel each other's turns.

Appending:
- \`fanout_enqueue({ tasks: [...] })\` finds the live queue for this workspace by itself; pass
  \`run_id\` only to target a specific one. With no live queue it creates one from \`objective\`.
- Appended tasks may \`dependsOn\` tasks that are already in the queue ("3 more jobs that follow
  the work already running").
- \`group\` labels a batch, so several appended batches stay readable as teams/waves.

Declare what each task writes — this is the collision fix, not paperwork:
- \`scope\` / \`inScope\` list the paths the task may modify. Two tasks whose paths overlap are
  never scheduled at the same time: the second stays \`pending\` and starts when the first
  settles. A task that declares nothing can still collide with anything.
- \`fanout_status\` reports \`queue.scope_blocked\` (who holds the path) and \`queue.unclaimed\`
  (tasks that never declared one). Fix a blocked task by narrowing its scope, not by retrying.

Re-using a session you already know:
- \`fanout_enqueue\` tasks accept \`session_id\`: that task is prompted into the session instead
  of spawning a new one. Prefer this when a session is already loaded with the context.
- \`fanout_control({ action: "steer", session_id })\` sends a follow-up instruction to any
  session this plugin tracks (worker, reviewer, integrator) — use it instead of spawning a
  second session to say one more thing.

The parent session does not write the code. It shapes the work, appends tasks, steers the
sessions it knows, and re-plans when the queue changes shape.`

const TASK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'brief'],
  properties: {
    id: { type: 'string', description: 'Stable id (defaults to the next free tN). Referenced by dependsOn.' },
    title: { type: 'string', description: 'Short job name.' },
    brief: { type: 'string', description: 'Self-contained instructions for this job, including files and acceptance.' },
    weight: { type: 'number', description: 'Relative size (0.25–8); orders ready tasks. Default 1.' },
    scope: {
      type: 'array',
      items: { type: 'string' },
      description: 'Workspace paths this job may write. Two tasks whose paths overlap never run at the same time.',
    },
    dependsOn: {
      type: 'array',
      items: { type: ['string', 'number'] },
      description: 'Task ids already in the queue (or appended in the same call) that must complete first.',
    },
    group: { type: 'string', description: 'Batch label, so appended waves stay readable as teams.' },
    kind: {
      type: 'string',
      enum: ['work', 'requirements', 'implementation', 'verification'],
      description: 'Quality kinds (requirements/implementation/verification) require acceptance and verify.',
    },
    objective: { type: 'string', description: 'The contract objective for quality kinds (defaults to title).' },
    acceptance: { type: 'array', items: { type: 'string' }, description: 'Acceptance criteria each attempt must answer.' },
    verify: { type: 'array', items: { type: 'string' }, description: 'Exact commands whose evidence the attempt must attach.' },
    inScope: { type: 'array', items: { type: 'string' }, description: 'Files this task may change (same rule as scope).' },
    outOfScope: { type: 'array', items: { type: 'string' }, description: 'Files this task must not change.' },
    review: { type: 'boolean', description: 'Set false to skip the independent review for this task.' },
    experts: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Expert slugs you actually summoned for this job. Their substance belongs in brief/acceptance/verify; the slug names the lens the worker inherits.',
    },
    session_id: {
      type: 'string',
      description:
        'Prompt this task into an existing session instead of creating one. The session must not already be running a fan-out task.',
    },
  },
}

const JSON_OUTPUT = {
  schema: { type: 'object' },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
}

function deriveObjective(tasks) {
  const titles = tasks
    .map((task) => (task !== null && typeof task === 'object' ? String(task.title ?? task.name ?? '').trim() : ''))
    .filter((title) => title.length > 0)
    .slice(0, 3)
  const head = titles.length > 0 ? titles.join(' / ') : 'appended work'
  return `Task queue: ${head}`.slice(0, 400)
}

/**
 * Register the queue tool and its prompt section.
 *
 * @param {{ ctx: object, kernel: object, settings?: object, log?: (...args: unknown[]) => void }} deps
 */
export function registerQueueTools({ ctx, kernel, settings = {}, log = () => {} }) {
  ctx.tools.register({
    name: 'fanout_enqueue',
    description:
      'Append tasks to the workspace\'s single fan-out queue (creating it when none is live). Use this instead of a second fanout_start in the same directory: the queue is what keeps two sessions from editing the same files at once. Declare scope/inScope for each task, and optionally session_id to reuse a session you already know.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['tasks'],
      properties: {
        tasks: { type: 'array', minItems: 1, maxItems: 24, items: TASK_SCHEMA, description: 'Tasks to append.' },
        run_id: { type: 'string', description: 'Target queue. Omit to use the live run for this workspace.' },
        objective: { type: 'string', description: 'Only when creating a queue: the shared objective.' },
        cwd: { type: 'string', description: 'Workspace to resolve the queue in. Defaults to the caller\'s directory.' },
        workers: { type: 'number', description: 'Concurrent sessions for the queue (1–16).' },
        expansion: { type: 'number', description: 'Thought-expansion dial 0–100, when creating.' },
        verify: { type: 'array', items: { type: 'string' }, description: 'Run-level verification commands, when creating.' },
        approval: {
          type: 'string',
          enum: ['automatic', 'required'],
          description: 'When creating: required stages the plan until fanout_approve.',
        },
        create: {
          type: 'boolean',
          description: 'Create the queue when none is live (default true). Set false to only append to an existing one.',
        },
      },
    },
    output: JSON_OUTPUT,
    timeoutMs: 180000,
    async execute(args, exec) {
      const request = args ?? {}
      const tasks = Array.isArray(request.tasks) ? request.tasks : []
      if (tasks.length === 0) throw new Error('fanout_enqueue requires a non-empty tasks array')
      const cwd = typeof request.cwd === 'string' && request.cwd.trim().length > 0
        ? path.resolve(request.cwd.trim())
        : kernel.callerCwd(exec?.agent)
      const explicitRunId = typeof request.run_id === 'string' ? request.run_id.trim() : ''
      const run = explicitRunId.length > 0
        ? await kernel.requireRun(explicitRunId)
        : findQueueRun(kernel.runs.values(), cwd)

      if (run === undefined) {
        if (request.create === false) {
          throw new Error(`no live fan-out queue in ${cwd}; call fanout_enqueue without create:false (or fanout_start) to open one`)
        }
        const objective = typeof request.objective === 'string' && request.objective.trim().length > 0
          ? request.objective.trim()
          : deriveObjective(tasks)
        log(`queue created in ${cwd} (${tasks.length} task(s))`)
        const started = await kernel.start(
          {
            objective,
            tasks,
            cwd,
            workers: request.workers,
            expansion: request.expansion,
            verify: request.verify,
            approval: request.approval ?? settings.approvalDefault,
            requireTasks: true,
          },
          exec?.agent,
        )
        return { mode: 'created', run_id: started?.run_id ?? '', ...started }
      }

      const appended = await kernel.appendTasks(run.id, { tasks, workers: request.workers })
      return { mode: 'appended', cwd, ...appended }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: 'Fan-out enqueue',
      kind: 'other',
      rawInput: String((args?.tasks ?? []).length) + ' task(s)',
    }),
  })

  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt !== undefined && settings.injectPrompt !== false) {
    try {
      systemPrompt.section({ name: SECTION_NAME, order: SECTION_ORDER, text: PROMPT_SECTION })
    } catch (error) {
      log(`queue prompt section failed: ${String(error)}`)
    }
  }

  log('queue tools registered (fanout_enqueue)')
}

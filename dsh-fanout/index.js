/**
 * dsh-fanout — Host half.
 *
 * Registers four tools, one prompt section, global settle listeners and the
 * loopback bridge the Web panel talks to. See DESIGN.md for the contract.
 *
 * @module dsh-fanout
 */

import { FRONT_PREFIX, startBridge } from './lib/bridge.js'
import { FanoutEngine } from './lib/engine.js'
import { clampInt } from './lib/plan.js'
import { defaultStoreDir, FanoutStore } from './lib/store.js'

export const name = 'fanout'

/** Hard dependency: the tool registry. Everything else is resolved lazily. */
export const inject = ['tools']

const SECTION_NAME = 'tool:fanout'
/** After session-bus (2480), before the workflow section (2600). */
const SECTION_ORDER = 2550

const PROMPT_SECTION = `## Fan-out orchestration (dsh-fanout)

When the user hands over several large, unevenly sized jobs at once — or explicitly asks to
"fan out", "委託して並列で", "分岐して", or to keep one session's context small while many
big jobs run — call \`fanout_start\` with the objective and one entry per asymmetric job
(\`title\`, \`brief\`, optional \`weight\`). The plugin creates the worker sessions itself,
packs the jobs by weight, keeps every brief small, and automatically starts one integrator
session that merges the results, runs e2e verification and the build, and reports back into
this session. Do not spawn the workers yourself with subagent/workflow tools when
\`fanout_start\` is available: it is the same work with bounded context and durable state.

When you notice yourself narrowing — a plan that quietly dropped options because the
constraints felt tight — call \`divergence_check\` with the problem statement and your
proposal. It runs fresh probe sessions that never see your proposal, returns candidate
options, and keeps the gate closed until you classify every option (adopt / reject / defer
with a reason). Treat the classification as the price of proceeding.

Neither tool is for ordinary single-job requests. Use \`fanout_status\` / \`fanout_stop\` to
inspect or stop a run. The web panel above the composer exposes the same two dials
(branch sessions, thought expansion) for runs the user starts from the UI.`

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
    bridgePort: clampInt(config.bridgePort, 51337, 1024, 65535),
    storeDir:
      typeof config.storeDir === 'string' && config.storeDir.trim().length > 0
        ? config.storeDir.trim()
        : defaultStoreDir(),
    injectPrompt: config.injectPrompt !== false,
    resultDigestChars: clampInt(config.resultDigestChars, 1200, 200, 6000),
    notifyCaller: config.notifyCaller !== false,
  }
}

const JSON_OUTPUT = {
  schema: { type: 'object' },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
}

export function apply(ctx, rawConfig = {}) {
  const settings = resolveConfig(rawConfig)
  if (!settings.enabled) {
    log('disabled by config')
    return
  }

  const store = new FanoutStore(settings.storeDir)
  const engine = new FanoutEngine({ ctx, store, config: settings, log })
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
    await engine.init()
    try {
      bridge = await startBridge({ engine, store, config: settings, log })
      log(`bridge listening on 127.0.0.1:${bridge.port}`)
    } catch (error) {
      log(`bridge failed to start: ${String(error)}`)
    }
    // Preferred carrier: the existing Web server, same origin as the page.
    try {
      const webServer = ctx.get('webServer')
      if (
        bridge !== undefined &&
        webServer !== undefined &&
        typeof webServer.register === 'function'
      ) {
        unregisterPrefix = webServer.register({
          kind: 'prefix',
          path: FRONT_PREFIX,
          handler: bridge.handler,
        })
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
      'Start a multi-session fan-out for several large, unevenly sized jobs. Creates the worker sessions, auto-packs the jobs by weight, keeps each brief small, then automatically creates one integrator session that merges the results, runs e2e verification and the build, and reports back into this session. Use when one request contains several big asymmetric jobs or the user asks to delegate in parallel.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['objective', 'tasks'],
      properties: {
        objective: {
          type: 'string',
          description: 'The shared objective in one paragraph. Workers see this, not this conversation.',
        },
        tasks: {
          type: 'array',
          minItems: 1,
          maxItems: 24,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['title', 'brief'],
            properties: {
              title: { type: 'string', description: 'Short job name.' },
              brief: {
                type: 'string',
                description: 'Self-contained instructions for this job, including files and acceptance.',
              },
              weight: {
                type: 'number',
                description: 'Relative size (0.25–8). Used to balance workers; default 1.',
              },
              scope: {
                type: 'array',
                items: { type: 'string' },
                description: 'Workspace paths this job may touch.',
              },
            },
          },
          description: 'The asymmetric jobs. The plugin packs them into the worker sessions.',
        },
        workers: { type: 'number', description: 'Number of branch sessions (1–8). Default from the UI slider.' },
        expansion: {
          type: 'number',
          description: 'Thought-expansion dial 0–100 carried into the run estimate (0 = no probing).',
        },
        verify: {
          type: 'array',
          items: { type: 'string' },
          description: 'Exact commands the integrator must run (e2e, build).',
        },
        cwd: { type: 'string', description: 'Working directory for the workers and the integrator.' },
        integrate: { type: 'boolean', description: 'Create the final integrator session. Default true.' },
        timeoutMinutes: { type: 'number', description: 'Per-worker budget in minutes.' },
      },
    },
    output: JSON_OUTPUT,
    timeoutMs: 120000,
    async execute(args, exec) {
      const caller = exec?.agent
      if (caller === undefined) throw new Error('fanout_start requires a live calling agent')
      return engine.start({ ...args, requireTasks: true }, caller)
    },
    presentCall: (args) => ({
      card: 'generic',
      title: 'Fan-out start',
      kind: 'other',
      rawInput: String(args?.objective ?? '').slice(0, 200),
    }),
  })

  ctx.tools.register({
    name: 'fanout_status',
    description:
      'Report the state of fan-out runs in this process: worker sessions, their settle state, the integrator, the final report path, and the estimate.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        run_id: { type: 'string', description: 'Optional run id; omit for every live run.' },
      },
    },
    output: JSON_OUTPUT,
    timeoutMs: 15000,
    async execute(args) {
      return engine.status(typeof args?.run_id === 'string' ? args.run_id : undefined)
    },
    presentCall: () => ({ card: 'generic', title: 'Fan-out status', kind: 'other' }),
  })

  ctx.tools.register({
    name: 'fanout_stop',
    description:
      'Stop a fan-out run: cancels the worker and integrator turns that are still running, marks the run stopped, and reports which sessions were cancelled.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        run_id: { type: 'string', description: 'Optional run id; omit for the newest running run.' },
        reason: { type: 'string', description: 'Why the run is being stopped.' },
      },
    },
    output: JSON_OUTPUT,
    timeoutMs: 30000,
    async execute(args) {
      return engine.stop(
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
        objective: {
          type: 'string',
          description: 'The problem statement, verbatim. Probes see this and one lens — not your proposal.',
        },
        proposal: {
          type: 'string',
          description: 'Your current plan or conclusion. Stored for the record; never sent to the probes.',
        },
        constraints: {
          type: 'array',
          items: { type: 'string' },
          description: 'Constraints you believe bind the problem.',
        },
        intensity: {
          type: 'number',
          description: '1–5. Maps to 1/2/3/5/8 orthogonal probe axes. Default from the expansion slider.',
        },
        divergence_id: {
          type: 'string',
          description: 'Report-phase id; required when sending decisions.',
        },
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
      const caller = exec?.agent
      if (caller === undefined) throw new Error('divergence_check requires a live calling agent')
      return engine.divergence(args, caller)
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
    engine.observeStatus(sessionId, running)
  })
  listen('session/event', (session, event) => {
    engine.observeSessionEvent(session, event)
  })

  ctx.effect(() => () => {
    engine.dispose()
    if (typeof unregisterPrefix === 'function') {
      try {
        unregisterPrefix()
      } catch {
        // Route already removed.
      }
    }
    if (bridge !== undefined) void bridge.stop()
  })

  log(`active (store=${settings.storeDir}, bridge port ${settings.bridgePort})`)
}

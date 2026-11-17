/**
 * dsh-deliberation — bounded extended-deliberation mode for DeepSeek Harness.
 *
 * Flow:
 *   1. The model calls `deliberation_start` when the user asks for prolonged
 *      thinking or the task is an open-ended high-complexity investigation.
 *   2. The tool asks the user for approval through the normal question UI
 *      (`ctx.userQuestions.ask`), including an optional Git-worktree isolation
 *      choice when the session directory is inside a repository.
 *   3. After approval the plugin arms a per-agent supervisor. Each time the
 *      agent becomes idle after a turn, the supervisor queues one bounded
 *      continuation turn with `agent.followup(...)` (the same public mechanism
 *      the built-in goal-round driver uses).
 *   4. Safety rails: round budget, wall-clock budget, stagnation detection from
 *      repeated assistant text / repeated tool calls, user-message priority,
 *      non-completed turn endings, errors, and `deliberation_end`.
 *
 * State is process-local and keyed by the live Agent object: it is deliberately
 * not written into the session log (the session log is the model's source of
 * truth and unknown event types would break replay). The durable artifact is
 * the human-readable scratchpad file created in the session directory.
 *
 * @module dsh-deliberation
 */

import { createHash, randomUUID } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import path from 'node:path'

export const name = 'deliberation'

/** Services this plugin requires. Optional services are resolved through `ctx.get`. */
export const inject = ['agents', 'tools', 'userQuestions']

const SECTION_NAME = 'tool:deliberation'
/** Between the goal section (2400) and the workflow section (2600). */
const SECTION_ORDER = 2450

const SOURCE_KIND = 'deliberation'

export const labels = Object.freeze({
  approve: '承認して開始 (Approve)',
  cancel: 'キャンセル (Cancel)',
  worktreeYes: 'ワークツリーで隔離 (Isolate)',
  worktreeNo: '現在の場所で続行 (Stay)',
})

const DEFAULT_CONFIG = Object.freeze({
  defaultRounds: 8,
  maxRounds: 24,
  defaultMinutes: 45,
  maxMinutes: 120,
  offerWorktree: true,
  restoreWorkingDirectoryOnStop: true,
  stagnationRepeats: 2,
})

/**
 * Minimal equivalent of the Harness `createUserMessage` helper. This bundle
 * intentionally imports only Node builtins so it can resolve from wherever the
 * profile links the checkout; the shape matches `dsh-llm`'s factory (the input
 * fields plus a fresh id and the user role).
 */
function createUserMessage(input) {
  return Object.freeze({ ...input, id: randomUUID(), role: 'user' })
}

const PROMPT_SECTION = `## Extended deliberation (dsh-deliberation)

When the user explicitly asks for prolonged, deep, or unhurried thinking — for example "長考", "熟考", "think it through", "take your time", "deep research", or a request to keep working on an open-ended investigation — call \`deliberation_start\` before doing the long work. It asks the user for approval, offers Git-worktree isolation when the directory is a repository, and then automatically continues the work across a bounded number of rounds.

Do not call it for ordinary tasks or when the user only wants a quick answer. During an approved deliberation: continue the investigation, keep the scratchpad current, verify claims against tool results instead of earlier narration, and call \`deliberation_end\` when the objective is answered or genuinely blocked. A new user message stops the automatic continuation; never fight the user. The supervisor also stops at the round/time budget or when repeated output shows stagnation.`

function hash(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

function normalizeText(value) {
  return value.replace(/\s+/g, ' ').trim()
}

function nowIso() {
  return new Date().toISOString()
}

function clampInt(value, fallback, min, max) {
  const candidate = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback
  return Math.min(max, Math.max(min, candidate))
}

function resolveConfig(config = {}) {
  const defaultRounds = clampInt(config.defaultRounds, DEFAULT_CONFIG.defaultRounds, 1, 100)
  const maxRounds = Math.max(defaultRounds, clampInt(config.maxRounds, DEFAULT_CONFIG.maxRounds, 1, 200))
  const defaultMinutes = clampInt(config.defaultMinutes, DEFAULT_CONFIG.defaultMinutes, 1, 600)
  const maxMinutes = Math.max(defaultMinutes, clampInt(config.maxMinutes, DEFAULT_CONFIG.maxMinutes, 1, 1440))
  return {
    defaultRounds,
    maxRounds,
    defaultMinutes,
    maxMinutes,
    offerWorktree: config.offerWorktree !== false,
    restoreWorkingDirectoryOnStop: config.restoreWorkingDirectoryOnStop !== false,
    stagnationRepeats: clampInt(config.stagnationRepeats, DEFAULT_CONFIG.stagnationRepeats, 1, 10),
  }
}

function shortSessionId(agent) {
  const raw = typeof agent?.id === 'string' ? agent.id : String(agent?.id ?? 'session')
  return raw.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 28) || 'session'
}

function truncate(value, max) {
  const text = String(value ?? '')
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

/** Walk up from `cwd` looking for a `.git` directory or worktree file. */
async function detectGitRepo(cwd) {
  let current = path.resolve(cwd)
  for (;;) {
    try {
      const stat = await fsp.stat(path.join(current, '.git'))
      if (stat.isDirectory() || stat.isFile()) return true
    } catch {
      // Not a repository marker at this level.
    }
    const parent = path.dirname(current)
    if (parent === current) return false
    current = parent
  }
}

/** The last `turn/end` event in a tail, if the turn already closed durably. */
function findLastTurnEnd(tail) {
  for (let index = tail.length - 1; index >= 0; index -= 1) {
    if (tail[index].type === 'turn/end') return tail[index]
  }
  return undefined
}

/**
 * Fold one round's appended events into the signals used for stagnation
 * detection: assistant text hash, exact tool-call hash, and duplicate-call count.
 */
function roundSignature(events) {
  const texts = []
  const calls = []
  for (const event of events) {
    if (event.type === 'assistant/message') {
      const message = event.data?.message
      if (message !== undefined && Array.isArray(message.content)) {
        for (const block of message.content) {
          if (block !== null && block !== undefined && block.type === 'text' && typeof block.text === 'string') {
            texts.push(block.text)
          }
        }
      }
    } else if (event.type === 'tool/call') {
      const callName = typeof event.data?.name === 'string' ? event.data.name : ''
      let argumentsText = ''
      try {
        argumentsText = typeof event.data?.arguments === 'string'
          ? event.data.arguments
          : JSON.stringify(event.data?.arguments ?? null)
      } catch {
        argumentsText = '[unserializable]'
      }
      calls.push(`${callName}\u0000${argumentsText}`)
    }
  }
  const text = normalizeText(texts.join('\n'))
  const counts = new Map()
  for (const call of calls) counts.set(call, (counts.get(call) ?? 0) + 1)
  let maxRepeat = 0
  for (const count of counts.values()) maxRepeat = Math.max(maxRepeat, count)
  return {
    textHash: hash(text),
    toolHash: hash(calls.join('\n')),
    textLength: text.length,
    callCount: calls.length,
    maxRepeat,
  }
}

function isStagnant(previous, current) {
  if (previous === undefined || current === undefined) return false
  const repeatedText = current.textLength > 0 && current.textHash === previous.textHash
  const repeatedTools = current.callCount > 0 && current.toolHash === previous.toolHash
  const repeatedEmptyRound = current.callCount === 0 && previous.callCount === 0 && current.textLength === 0 && previous.textLength === 0
  const repeatingMicroLoop = current.maxRepeat >= 3 && previous.maxRepeat >= 3
  return (repeatedText && repeatedTools)
    || (repeatedText && current.callCount === 0 && previous.callCount === 0)
    || (repeatedTools && current.textLength === 0 && previous.textLength === 0)
    || repeatedEmptyRound
    || repeatingMicroLoop
}

function signatureBrief(signature) {
  return `- assistant text: ${signature.textLength} chars · tool calls: ${signature.callCount} · max identical call: ${signature.maxRepeat}`
}

function renderRoundPrompt(state) {
  const elapsedMinutes = Math.max(0, Math.round((Date.now() - state.startedAt) / 60000))
  const worktree = state.worktree === undefined
    ? 'none'
    : `${state.worktree.path} (branch: ${state.worktree.branch})`
  const note = state.note.length > 0 ? `User note: ${state.note}\n` : ''
  return `<deliberation_round>
Objective: ${JSON.stringify(state.objective)}
Round: ${state.roundsStarted}/${state.maxRounds} · elapsed: ${elapsedMinutes}m/${state.maxMinutes}m
Worktree: ${worktree}
Scratchpad: ${state.scratchpad.length > 0 ? state.scratchpad : '(unavailable)'}
${note}
Continue this approved deliberation autonomously. Work from the session log, the workspace, and tool results; verify instead of assuming earlier narration is still current. Before ending this round, append a concise progress note to the scratchpad: what you established, what is still uncertain, and the next concrete step. If the objective is answered or you are genuinely blocked, call deliberation_end with a summary. Do not repeat the same analysis or the same tool call; if you notice stagnation, stop and report it.
</deliberation_round>`
}

function renderFinalPrompt(state, reason, restored) {
  const elapsedMinutes = Math.max(0, Math.round((Date.now() - state.startedAt) / 60000))
  const worktree = state.worktree === undefined
    ? 'none'
    : `${state.worktree.path} (branch: ${state.worktree.branch})`
  const why = reason === 'stagnation'
    ? 'The last rounds repeated without new progress; the supervisor stopped the run to avoid a loop.'
    : 'The approved round/time budget is finished.'
  const directoryLine = restored
    ? `The session working directory is back to ${state.originalCwd}.`
    : state.worktree === undefined
      ? ''
      : `The session remains in the worktree ${state.worktree.path}.`
  return `<deliberation_finished reason="${reason}">
Objective: ${JSON.stringify(state.objective)}
Rounds used: ${state.roundsStarted}/${state.maxRounds} · elapsed: ${elapsedMinutes}m/${state.maxMinutes}m
Worktree: ${worktree}
Scratchpad: ${state.scratchpad.length > 0 ? state.scratchpad : '(unavailable)'}
${directoryLine}

${why} Do not start a new investigation or tool-heavy work. Write the closing report to the user now: the outcome, the evidence you actually gathered in this session, what remains uncertain, and where the scratchpad/worktree are. If progress stalled, state the concrete blocker and what you need next. Do not call deliberation_end; the supervisor already ended the run.
</deliberation_finished>`
}

function renderApprovalDetail({ objective, rounds, minutes, git, offerWorktree }) {
  const isolation = git
    ? offerWorktree
      ? '隔離: Git ワークツリーを作成できます。'
      : '隔離: 使用しません。'
    : '隔離: このディレクトリは Git リポジトリではないため利用できません。'
  return [
    `目的: ${truncate(objective, 600)}`,
    `予算: ${rounds} ラウンド / ${minutes} 分`,
    isolation,
    '承認後は、このターンが終わるたびに自動で次のラウンドを開始します。新しいメッセージを送ると自動継続は止まります。',
  ].join('\n')
}

function declinedResult(message) {
  return {
    status: 'declined',
    rounds: 0,
    minutes: 0,
    worktree_path: '',
    worktree_branch: '',
    scratchpad: '',
    message,
  }
}

const START_OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['status', 'rounds', 'minutes', 'worktree_path', 'worktree_branch', 'scratchpad', 'message'],
    properties: {
      status: { type: 'string', enum: ['started', 'declined'] },
      rounds: { type: 'integer' },
      minutes: { type: 'integer' },
      worktree_path: { type: 'string' },
      worktree_branch: { type: 'string' },
      scratchpad: { type: 'string' },
      message: { type: 'string' },
    },
  },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
}

const END_OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['status', 'rounds_used', 'elapsed_seconds', 'worktree_path', 'worktree_branch', 'scratchpad', 'message'],
    properties: {
      status: { type: 'string', enum: ['stopped', 'inactive'] },
      rounds_used: { type: 'integer' },
      elapsed_seconds: { type: 'integer' },
      worktree_path: { type: 'string' },
      worktree_branch: { type: 'string' },
      scratchpad: { type: 'string' },
      message: { type: 'string' },
    },
  },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
}

export function apply(ctx, config = {}) {
  const settings = resolveConfig(config)
  /** Live deliberation sessions, keyed by the exact live Agent object. */
  const states = new Map()
  let disposed = false

  const log = (message) => {
    try {
      ctx.logger?.warn?.(message)
    } catch {
      // Logging must never break the driver.
    }
  }

  const workingDirectory = () => ctx.get('workingDirectory')
  const worktrees = () => ctx.get('worktrees')

  function currentCwd(agent) {
    try {
      const value = workingDirectory()?.get(agent.session)
      if (typeof value === 'string' && value.length > 0) return value
    } catch {
      // Fall through to the process directory.
    }
    return process.cwd()
  }

  async function writeScratchpadBrief(state, cwd) {
    try {
      const directory = path.join(cwd, '.dsh-deliberation')
      const file = path.join(directory, `${shortSessionId(state.agent)}-${Date.now().toString(36)}.md`)
      await fsp.mkdir(directory, { recursive: true })
      const brief = [
        '# Extended deliberation',
        '',
        `- Objective: ${state.objective}`,
        `- Budget: ${state.maxRounds} rounds / ${state.maxMinutes} minutes`,
        `- Started: ${nowIso()}`,
        `- Session: ${String(state.agent.id)}`,
        `- Isolation: ${state.worktree === undefined ? 'none' : `${state.worktree.path} (branch: ${state.worktree.branch})`}`,
        ...(state.note.length > 0 ? [`- User note: ${state.note}`] : []),
        '',
        'Each round appends progress here. The supervisor stops at the round/time',
        'budget, on repeated output, or when the user sends a new message.',
        '',
      ].join('\n')
      await fsp.writeFile(file, brief, 'utf8')
      return file
    } catch (error) {
      log(`dsh-deliberation: could not write scratchpad brief: ${String(error)}`)
      return ''
    }
  }

  async function appendScratchpad(state, text) {
    if (state.scratchpad.length === 0) return
    try {
      await fsp.appendFile(state.scratchpad, text, 'utf8')
    } catch (error) {
      log(`dsh-deliberation: could not append to scratchpad: ${String(error)}`)
    }
  }

  async function restoreWorkingDirectory(agent, state) {
    if (state.worktree === undefined) return false
    if (!settings.restoreWorkingDirectoryOnStop) return false
    if (ctx.agents.get(agent.id) !== agent) return false
    try {
      const service = workingDirectory()
      if (service === undefined) return false
      await service.set(agent, state.originalCwd)
      return true
    } catch (error) {
      log(`dsh-deliberation: could not restore working directory: ${String(error)}`)
      return false
    }
  }

  async function finish(agent, state, reason) {
    if (state.finished) return
    state.finished = true
    if (states.get(agent) === state) states.delete(agent)
    await appendScratchpad(state, `\n## Deliberation ended (${reason}) at ${nowIso()}\n`)
    const restored = await restoreWorkingDirectory(agent, state)
    if (reason !== 'rounds' && reason !== 'time' && reason !== 'stagnation') return
    if (ctx.agents.get(agent.id) !== agent) return
    try {
      const text = renderFinalPrompt(state, reason, restored)
      const message = createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: SOURCE_KIND, form: 'final', reason },
      })
      agent.followup(message)
    } catch (error) {
      log(`dsh-deliberation: could not queue the final report turn: ${String(error)}`)
    }
  }

  function queuedUserMessage(agent) {
    const isHuman = (message) => message?.source?.kind === 'user'
    return agent.inbox.nextTurn.some(isHuman) || agent.inbox.nextStep.some(isHuman)
  }

  async function drive(agent) {
    const state = states.get(agent)
    if (state === undefined || state.finished || disposed) return
    if (ctx.agents.get(agent.id) !== agent) {
      states.delete(agent)
      return
    }
    if (agent.status !== 'idle') return

    if (state.agentError !== undefined) {
      await finish(agent, state, 'agent-error')
      return
    }
    if (state.userInterrupted || queuedUserMessage(agent)) {
      await finish(agent, state, 'user-input')
      return
    }

    const events = agent.session.snapshotEvents()
    const tail = events.slice(state.roundStartSeq)
    const lastEnd = findLastTurnEnd(tail)
    if (lastEnd !== undefined) {
      const reasonKind = lastEnd.data?.reason?.kind
      if (reasonKind !== 'completed') {
        await finish(agent, state, `turn-${String(reasonKind)}`)
        return
      }
    }

    if (state.roundsStarted > 0) {
      const signature = roundSignature(tail)
      if (state.lastSignature !== undefined && isStagnant(state.lastSignature, signature)) {
        state.stagnation += 1
      } else {
        state.stagnation = 0
      }
      state.lastSignature = signature
      await appendScratchpad(
        state,
        `\n### Round ${state.roundsStarted} finished at ${nowIso()}\n${signatureBrief(signature)}\n`,
      )
      if (state.stagnation >= settings.stagnationRepeats) {
        await finish(agent, state, 'stagnation')
        return
      }
    }

    if (Date.now() >= state.deadlineAt) {
      await finish(agent, state, 'time')
      return
    }
    if (state.roundsStarted >= state.maxRounds) {
      await finish(agent, state, 'rounds')
      return
    }

    state.roundsStarted += 1
    state.roundStartSeq = events.length
    state.userInterrupted = false
    await appendScratchpad(state, `\n## Round ${state.roundsStarted} started at ${nowIso()}\n`)

    try {
      const message = createUserMessage({
        content: [{ type: 'text', text: renderRoundPrompt(state) }],
        source: { kind: SOURCE_KIND, form: 'round', round: state.roundsStarted, startedAt: state.startedAt },
      })
      state.pendingMessageId = message.id
      // `followup` wakes the agent into a new turn; the matching idle event
      // arrives after that turn closes. Treat the state as running from here,
      // even though the status transition may not have been observed yet.
      state.lastStatus = 'running'
      agent.followup(message)
    } catch (error) {
      log(`dsh-deliberation: could not queue round ${state.roundsStarted}: ${String(error)}`)
      await finish(agent, state, 'queue-failed')
    }
  }

  function requestDrive(agent) {
    if (disposed) return
    const state = states.get(agent)
    if (state === undefined) return
    if (state.drive !== undefined) {
      state.driveAgain = true
      return
    }
    state.driveAgain = false
    state.drive = (async () => {
      try {
        do {
          state.driveAgain = false
          await drive(agent)
        } while (state.driveAgain && !disposed)
      } catch (error) {
        log(`dsh-deliberation: driver failed: ${String(error)}`)
        await finish(agent, state, 'driver-error')
      } finally {
        state.drive = undefined
      }
    })()
  }

  function onStatus({ agent, status }) {
    const state = states.get(agent)
    if (state === undefined) return
    const previous = state.lastStatus
    state.lastStatus = status
    if (status === 'idle' && previous === 'running') requestDrive(agent)
  }

  function onInboxInserted({ agent, message }) {
    const state = states.get(agent)
    if (state === undefined) return
    if (message?.source?.kind === 'user') state.userInterrupted = true
  }

  function onAgentError({ agent }) {
    const state = states.get(agent)
    if (state !== undefined) state.agentError = 'agent error'
  }

  function onAgentDisposed({ agent }) {
    states.delete(agent)
  }

  // ---------------------------------------------------------------------
  // Tools
  // ---------------------------------------------------------------------

  ctx.tools.register({
    name: 'deliberation_start',
    description: 'Start an approved extended-deliberation session. Use when the user explicitly asks for prolonged or deep thinking (for example "長考", "熟考", "think it through", "take your time", or "deep research"), or when an open-ended high-complexity investigation needs many bounded rounds. The tool asks the user for permission, offers Git-worktree isolation when available, and then automatically continues the work across approved rounds. Do not use it for ordinary tasks or quick answers.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['objective'],
      properties: {
        objective: {
          type: 'string',
          description: 'The concrete question or objective to deliberate on. Quote the user-facing terms.',
        },
        rounds: {
          type: 'number',
          description: 'Requested maximum number of automatic continuation rounds. Clamped to the configured cap.',
        },
        minutes: {
          type: 'number',
          description: 'Requested wall-clock budget in minutes. Clamped to the configured cap.',
        },
        isolate: {
          type: 'boolean',
          description: 'Whether to offer Git-worktree isolation in the approval popup. Defaults to true when the directory is a repository.',
        },
      },
    },
    output: START_OUTPUT,
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('deliberation_start requires a live calling agent')
      if (ctx.agents.get(agent.id) !== agent) throw new Error('deliberation_start requires the exact live calling agent')
      if (!ctx.agents.roots().includes(agent)) throw new Error('deliberation_start is unavailable from a delegated child agent')
      if (states.get(agent) !== undefined) throw new Error('a deliberation session is already active for this agent')

      const objective = String(args.objective ?? '').trim()
      if (objective.length === 0) throw new Error('deliberation_start requires a non-empty objective')
      const rounds = clampInt(args.rounds, settings.defaultRounds, 1, settings.maxRounds)
      const minutes = clampInt(args.minutes, settings.defaultMinutes, 1, settings.maxMinutes)
      const cwd = currentCwd(agent)
      const git = await detectGitRepo(cwd)
      const offerWorktree = settings.offerWorktree && git && args.isolate !== false
      const detail = renderApprovalDetail({ objective, rounds, minutes, git, offerWorktree })

      const questions = [{
        id: 'approve',
        header: '長考モード',
        question: '承認して長考を開始しますか？',
        detail,
        options: [
          {
            label: labels.approve,
            description: `承認すると最大 ${rounds} ラウンド / ${minutes} 分、ターン終了ごとに自動で続行します。`,
          },
          {
            label: labels.cancel,
            description: '今回は長考モードを開始せず、通常どおり回答します。',
          },
        ],
      }]
      if (offerWorktree) {
        questions.push({
          id: 'worktree',
          header: '隔離',
          question: 'Git ワークツリーで隔離しますか？',
          options: [
            {
              label: labels.worktreeYes,
              description: '現在のチェックアウトを汚さずに済みます。終了時は元のディレクトリへ戻ります。',
            },
            {
              label: labels.worktreeNo,
              description: '現在の作業ディレクトリでそのまま続行します。',
            },
          ],
        })
      }

      let answer
      try {
        answer = await ctx.userQuestions.ask({
          questions,
          agent,
          signal: exec.signal,
          wait: { callId: exec.callId },
        })
      } catch (error) {
        return declinedResult(`The approval question could not be completed: ${String(error?.message ?? error)}`)
      }

      const approve = answer.answers.find((item) => item.id === 'approve')
      if (approve === undefined || approve.selected?.[0] !== labels.approve) {
        return declinedResult('The user did not approve extended deliberation. Continue with a normal answer and do not start autonomous rounds.')
      }
      const note = typeof approve.custom === 'string' && approve.custom.trim().length > 0
        ? approve.custom.trim()
        : ''

      let worktree
      if (offerWorktree) {
        const worktreeAnswer = answer.answers.find((item) => item.id === 'worktree')
        if (worktreeAnswer?.selected?.[0] === labels.worktreeYes) {
          const service = worktrees()
          if (service !== undefined) {
            try {
              const created = await service.create(agent, {})
              worktree = {
                path: created.path,
                branch: created.branch,
                repositoryRoot: created.repositoryRoot,
              }
            } catch (error) {
              log(`dsh-deliberation: could not create worktree: ${String(error)}`)
            }
          }
        }
      }

      const state = {
        agent,
        objective,
        note,
        maxRounds: rounds,
        maxMinutes: minutes,
        startedAt: Date.now(),
        deadlineAt: Date.now() + minutes * 60000,
        roundsStarted: 0,
        roundStartSeq: agent.session.snapshotEvents().length,
        lastSignature: undefined,
        stagnation: 0,
        userInterrupted: false,
        agentError: undefined,
        finished: false,
        lastStatus: agent.status,
        pendingMessageId: undefined,
        drive: undefined,
        driveAgain: false,
        worktree,
        originalCwd: cwd,
        scratchpad: '',
      }
      state.scratchpad = await writeScratchpadBrief(state, worktree?.path ?? cwd)
      states.set(agent, state)

      return {
        status: 'started',
        rounds,
        minutes,
        worktree_path: worktree?.path ?? '',
        worktree_branch: worktree?.branch ?? '',
        scratchpad: state.scratchpad,
        message: `Approved. Continue the work now. The supervisor will queue round 1 when this turn ends, up to ${rounds} rounds or ${minutes} minutes. Call deliberation_end when the objective is complete or blocked.`,
      }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: 'Start extended deliberation',
      kind: 'other',
      rawInput: truncate(args.objective, 200),
    }),
  })

  ctx.tools.register({
    name: 'deliberation_end',
    description: 'End the active extended-deliberation session and report its budget and artifacts. Call it when the objective is answered, when you are genuinely blocked, or when the user asks to stop.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['summary', 'outcome'],
      properties: {
        summary: {
          type: 'string',
          description: 'Concise final summary: the outcome, evidence gathered, and anything still uncertain.',
        },
        outcome: {
          type: 'string',
          enum: ['complete', 'blocked'],
          description: 'Whether the objective is complete or blocked.',
        },
      },
    },
    output: END_OUTPUT,
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('deliberation_end requires a live calling agent')
      const state = states.get(agent)
      if (state === undefined) {
        return {
          status: 'inactive',
          rounds_used: 0,
          elapsed_seconds: 0,
          worktree_path: '',
          worktree_branch: '',
          scratchpad: '',
          message: 'No deliberation session is active.',
        }
      }
      state.finished = true
      states.delete(agent)
      const elapsedSeconds = Math.max(0, Math.round((Date.now() - state.startedAt) / 1000))
      const summary = String(args.summary ?? '').trim()
      await appendScratchpad(
        state,
        `\n## Ended by model (${String(args.outcome)}) at ${nowIso()}\n${summary}\n`,
      )
      const restored = await restoreWorkingDirectory(agent, state)
      return {
        status: 'stopped',
        rounds_used: state.roundsStarted,
        elapsed_seconds: elapsedSeconds,
        worktree_path: state.worktree?.path ?? '',
        worktree_branch: state.worktree?.branch ?? '',
        scratchpad: state.scratchpad,
        message: restored
          ? `Stopped. Working directory restored to ${state.originalCwd}.`
          : state.worktree === undefined
            ? 'Stopped.'
            : `Stopped. The session remains in the worktree ${state.worktree.path}.`,
      }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: 'End extended deliberation',
      kind: 'other',
      rawInput: truncate(args.summary, 200),
    }),
  })

  // ---------------------------------------------------------------------
  // Static policy section and live listeners
  // ---------------------------------------------------------------------

  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt !== undefined) {
    systemPrompt.section({ name: SECTION_NAME, order: SECTION_ORDER, text: PROMPT_SECTION })
  }

  ctx.on('agent/status', onStatus, { global: true })
  ctx.on('agent/inbox/inserted', onInboxInserted, { global: true })
  ctx.on('agent/error', onAgentError, { global: true })
  ctx.on('agent/disposed', onAgentDisposed, { global: true })

  ctx.effect(() => () => {
    disposed = true
    states.clear()
  })
}

/**
 * dsh-session-bus — automatic progress sharing across parallel DeepSeek Harness
 * sessions, plus an explicit stop/resume control surface.
 *
 * Design notes (see the plugin references read before writing this file):
 *   - The session log is the only source of truth. This plugin never appends a
 *     new event type; it observes `session/event` and keeps a derived cache in
 *     `~/.dsh/storages/session-bus/entries.jsonl`.
 *   - Per-agent prompt injection uses a GLOBAL `systemPrompt.context` whose text
 *     function receives the assembly scope (the agent); it returns the digest of
 *     every OTHER session. The current session is always excluded.
 *   - `share_progress` lets a model publish a structured milestone/blocker.
 *   - `session_bus_control` lists / stops / resumes the other visible sessions
 *     through `sessionController.cancel` and `sessionController.prompt`.
 *
 * @module dsh-session-bus
 */

import { randomUUID } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const name = 'session-bus'

/** Hard dependency: the tool registry. Everything else is resolved lazily. */
export const inject = ['tools']

const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  injectPrompt: true,
  digestMaxChars: 1400,
  maxEntries: 8,
  maxAgeMinutes: 480,
  includeSubagents: false,
  workingPersistIntervalMs: 15000,
  compactEvery: 120,
  allowControl: false,
  resumePrompt:
    '（dsh-session-bus）停止していた作業を再開してください。まず session_bus_digest で他セッションの進捗を確認し、共有ファイルは現物を読み直してから続行してください。再開内容を 1〜2 行で share_progress に記録してください。',
})

const SECTION_NAME = 'tool:session-bus'
/** Right after the deliberation section (2450), before the workflow section. */
const SECTION_ORDER = 2480
const CONTEXT_NAME = 'session-bus'
const CONTEXT_ORDER = 2600

const STATUS_LABELS = Object.freeze({
  working: '作業中',
  idle: '待機',
  done: '完了',
  blocked: 'ブロック',
  error: 'エラー',
  interrupted: '中断',
})

const CONTROL_STATUS = new Set(['working', 'done', 'blocked', 'error'])

const FILE_KEYS = [
  'file_path',
  'notebook_path',
  'path',
  'paths',
  'files',
  'target',
  'source',
  'dest',
  'destination',
  'old_path',
  'new_path',
]

const PROMPT_SECTION = `## Session bus (dsh-session-bus)

Parallel sessions in this Harness profile share progress automatically. A runtime
context named "セッション間の進捗共有" lists the other sessions' last known activity,
files they touched, and whether they are working, idle, blocked or erroring.

- Treat that digest as hints, not facts: before editing a shared file another
  session touched, read the current content again.
- When you finish a meaningful milestone, change plan, or hit a blocker, call
  \`share_progress\` with a one-line summary so other sessions avoid duplicating
  or colliding with your work.
- \`session_bus_digest\` returns the same digest on demand.
- The digest never includes your own session; it is not a chat channel and no
  message is sent to the other models.`

function log(...args) {
  try {
    console.log('[session-bus]', ...args)
  } catch {
    // Logging must never break the host loop.
  }
}

function clampInt(value, fallback, min, max) {
  const candidate =
    typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback
  return Math.min(max, Math.max(min, candidate))
}

function defaultStoreDir() {
  return path.join(os.homedir(), '.dsh', 'storages', 'session-bus')
}

function resolveConfig(config) {
  const raw = config !== null && typeof config === 'object' ? config : {}
  return {
    enabled: raw.enabled !== false,
    injectPrompt: raw.injectPrompt !== false,
    digestMaxChars: clampInt(raw.digestMaxChars, DEFAULT_CONFIG.digestMaxChars, 200, 8000),
    maxEntries: clampInt(raw.maxEntries, DEFAULT_CONFIG.maxEntries, 1, 32),
    maxAgeMinutes: clampInt(raw.maxAgeMinutes, DEFAULT_CONFIG.maxAgeMinutes, 1, 10080),
    includeSubagents: raw.includeSubagents === true,
    workingPersistIntervalMs: clampInt(
      raw.workingPersistIntervalMs,
      DEFAULT_CONFIG.workingPersistIntervalMs,
      1000,
      600000,
    ),
    compactEvery: clampInt(raw.compactEvery, DEFAULT_CONFIG.compactEvery, 10, 10000),
    allowControl: raw.allowControl === true,
    resumePrompt:
      typeof raw.resumePrompt === 'string' && raw.resumePrompt.trim().length > 0
        ? raw.resumePrompt.trim()
        : DEFAULT_CONFIG.resumePrompt,
    storeDir:
      typeof raw.storeDir === 'string' && raw.storeDir.trim().length > 0
        ? raw.storeDir.trim()
        : defaultStoreDir(),
  }
}

function normalizeText(value) {
  return String(value ?? '')
    .replace(/\r/g, '\n')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .trim()
}

function truncate(value, max) {
  const text = String(value ?? '')
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

function safeJsonParse(text) {
  if (typeof text !== 'string') return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function textOfMessage(message) {
  const blocks = Array.isArray(message?.content) ? message.content : []
  let out = ''
  for (const block of blocks) {
    if (block !== null && typeof block === 'object' && block.type === 'text') {
      if (typeof block.text === 'string') out += `${out.length > 0 ? ' ' : ''}${block.text}`
    }
  }
  return out
}

/** Pull workspace-looking file paths out of a tool-call argument payload. */
function extractFiles(rawArguments) {
  const args =
    typeof rawArguments === 'string' ? safeJsonParse(rawArguments) : rawArguments
  if (args === null || typeof args !== 'object') return []
  const found = []
  const push = (value) => {
    if (typeof value !== 'string') return
    const candidate = value.trim()
    if (candidate.length === 0 || candidate.length > 400) return
    if (/^https?:\/\//i.test(candidate)) return
    if (!/[\\/]/.test(candidate) && !/\.[A-Za-z0-9]{1,8}$/.test(candidate)) return
    if (!found.includes(candidate)) found.push(candidate)
  }
  for (const key of FILE_KEYS) {
    const value = args[key]
    if (Array.isArray(value)) {
      for (const item of value) push(item)
    } else {
      push(value)
    }
  }
  return found.slice(0, 8)
}

function sessionInfo(session) {
  const header =
    session?.header !== null && typeof session?.header === 'object' ? session.header : {}
  const cwd = typeof header.cwd === 'string' ? header.cwd : ''
  const isSubagent =
    header.origin === 'subagent' ||
    (typeof header.delegationDepth === 'number' && header.delegationDepth > 0)
  return { cwd, isSubagent }
}

function shortSid(sid) {
  const raw = typeof sid === 'string' ? sid : String(sid ?? 'unknown')
  const compact = raw.replace(/^session-/, '')
  return compact.length <= 12 ? compact : compact.slice(0, 12)
}

function clockLabel(at) {
  try {
    return new Date(at).toLocaleTimeString('ja-JP', { hour12: false })
  } catch {
    return '--:--:--'
  }
}

function ageLabel(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}秒前`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}分前`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}時間前`
  return `${Math.round(hours / 24)}日前`
}

function statusFromReason(reason) {
  const kind = reason !== null && typeof reason === 'object' ? reason.kind : reason
  switch (kind) {
    case 'completed':
      return 'idle'
    case 'blocked':
      return 'blocked'
    case 'error':
      return 'error'
    case 'interrupted':
    case 'max-tokens':
      return 'interrupted'
    case 'aborted':
      return 'idle'
    case 'forked':
      return 'idle'
    default:
      return 'idle'
  }
}

/**
 * Runtime-context and instruction noise that is prepended to user messages by
 * the harness. A digest entry must show the human's actual ask, not that block.
 */
const NOISE_PREFIXES = [
  'Current runtime context',
  'Time sampled',
  'Browser time zone',
  'Current working directory',
  'Current DSH file policy',
  'Current DeepSeek Harness',
  'You are an AI agent',
  'You are the Team Lead',
  'Agent Teams is available',
  'The Team Lead and all teammates',
  'Use dsh_browser_',
  'Tabs do not outlive',
  'Use the target returned',
  'Use session_search',
  'This snapshot supersedes',
]

function firstMeaningfulLine(text, max) {
  const normalized = normalizeText(text)
  if (normalized.length === 0) return ''
  for (const rawLine of normalized.split('\n')) {
    const line = rawLine.trim()
    if (line.length === 0) continue
    if (line.startsWith('<') || line.startsWith('#') || line.startsWith('- ')) continue
    if (NOISE_PREFIXES.some((prefix) => line.startsWith(prefix))) continue
    return truncate(line, max)
  }
  return ''
}

function formatEntry(entry, now) {
  const id = shortSid(entry.sid)
  const state = STATUS_LABELS[entry.status] ?? entry.status ?? '不明'
  const dir = entry.cwd ? ` · ${path.basename(entry.cwd)}` : ''
  const task =
    typeof entry.task === 'string' && entry.task.length > 0 ? `｜${truncate(entry.task, 70)}` : ''
  let line = `- [${id}] ${state} · ${clockLabel(entry.at)}（${ageLabel(now - entry.at)}）${dir}${task}`
  if (entry.summary) line += `\n  直近: ${truncate(entry.summary, 180)}`
  if (Array.isArray(entry.files) && entry.files.length > 0) {
    const names = entry.files.slice(0, 3).map((file) => path.basename(String(file)))
    line += `\n  ファイル: ${names.join(', ')}`
  }
  if (entry.next) line += `\n  次: ${truncate(entry.next, 120)}`
  if (entry.error) line += `\n  エラー: ${truncate(entry.error, 120)}`
  return line
}

class SessionBusStore {
  constructor(config) {
    this.config = config
    this.entries = new Map()
    this.runtime = new Map()
    this.queue = Promise.resolve()
    this.appends = 0
    this.dir = config.storeDir
    this.file = path.join(this.dir, 'entries.jsonl')
    this.controlFile = path.join(this.dir, 'control.json')
    this.errorFile = path.join(this.dir, 'errors.log')
    this.ready = this.load()
    this.ready.catch((error) => this.reportError('load', error))
  }

  async load() {
    try {
      const text = await fsp.readFile(this.file, 'utf8')
      for (const line of text.split(/\r?\n/)) {
        if (line.trim().length === 0) continue
        const entry = safeJsonParse(line)
        if (entry !== undefined && typeof entry.sid === 'string' && typeof entry.at === 'number') {
          this.entries.set(entry.sid, entry)
        }
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') this.reportError('load', error)
    }
  }

  reportError(where, error) {
    const text = `[${new Date().toISOString()}] ${where}: ${String(error?.stack ?? error)}\n`
    fsp
      .mkdir(this.dir, { recursive: true })
      .then(() => fsp.appendFile(this.errorFile, text, 'utf8'))
      .catch(() => {})
    log(`${where} failed:`, error)
  }

  draftFor(session) {
    const sid = session?.id
    if (typeof sid !== 'string' || sid.length === 0) return undefined
    let draft = this.runtime.get(sid)
    if (draft === undefined) {
      const info = sessionInfo(session)
      draft = {
        sid,
        cwd: info.cwd,
        isSubagent: info.isSubagent,
        task: '',
        summary: '',
        files: [],
        tools: [],
        error: undefined,
        status: 'idle',
        at: Date.now(),
        lastPersistAt: 0,
      }
      this.runtime.set(sid, draft)
    }
    return draft
  }

  observe(session, event) {
    if (event === null || typeof event !== 'object' || typeof event.type !== 'string') return
    const draft = this.draftFor(session)
    if (draft === undefined) return
    const time = typeof event.time === 'number' ? event.time : Date.now()
    const data = event.data ?? {}

    switch (event.type) {
      case 'user/message': {
        const text = firstMeaningfulLine(textOfMessage(data), 160)
        if (text.length > 0) draft.task = text
        break
      }
      case 'assistant/message': {
        const text = normalizeText(textOfMessage(data.message))
        if (text.length > 0) {
          draft.summary = truncate(text, 400)
          draft.at = time
        }
        if (draft.status !== 'blocked') draft.status = 'working'
        this.maybePersist(draft)
        break
      }
      case 'tool/call': {
        if (typeof data.name === 'string' && data.name.length > 0) {
          draft.tools = [data.name, ...draft.tools.filter((t) => t !== data.name)].slice(0, 6)
        }
        for (const file of extractFiles(data.arguments)) {
          draft.files = [file, ...draft.files.filter((f) => f !== file)].slice(0, 8)
        }
        draft.at = time
        this.maybePersist(draft)
        break
      }
      case 'tool/result': {
        const failure = data.error
        if (failure !== null && failure !== undefined) {
          const name = typeof failure.name === 'string' ? failure.name : 'tool'
          const reason =
            typeof failure.reason === 'string'
              ? failure.reason
              : typeof failure.code === 'string'
                ? failure.code
                : ''
          draft.error = truncate(`${name}: ${reason}`.trim(), 200)
        }
        break
      }
      case 'turn/start': {
        draft.status = 'working'
        draft.at = time
        this.maybePersist(draft, true)
        break
      }
      case 'turn/end': {
        draft.status = statusFromReason(data.reason)
        draft.at = time
        this.writeDraft(draft)
        break
      }
      default:
        break
    }
  }

  maybePersist(draft, force = false) {
    const now = Date.now()
    if (!force && now - draft.lastPersistAt < this.config.workingPersistIntervalMs) return
    draft.lastPersistAt = now
    this.writeDraft(draft)
  }

  writeDraft(draft) {
    const previous = this.entries.get(draft.sid)
    const entry = {
      v: 1,
      sid: draft.sid,
      cwd: draft.cwd,
      subagent: draft.isSubagent === true ? true : undefined,
      status: draft.status,
      task: draft.task || previous?.task || undefined,
      summary: draft.summary || undefined,
      files: draft.files.slice(0, 8),
      tools: draft.tools.slice(0, 6),
      error: draft.error,
      next: undefined,
      at: draft.at || Date.now(),
      source: 'auto',
    }
    // Keep an explicitly shared "next step" until it is older than 10 minutes.
    if (
      previous !== undefined &&
      previous.source === 'tool' &&
      typeof previous.next === 'string' &&
      Date.now() - previous.at < 600000
    ) {
      entry.next = previous.next
    }
    this.commit(entry)
  }

  share(entry) {
    this.commit(entry)
  }

  commit(entry) {
    this.entries.set(entry.sid, entry)
    this.persistEntry(entry)
  }

  persistEntry(entry) {
    this.queue = this.queue
      .then(async () => {
        await fsp.mkdir(this.dir, { recursive: true })
        await fsp.appendFile(this.file, `${JSON.stringify(entry)}\n`, 'utf8')
        this.appends += 1
        if (this.appends % this.config.compactEvery === 0) await this.compact()
      })
      .catch((error) => {
        this.reportError('persist', error)
      })
  }

  async compact() {
    const lines = [...this.entries.values()].map((entry) => JSON.stringify(entry)).join('\n')
    const tmp = `${this.file}.tmp`
    await fsp.writeFile(tmp, lines.length > 0 ? `${lines}\n` : '', 'utf8')
    await fsp.rename(tmp, this.file)
  }

  peers(selfSid) {
    const now = Date.now()
    const cutoff = now - this.config.maxAgeMinutes * 60000
    return [...this.entries.values()]
      .filter((entry) => entry !== null && typeof entry === 'object')
      .filter((entry) => entry.sid !== selfSid)
      .filter((entry) => this.config.includeSubagents || entry.subagent !== true)
      .filter((entry) => (entry.at ?? 0) >= cutoff)
      .sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
  }

  digest(selfSid) {
    const rows = this.peers(selfSid)
    if (rows.length === 0) return ''
    const lines = []
    let total = 0
    for (const entry of rows) {
      if (lines.length >= this.config.maxEntries) break
      const line = formatEntry(entry, Date.now())
      if (total + line.length > this.config.digestMaxChars) break
      lines.push(line)
      total += line.length
    }
    if (lines.length === 0) return ''
    return [
      `### セッション間の進捗共有（dsh-session-bus・自動要約 / ${clockLabel(Date.now())} 時点）`,
      ...lines,
      '（参考情報。断定せず、共有ファイルは現物を確認する。自分の進捗は share_progress で共有できる）',
    ].join('\n')
  }

  async saveControl(record) {
    await fsp.mkdir(this.dir, { recursive: true })
    const tmp = `${this.controlFile}.tmp`
    await fsp.writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
    await fsp.rename(tmp, this.controlFile)
  }

  async loadControl() {
    try {
      const text = await fsp.readFile(this.controlFile, 'utf8')
      const parsed = safeJsonParse(text)
      if (parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.sessionIds)) {
        return {
          stoppedAt: typeof parsed.stoppedAt === 'number' ? parsed.stoppedAt : 0,
          sessionIds: parsed.sessionIds.filter((id) => typeof id === 'string'),
        }
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') this.reportError('load-control', error)
    }
    return { stoppedAt: 0, sessionIds: [] }
  }
}

function shareProgressTool(store) {
  return {
    name: 'share_progress',
    description:
      'Share this session\'s current progress with the other parallel sessions in this Harness profile. Call it when you finish a meaningful milestone, change plan, or hit a blocker: every other session sees a one-line digest in its prompt, so they avoid duplicating work or colliding on the same files. This does not contact the other models directly — it only updates the shared digest.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['summary'],
      properties: {
        summary: {
          type: 'string',
          description:
            'What this session is doing now or just finished, one or two sentences (max 400 chars). Write it so another session can tell whether it may collide.',
        },
        status: {
          type: 'string',
          enum: ['working', 'done', 'blocked', 'error'],
          description: 'Current state of this session\'s task.',
        },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Workspace file paths this session is editing or about to edit.',
        },
        next: {
          type: 'string',
          description: 'What happens next, so others know when this session touches shared files again.',
        },
        task: {
          type: 'string',
          description: 'Optional short restatement of the overall task this session is working on.',
        },
      },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    timeoutMs: 30000,
    async execute(args, exec) {
      const agent = exec?.agent
      const sid = agent?.id
      if (typeof sid !== 'string' || sid.length === 0) {
        throw new Error('share_progress requires a live calling session')
      }
      const summary = truncate(normalizeText(args?.summary), 400)
      if (summary.length === 0) {
        throw new Error('share_progress requires a non-empty summary')
      }
      const status = CONTROL_STATUS.has(args?.status) ? args.status : 'working'
      const info = sessionInfo(agent?.session)
      const entry = {
        v: 1,
        sid,
        cwd: info.cwd,
        subagent: info.isSubagent === true ? true : undefined,
        status,
        task: truncate(normalizeText(args?.task), 200) || undefined,
        summary,
        files: Array.isArray(args?.files)
          ? args.files
              .filter((item) => typeof item === 'string')
              .map((item) => item.trim())
              .filter((item) => item.length > 0)
              .slice(0, 8)
          : [],
        tools: [],
        next: truncate(normalizeText(args?.next), 200) || undefined,
        at: Date.now(),
        source: 'tool',
      }
      store.share(entry)
      return {
        ok: true,
        shared: { session: shortSid(sid), status, summary },
        peers: store.digest(sid) || '(no other session has reported progress yet)',
      }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: 'Share progress',
      kind: 'other',
      rawInput: truncate(args?.summary ?? '', 200),
    }),
  }
}

function digestTool(store) {
  return {
    name: 'session_bus_digest',
    description:
      'Read the current cross-session progress digest (other sessions only). Use it when you need to know what the parallel sessions are doing right now, for example before editing a shared file or when asked about overall progress.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    timeoutMs: 20000,
    async execute(_args, exec) {
      const sid = exec?.agent?.id
      const digest = store.digest(typeof sid === 'string' ? sid : '')
      return {
        ok: true,
        entries: store.peers(typeof sid === 'string' ? sid : '').length,
        digest: digest || '(no other session has reported progress yet)',
      }
    },
  }
}

function isSubagentSummary(summary) {
  return summary?.origin === 'subagent'
}

async function listOtherSessions(sessionController, selfSid) {
  const controller = new AbortController()
  const value = await sessionController.list({}, controller.signal)
  const items = Array.isArray(value?.items) ? value.items : []
  return items.filter(
    (item) =>
      item !== null &&
      typeof item === 'object' &&
      typeof item.sessionId === 'string' &&
      item.sessionId !== selfSid &&
      !isSubagentSummary(item),
  )
}

function describeSummary(summary) {
  return {
    session: shortSid(summary.sessionId),
    sessionId: summary.sessionId,
    running: summary.running === true,
    ...(typeof summary.cwd === 'string' ? { cwd: summary.cwd } : {}),
    ...(typeof summary.updatedAt === 'number' ? { updatedAt: summary.updatedAt } : {}),
  }
}

function controlTool(ctx, store) {
  return {
    name: 'session_bus_control',
    description:
      'Coordinate the other parallel sessions in this Harness profile. action="list" shows which other sessions are live and running; action="stop_all" cancels the active turn of every other visible session that is currently running (this interrupts their in-flight step) and records them; action="resume_all" sends a resume prompt to exactly the sessions recorded by the last stop_all, all at once. Only user sessions are affected; subagent sessions are skipped. Ask the user before stop_all when their work may be in-flight.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'stop_all', 'resume_all'],
          description: 'Which coordination operation to perform.',
        },
      },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    timeoutMs: 90000,
    async execute(args, exec) {
      const action = args?.action
      if (action !== 'list' && action !== 'stop_all' && action !== 'resume_all') {
        throw new Error('session_bus_control requires action=list|stop_all|resume_all')
      }
      const selfSid = exec?.agent?.id
      if (typeof selfSid !== 'string' || selfSid.length === 0) {
        throw new Error('session_bus_control requires a live calling session')
      }
      const sessionController = typeof ctx.get === 'function' ? ctx.get('sessionController') : undefined
      if (
        sessionController === undefined ||
        typeof sessionController.list !== 'function' ||
        typeof sessionController.cancel !== 'function'
      ) {
        throw new Error('session_bus_control is unavailable: sessionController service not found')
      }

      if (action === 'list') {
        const sessions = await listOtherSessions(sessionController, selfSid)
        const record = await store.loadControl()
        return {
          ok: true,
          action,
          running: sessions.filter((item) => item.running === true).map(describeSummary),
          idle: sessions.filter((item) => item.running !== true).map(describeSummary),
          stoppedByBus: record.sessionIds.map(shortSid),
          ...(record.stoppedAt ? { stoppedAt: record.stoppedAt } : {}),
        }
      }

      if (store.config.allowControl !== true) {
        throw new Error('session_bus_control is disabled by config (allowControl: false)')
      }

      if (action === 'stop_all') {
        const sessions = await listOtherSessions(sessionController, selfSid)
        const running = sessions.filter((item) => item.running === true)
        const stopped = []
        const failed = []
        for (const item of running) {
          try {
            sessionController.cancel({ sessionId: item.sessionId })
            stopped.push(item.sessionId)
          } catch (error) {
            failed.push({ session: shortSid(item.sessionId), error: String(error?.message ?? error) })
          }
        }
        const previous = await store.loadControl()
        const merged = [...new Set([...previous.sessionIds, ...stopped])]
        await store.saveControl({ stoppedAt: Date.now(), sessionIds: merged })
        return {
          ok: failed.length === 0,
          action,
          stopped: stopped.map(shortSid),
          failed,
          alreadyStopped: previous.sessionIds.map(shortSid),
          note: 'Active turns were cancelled. Their pending inbox is preserved; resume_all restarts them.',
        }
      }

      const record = await store.loadControl()
      if (record.sessionIds.length === 0) {
        return {
          ok: true,
          action,
          resumed: [],
          note: 'No session was recorded by a previous stop_all.',
        }
      }
      const results = await Promise.allSettled(
        record.sessionIds.map(async (sessionId, index) => {
          await sessionController.prompt(
            {
              requestId: `session-bus-resume-${Date.now()}-${index}-${randomUUID()}`,
              sessionId,
              mode: 'queue',
              content: [{ type: 'text', text: store.config.resumePrompt }],
            },
            new AbortController().signal,
          )
          return sessionId
        }),
      )
      const resumed = []
      const failed = []
      results.forEach((result, index) => {
        const sessionId = record.sessionIds[index]
        if (result.status === 'fulfilled') resumed.push(shortSid(sessionId))
        else {
          failed.push({
            session: shortSid(sessionId),
            error: String(result.reason?.message ?? result.reason),
          })
        }
      })
      await store.saveControl({ stoppedAt: record.stoppedAt, sessionIds: [] })
      return { ok: failed.length === 0, action, resumed, failed }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `Session bus: ${String(args?.action ?? '')}`,
      kind: 'other',
    }),
  }
}

/**
 * Host plugin entry point. Deliberately synchronous: the loader gets its
 * disposers immediately, and the store's disk load proceeds in the background.
 *
 * @param {any} ctx Cordis context
 * @param {any} config loader row config
 */
export function apply(ctx, config) {
  const resolved = resolveConfig(config)
  if (!resolved.enabled) {
    log('disabled by config')
    return
  }

  const store = new SessionBusStore(resolved)

  // 1. Capture. `global: true` widens scope filtering so every session's feed is
  //    observed, not only the session that loaded the plugin.
  ctx.effect(() =>
    ctx.on(
      'session/event',
      (session, event) => {
        try {
          store.observe(session, event)
        } catch (error) {
          store.reportError('observe', error)
        }
      },
      { global: true },
    ),
  )

  // 2. Tools: explicit sharing, digest inspection, stop/resume control.
  ctx.effect(() => ctx.tools.register(shareProgressTool(store)))
  ctx.effect(() => ctx.tools.register(digestTool(store)))
  ctx.effect(() => ctx.tools.register(controlTool(ctx, store)))

  // 3. Prompt injection. `text` is evaluated on every assembly with the current
  //    scope; a non-agent scope yields no text, so global assemblies stay clean.
  const systemPrompt = typeof ctx.get === 'function' ? ctx.get('systemPrompt') : undefined
  if (systemPrompt !== undefined) {
    if (resolved.injectPrompt) {
      ctx.effect(() =>
        systemPrompt.context({
          name: CONTEXT_NAME,
          order: CONTEXT_ORDER,
          required: false,
          text: (assembly) => {
            try {
              const scope = assembly?.scope
              const sid = scope?.id
              if (typeof sid !== 'string' || sid.length === 0) return ''
              return store.digest(sid)
            } catch (error) {
              store.reportError('digest', error)
              return ''
            }
          },
        }),
      )
    }
    ctx.effect(() =>
      systemPrompt.section({
        name: SECTION_NAME,
        order: SECTION_ORDER,
        text: PROMPT_SECTION,
      }),
    )
  } else {
    log('systemPrompt service not found; prompt injection skipped')
  }

  log(`active (store=${store.file}, control=${resolved.allowControl})`)
}

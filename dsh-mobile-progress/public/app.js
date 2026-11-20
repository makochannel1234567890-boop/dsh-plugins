'use strict'

/**
 * dsh-mobile-progress client.
 *
 * The page is served by the plugin's own HTTP server (LAN and/or public
 * tunnel), so it has no framework or build step. It renders the JSON state
 * pushed over SSE, keeps a small polling fallback for browsers where the
 * stream stalls, and — as an installed PWA — shows the last received state
 * from localStorage/Service Worker cache when the network is gone.
 */

const $ = (id) => document.getElementById(id)

const els = {
  appTitle: $('appTitle'),
  subtitle: $('subtitle'),
  conn: $('conn'),
  connText: $('connText'),
  statusChip: $('statusChip'),
  sessionLabel: $('sessionLabel'),
  percent: $('percent'),
  activity: $('activity'),
  activityText: $('activityText'),
  track: $('track'),
  bar: $('bar'),
  currentStep: $('currentStep'),
  note: $('note'),
  requestCard: $('requestCard'),
  request: $('request'),
  steps: $('steps'),
  stepsEmpty: $('stepsEmpty'),
  stepCount: $('stepCount'),
  updatedAgo: $('updatedAgo'),
  counters: $('counters'),
  lastTool: $('lastTool'),
  sessionShort: $('sessionShort'),
  logsCard: $('logsCard'),
  logs: $('logs'),
  logCount: $('logCount'),
  installText: $('installText'),
  installHint: $('installHint'),
  installBtn: $('installBtn'),
  selfUrl: $('selfUrl'),
  shareCard: $('shareCard'),
  shareBadge: $('shareBadge'),
  publicLink: $('publicLink'),
  copyBtn: $('copyBtn'),
  footerTitle: $('footerTitle'),
  footerPort: $('footerPort'),
  offlineBar: $('offlineBar'),
  toast: $('toast'),
  composeCard: $('composeCard'),
  workspaceSelect: $('workspaceSelect'),
  workspacePath: $('workspacePath'),
  fanoutToggle: $('fanoutToggle'),
  promptInput: $('promptInput'),
  promptCount: $('promptCount'),
  startBtn: $('startBtn'),
  composeStatus: $('composeStatus'),
  progressCard: $('progressCard'),
  resultCard: $('resultCard'),
  resultBadge: $('resultBadge'),
  resultText: $('resultText'),
  resultMeta: $('resultMeta'),
}

const STATUS_LABEL = {
  idle: '待機中',
  working: '作業中',
  done: '完了',
  blocked: 'ブロック',
  error: 'エラー',
}

const STORAGE_KEY = 'dsh-progress:last-state'
const STORAGE_MAX_AGE = 7 * 24 * 60 * 60 * 1000
const PROMPT_MAX = 8000

/**
 * Appended to the prompt when the phone's fan-out toggle is on.
 *
 * The fan-out Host plugin already explains `fanout_start` in its prompt
 * section; this line carries the one thing that section cannot know: the
 * person ticked the fan-out toggle for *this* prompt on the phone. It is
 * plain prompt text on purpose — arming the composer checkbox is Host state,
 * and the phone server cannot set it, so the request is phrased as an
 * instruction the receiving session can act on without a plugin reload.
 */
const FANOUT_DIRECTIVE =
  '【fan-out 指示】この依頼はスマホの fan-out トグルから送信されました。独立した作業が3つ以上あり、並列に進められるなら fanout_start で分解して実行してください（workers と expansion はこの依頼に必要な値まで上げること）。単一作業や直列の連鎖なら、このセッションのまま実行し、その判断を1行で述べてください。'

let lastState = null
let stepSignature = ''
let logSignature = ''
let sseOpen = false
let lastMessageAt = 0
let lastSavedAt = 0
let reconnectTimer = null
let retryDelay = 1000
let deferredPrompt = null
let toastTimer = null
let composeReady = false
let composeBusy = false
let renderedSessionId = null
let workspaceChoices = []
let sessionStartAt = 0

const search = () => location.search

function text(el, value) {
  const next = String(value ?? '')
  if (el && el.textContent !== next) el.textContent = next
}

function setConn(state, label) {
  els.conn.dataset.state = state
  text(els.connText, label)
}

function setOffline(offline, label) {
  els.offlineBar.hidden = !offline
  if (offline && label) text(els.offlineBar, label)
}

function toast(message) {
  if (!els.toast) return
  text(els.toast, message)
  els.toast.hidden = false
  if (toastTimer !== null) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    els.toast.hidden = true
    toastTimer = null
  }, 2400)
}

function ago(timestamp) {
  const diff = Math.max(0, Date.now() - Number(timestamp || 0))
  const seconds = Math.round(diff / 1000)
  if (!Number.isFinite(seconds)) return '—'
  if (seconds < 3) return 'たった今'
  if (seconds < 60) return `${seconds}秒前`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}分前`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}時間前`
  return `${Math.round(hours / 24)}日前`
}

// -- offline snapshot -------------------------------------------------------

function saveSnapshot(data) {
  const now = Date.now()
  if (now - lastSavedAt < 2000) return
  lastSavedAt = now
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ at: now, data }))
  } catch {
    // Private mode or a full quota; the live feed still works.
  }
}

function loadSnapshot() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || !parsed.data) return null
    if (Date.now() - Number(parsed.at || 0) > STORAGE_MAX_AGE) return null
    return parsed
  } catch {
    return null
  }
}

// -- rendering --------------------------------------------------------------

function setSteps(steps) {
  const list = Array.isArray(steps) ? steps : []
  const signature = JSON.stringify(list)
  if (signature === stepSignature) return
  stepSignature = signature

  els.steps.replaceChildren()
  for (const step of list) {
    const li = document.createElement('li')
    li.className = 'step'
    li.dataset.status = step.status || 'pending'

    const mark = document.createElement('span')
    mark.className = 'mark'
    mark.setAttribute('aria-hidden', 'true')

    const body = document.createElement('span')
    body.className = 'text'
    body.textContent = step.text || ''

    li.append(mark, body)
    els.steps.append(li)
  }

  text(els.stepCount, String(list.length))
  els.stepsEmpty.hidden = list.length > 0
}

function setLogs(logs) {
  const list = Array.isArray(logs) ? logs : []
  const signature = JSON.stringify(list)
  if (signature === logSignature) return
  logSignature = signature

  els.logs.replaceChildren()
  for (const entry of list.slice().reverse()) {
    const li = document.createElement('li')
    const time = document.createElement('time')
    const stamp = new Date(Number(entry.at) || Date.now())
    time.textContent = stamp.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })
    const span = document.createElement('span')
    span.textContent = entry.text || ''
    li.append(time, span)
    els.logs.append(li)
  }
  text(els.logCount, String(list.length))
}

function renderReach(data) {
  const server = data.server || {}
  const publicUrl = typeof server.publicUrl === 'string' ? server.publicUrl : ''
  els.shareCard.hidden = publicUrl.length === 0
  if (publicUrl.length > 0) {
    if (els.publicLink.getAttribute('href') !== publicUrl) els.publicLink.href = publicUrl
    text(els.publicLink, publicUrl)
    const status = server.tunnel?.status || ''
    text(els.shareBadge, status === 'running' ? 'HTTPS' : status === 'starting' ? '準備中' : 'HTTPS')
  }
  const tunnelOn = server.tunnel?.enabled === true
  if (publicUrl.length === 0 && tunnelOn && !els.installHint.textContent) {
    const status = server.tunnel?.status || ''
    if (status === 'installing') text(els.installHint, '公開 URL を用意しています（初回は cloudflared を取得中）。')
    else if (status === 'error') text(els.installHint, '公開 URL は使えません（同じ Wi-Fi の接続先を使ってください）。')
    else text(els.installHint, '公開 URL を準備しています。少し待って再読み込みしてください。')
  }
}

function render(data) {
  if (!data || typeof data !== 'object') return
  lastState = data
  saveSnapshot(data)

  // A different session id means a different run, so drop the cached list
  // signatures: the step and log lists must repaint even when their first frame
  // happens to look identical.
  const sessionId = data.session?.id ? String(data.session.id) : null
  const switched = sessionId !== null && renderedSessionId !== null && sessionId !== renderedSessionId
  if (switched) {
    stepSignature = ''
    logSignature = ''
    if (Date.now() - sessionStartAt > 10000) toast('新しいセッションを表示中')
  }
  renderedSessionId = sessionId

  const session = data.session || null
  const percent = session ? session.percent : null
  const indeterminate = percent === null || percent === undefined || !Number.isFinite(Number(percent))
  const status = session?.status || 'idle'

  text(els.appTitle, data.title || 'DSH Progress')
  text(els.footerTitle, data.title || 'DSH Progress')
  text(els.footerPort, data.server?.port ? `:${data.server.port}` : '')

  els.statusChip.dataset.status = status
  text(els.statusChip, STATUS_LABEL[status] || status)

  text(els.percent, indeterminate ? '--' : String(Math.round(Number(percent))))
  els.track.classList.toggle('is-indeterminate', indeterminate)
  if (!indeterminate) {
    const width = Math.max(0, Math.min(100, Number(percent)))
    els.bar.style.width = `${width}%`
  } else {
    els.bar.style.width = ''
  }

  const running = Boolean(session?.agentRunning)
  const live = running || status === 'working'
  els.activity.dataset.live = live ? 'true' : 'false'
  text(els.activityText, live ? '実行中' : status === 'done' ? '完了' : status === 'error' ? '停止' : '待機')

  text(els.sessionLabel, session ? session.title || `session ${session.short || ''}` : 'セッション未接続')
  text(
    els.currentStep,
    session
      ? session.currentStep || (indeterminate ? '作業中…' : '待機中')
      : 'まだ進捗がありません。エージェントが progress_update を呼ぶとここに表示されます。',
  )

  const note = session?.note || ''
  els.note.hidden = note.length === 0
  if (note.length > 0) text(els.note, note)

  const request = session?.request || ''
  els.requestCard.hidden = request.length === 0
  if (request.length > 0) text(els.request, request)

  setSteps(session?.steps || [])
  setLogs(session?.logs || [])
  renderResult(session)
  renderReach(data)

  text(els.updatedAgo, session ? ago(session.updatedAt) : '—')
  text(els.counters, session ? `${session.turns ?? 0} / ${session.toolCalls ?? 0}` : '—')
  text(els.lastTool, session?.lastTool || '—')
  text(els.sessionShort, session?.short || '—')

  text(els.subtitle, session?.stale ? '保存された最終状態（セッション停止中）' : 'エージェントの作業をリアルタイム表示')
}

function markSynced(label = 'ライブ') {
  lastMessageAt = Date.now()
  setConn('live', label)
  setOffline(false)
}

function closeStream() {
  if (sseOpen) {
    sseOpen = false
  }
}

async function fetchState({ quiet = false } = {}) {
  try {
    const response = await fetch(`/api/state${search()}`, { cache: 'no-store' })
    if (response.status === 401) {
      els.requestCard.hidden = true
      disableCompose('アクセストークンが必要です。この画面の URL の ?k= を確認してください。')
      setConn('offline', 'トークンが必要')
      text(els.currentStep, 'この画面を開くにはアクセストークンが必要です。PC 側の progress_status が出す ?k=… 付き URL を開いてください。')
      setOffline(true, 'アクセストークンがありません')
      return false
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const data = await response.json()
    render(data)
    if (response.headers.get('x-dsh-offline') === '1') {
      setOffline(true, 'オフライン — 最後に受け取った状態です')
      setConn('offline', 'オフライン')
      return true
    }
    if (!sseOpen) markSynced('同期中')
    return true
  } catch {
    if (!quiet) setConn('offline', 'オフライン')
    setOffline(true, 'オフライン — 最後に受け取った状態です')
    return false
  }
}

function scheduleReconnect() {
  if (reconnectTimer !== null) return
  const delay = retryDelay
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    retryDelay = Math.min(Math.round(retryDelay * 1.7), 10000)
    connect()
  }, delay)
}

function connect() {
  if (typeof EventSource !== 'function') {
    void fetchState()
    return
  }
  closeStream()
  let source
  try {
    source = new EventSource(`/api/stream${search()}`)
  } catch {
    scheduleReconnect()
    return
  }

  source.onopen = () => {
    sseOpen = true
    retryDelay = 1000
    markSynced()
    // Reconnects pick up workspace list changes made on the PC in the meantime.
    void loadWorkspaces({ quiet: true })
  }

  source.onmessage = (event) => {
    try {
      render(JSON.parse(event.data))
    } catch {
      // A truncated frame is replaced by the next one.
    }
    sseOpen = true
    markSynced()
  }

  source.onerror = () => {
    sseOpen = false
    try {
      source.close()
    } catch {
      // Already closed.
    }
    setConn('offline', '再接続中…')
    scheduleReconnect()
  }
}

function tick() {
  const session = lastState?.session
  if (session) {
    text(els.updatedAgo, ago(session.updatedAt))
    text(
      els.activityText,
      session.agentRunning ? '実行中' : session.status === 'done' ? '完了' : session.status === 'error' ? '停止' : '待機',
    )
  }
  if (sseOpen && lastMessageAt > 0 && Date.now() - lastMessageAt > 30000) {
    sseOpen = false
    setConn('offline', '再接続中…')
    scheduleReconnect()
  }
}

// -- compose: start a session from the phone ---------------------------------

/**
 * The last segment of a workspace path.
 *
 * A phone-sized <select> cannot show a Windows path, and the leaf directory is
 * the part a person names the workspace by. The full path stays available as
 * the option's `title` attribute for a desktop hover, so nothing is lost.
 */
function pathLeaf(value) {
  const raw = String(value ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
  if (raw.length === 0) return ''
  const parts = raw.split('/').filter(Boolean)
  return parts.length > 0 ? parts[parts.length - 1] : raw
}

function prefersReducedMotion() {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

function setComposeStatus(message, tone = 'info') {
  if (!els.composeStatus) return
  const next = String(message ?? '')
  text(els.composeStatus, next)
  els.composeStatus.hidden = next.length === 0
  els.composeStatus.dataset.tone = tone
}

function setComposeEnabled(enabled) {
  composeReady = enabled
  if (!els.workspaceSelect || !els.startBtn) return
  els.workspaceSelect.disabled = !enabled
  if (els.fanoutToggle) els.fanoutToggle.disabled = !enabled
  els.startBtn.disabled = !enabled || composeBusy
}

function disableCompose(message, tone = 'error') {
  setComposeEnabled(false)
  setComposeStatus(message, tone)
}

function selectedWorkspace() {
  const id = els.workspaceSelect?.value || ''
  return workspaceChoices.find((item) => item.id === id) || null
}

function syncWorkspacePath() {
  const chosen = selectedWorkspace()
  if (!els.workspacePath) return
  const leaf = chosen ? pathLeaf(chosen.path) || chosen.title || chosen.id : ''
  // The hint is a name, not a path: show the ledger title only when it says
  // something the leaf does not (a renamed workspace). The full path stays in
  // the title attribute, where a desktop hover can reveal it without putting a
  // Windows path on a phone screen.
  const label = chosen && chosen.title.length > 0 && chosen.title !== leaf ? chosen.title : ''
  els.workspacePath.hidden = label.length === 0
  text(els.workspacePath, label)
  if (chosen) els.workspacePath.title = chosen.path
  else els.workspacePath.removeAttribute('title')
}

function updatePromptCount() {
  const value = els.promptInput?.value || ''
  text(els.promptCount, `${value.length} / ${PROMPT_MAX}`)
}

function applyWorkspaces(payload) {
  const list = Array.isArray(payload?.workspaces) ? payload.workspaces : []
  const control = payload?.control && typeof payload.control === 'object' ? payload.control : {}
  const previous = els.workspaceSelect?.value || ''

  workspaceChoices = list
    .filter((item) => item && item.id)
    .map((item) => ({
      id: String(item.id),
      title: String(item.title || item.id),
      path: String(item.path || ''),
      exists: item.exists !== false,
    }))

  if (!els.workspaceSelect) return
  els.workspaceSelect.replaceChildren()

  if (workspaceChoices.length === 0) {
    const empty = document.createElement('option')
    empty.value = ''
    empty.textContent = 'ワークスペースがありません'
    els.workspaceSelect.append(empty)
    disableCompose('ワークスペースが見つかりません。PC 側で一度セッションを開いてください。')
    syncWorkspacePath()
    return
  }

  // Two workspaces can share a leaf name; number the repeats so the list stays
  // unambiguous without bringing paths back onto the phone.
  const leaves = workspaceChoices.map((item) => pathLeaf(item.path) || item.title)
  const totals = new Map()
  for (const leaf of leaves) totals.set(leaf, (totals.get(leaf) ?? 0) + 1)
  const seen = new Map()

  workspaceChoices.forEach((item, index) => {
    const leaf = leaves[index]
    const ordinal = (seen.get(leaf) ?? 0) + 1
    seen.set(leaf, ordinal)
    const label = totals.get(leaf) > 1 && ordinal > 1 ? `${leaf}（${ordinal}）` : leaf
    const suffix = item.exists ? '' : '（見つかりません）'
    const option = document.createElement('option')
    option.value = item.id
    option.textContent = `${label}${suffix}`
    // The full path is one hover away on the PC, never on the phone screen.
    option.title = item.path
    els.workspaceSelect.append(option)
  })

  const keep = workspaceChoices.some((item) => item.id === previous) ? previous : workspaceChoices[0].id
  els.workspaceSelect.value = keep

  if (control.enabled === false) {
    const detail = typeof control.error === 'string' && control.error.length > 0 ? `（${control.error}）` : ''
    disableCompose(`PC 側でセッション開始が使えません${detail}。`)
  } else {
    setComposeEnabled(true)
    setComposeStatus('', 'info')
  }
  syncWorkspacePath()
}

async function loadWorkspaces({ quiet = false } = {}) {
  if (!quiet) {
    setComposeEnabled(false)
    setComposeStatus('ワークスペースを読み込んでいます…', 'info')
  }
  try {
    const response = await fetch(`/api/workspaces${search()}`, { cache: 'no-store' })
    if (response.status === 401) {
      disableCompose('アクセストークンが必要です。この画面の URL の ?k= を確認してください。')
      return false
    }
    if (!response.ok) {
      disableCompose(`ワークスペースを取得できませんでした（HTTP ${response.status}）。再読み込みしてください。`)
      return false
    }
    applyWorkspaces(await response.json())
    return true
  } catch {
    disableCompose('ワークスペースを取得できません。PC 側の接続を確認してください。')
    return false
  }
}

const FAILURE_TEXT = {
  prompt_required: 'プロンプトを入力してください。',
  prompt_too_long: `プロンプトが長すぎます（${PROMPT_MAX} 文字まで）。`,
  workspace_required: 'ワークスペースを選んでください。',
  workspace_not_found: 'そのワークスペースが見つかりません。一覧を読み込み直してください。',
  control_disabled: 'PC 側でセッション開始が無効になっています。',
  payload_too_large: '送信内容が大きすぎます。プロンプトを短くしてください。',
  unsupported_media_type: '送信形式が受け付けられませんでした。ページを再読み込みしてください。',
  session_create_failed: 'セッションを作成できませんでした。PC 側のログを確認してください。',
  session_control_unavailable: 'PC 側でセッション制御が使えません。PC で DSH が起動しているか確認してください。',
}

function describeFailure(status, payload) {
  // The Host documents `{ ok: false, error: <code>, message }`, so the machine
  // code arrives in `error`; a top-level `code` is accepted as well.
  const reported = typeof payload?.code === 'string' ? payload.code : typeof payload?.error === 'string' ? payload.error : ''
  const code = typeof FAILURE_TEXT[reported] === 'string' ? reported : ''
  if (status === 401) return 'アクセストークンが必要です。この画面の URL の ?k= を確認してください。'
  if (status === 403) return FAILURE_TEXT.control_disabled
  if (status === 413) return FAILURE_TEXT.payload_too_large
  if (status === 415) return FAILURE_TEXT.unsupported_media_type
  if (status === 502) return FAILURE_TEXT.session_create_failed
  if (status === 503) return FAILURE_TEXT.session_control_unavailable
  if (code.length > 0 && typeof FAILURE_TEXT[code] === 'string') return FAILURE_TEXT[code]
  const detail = typeof payload?.message === 'string' ? payload.message : typeof payload?.error === 'string' ? payload.error : ''
  return detail.length > 0 ? `開始できませんでした: ${detail}` : `開始できませんでした（HTTP ${status}）。`
}

function scrollToProgress() {
  const target = els.progressCard
  if (!target || typeof target.scrollIntoView !== 'function') return
  target.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' })
}

/**
 * The outbound prompt for one request: the typed text, plus the fan-out
 * directive when the toggle is on. Kept pure so the exact bytes the Host will
 * receive can be checked without submitting a session.
 */
function buildPrompt(text, fanout) {
  return fanout ? `${text}\n\n${FANOUT_DIRECTIVE}` : text
}

async function startSession() {
  if (composeBusy || !composeReady) return
  const workspaceId = els.workspaceSelect?.value || ''
  const prompt = els.promptInput?.value.trim() || ''
  const fanout = els.fanoutToggle?.checked === true
  if (workspaceId.length === 0) {
    setComposeStatus('ワークスペースを選んでください。')
    return
  }
  if (prompt.length === 0) {
    setComposeStatus('プロンプトを入力してください。')
    els.promptInput?.focus()
    return
  }

  // The toggle adds prompt text, not Host state, so the Host validates the
  // whole body against control.maxPromptChars: keep the directive inside the
  // budget instead of letting the request fail with prompt_too_long.
  const outbound = buildPrompt(prompt, fanout)
  if (outbound.length > PROMPT_MAX) {
    setComposeStatus(`fan-out 指示を含めると上限を超えます（${PROMPT_MAX} 文字）。プロンプトを短くしてください。`)
    return
  }

  composeBusy = true
  els.startBtn.disabled = true
  els.promptInput.disabled = true
  text(els.startBtn, '開始しています…')
  setComposeStatus('セッションを開始しています…', 'info')

  try {
    const response = await fetch(`/api/session${search()}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId, prompt: outbound }),
    })
    const payload = await response.json().catch(() => null)
    if (response.status === 201 && payload?.ok) {
      sessionStartAt = Date.now()
      els.promptInput.value = ''
      updatePromptCount()
      // One-shot, like the desktop checkbox: the next prompt is a new intent.
      if (fanout && els.fanoutToggle) els.fanoutToggle.checked = false
      setComposeStatus(
        fanout ? 'fan-out 指示付きでセッションを開始しました。進捗を表示します。' : 'セッションを開始しました。進捗を表示します。',
        'ok',
      )
      toast(fanout ? 'fan-out 指示付きで開始しました' : 'セッションを開始しました')
      scrollToProgress()
      return
    }
    setComposeStatus(describeFailure(response.status, payload))
  } catch {
    setComposeStatus('送信できませんでした。通信状態を確認して、もう一度お試しください。')
  } finally {
    composeBusy = false
    if (els.promptInput) els.promptInput.disabled = false
    text(els.startBtn, '送信して開始')
    els.startBtn.disabled = !composeReady
  }
}

function setupCompose() {
  els.startBtn?.addEventListener('click', () => void startSession())
  els.workspaceSelect?.addEventListener('change', () => {
    syncWorkspacePath()
    setComposeStatus('', 'info')
  })
  els.fanoutToggle?.addEventListener('change', () => {
    // Toggling only changes the next request; clear a stale error/success line.
    setComposeStatus('', 'info')
  })
  els.promptInput?.addEventListener('input', updatePromptCount)
  els.promptInput?.addEventListener('keydown', (event) => {
    // Cmd/Ctrl+Enter submits, like the desktop composer; a bare Enter still
    // inserts a newline so a multi-line prompt stays easy to write.
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      void startSession()
    }
  })
  updatePromptCount()
}

// -- final result ------------------------------------------------------------

/** Render the folded final assistant text. Always textContent: never innerHTML. */
function renderResult(session) {
  if (!els.resultCard) return
  const result = session?.result && typeof session.result === 'object' ? session.result : null
  const body = result && typeof result.text === 'string' ? result.text : ''
  const visible = body.trim().length > 0

  els.resultCard.hidden = !visible
  if (!visible) {
    if (els.resultText.textContent !== '') text(els.resultText, '')
    if (els.resultMeta.textContent !== '') text(els.resultMeta, '')
    return
  }

  text(els.resultText, body)
  const live = Boolean(session.agentRunning) || session.status === 'working'
  els.resultBadge.dataset.state = live ? 'live' : 'ready'
  text(els.resultBadge, live ? '受信中' : '完成')

  const reported = Number(result.chars)
  const chars = Number.isFinite(reported) && reported > 0 ? reported : body.length
  const meta = [`${chars.toLocaleString('ja-JP')} 文字`]
  const turn = Number(result.turn)
  if (Number.isFinite(turn) && turn > 0) meta.push(`ターン ${turn}`)
  if (result.truncated === true) meta.push('長いため末尾を省略しています')
  text(els.resultMeta, meta.join(' · '))
}

// -- install / PWA ----------------------------------------------------------

function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true
}

function setupInstallHint() {
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent)
  text(els.selfUrl, `${location.origin}${location.pathname}`)

  if (isStandalone()) {
    text(els.installHint, 'アプリとして起動中です。')
    return
  }
  if (isIOS) {
    text(els.installHint, 'iPhone / iPad: Safari の共有ボタン →「ホーム画面に追加」でアプリのように開けます。')
  } else {
    text(els.installHint, 'ブラウザのメニューから「ホーム画面に追加」または「インストール」を選べます。')
  }

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault()
    deferredPrompt = event
    els.installBtn.hidden = false
    text(els.installHint, 'この画面をアプリとしてインストールできます。')
  })

  window.addEventListener('appinstalled', () => {
    deferredPrompt = null
    els.installBtn.hidden = true
    text(els.installHint, 'インストールしました。ホーム画面から開けます。')
    toast('ホーム画面に追加しました')
  })

  els.installBtn.addEventListener('click', async () => {
    if (!deferredPrompt) return
    deferredPrompt.prompt()
    try {
      await deferredPrompt.userChoice
    } catch {
      // The user dismissed the prompt.
    }
    deferredPrompt = null
    els.installBtn.hidden = true
  })
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return
  const secure = location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1'
  if (!secure) return

  const hadController = Boolean(navigator.serviceWorker.controller)
  let reloading = false

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // Only reload when this page was already controlled: the first install also
    // fires controllerchange and must not bounce the user.
    if (!hadController || reloading) return
    reloading = true
    location.reload()
  })

  try {
    const registration = await navigator.serviceWorker.register(`/sw.js${location.search}`, { scope: '/' })
    const activateWaiting = () => {
      if (!hadController) return
      registration.waiting?.postMessage({ type: 'SKIP_WAITING' })
    }
    activateWaiting()
    registration.addEventListener('updatefound', () => {
      const worker = registration.installing
      worker?.addEventListener('statechange', () => {
        if (worker.state === 'installed') activateWaiting()
      })
    })
  } catch {
    // No Service Worker (insecure origin / private mode) still leaves a working page.
  }
}

function setupShare() {
  els.copyBtn?.addEventListener('click', async () => {
    const value = els.publicLink?.getAttribute('href') || location.href
    try {
      await navigator.clipboard.writeText(value)
      toast('URL をコピーしました')
    } catch {
      const area = document.createElement('textarea')
      area.value = value
      document.body.append(area)
      area.select()
      document.execCommand('copy')
      area.remove()
      toast('URL をコピーしました')
    }
  })
}

function init() {
  setupInstallHint()
  setupShare()
  setupCompose()
  if (location.hash === '#logsCard') els.logsCard.open = true
  void registerServiceWorker()
  void loadWorkspaces()

  const snapshot = loadSnapshot()
  if (snapshot) {
    render(snapshot.data)
    setConn('offline', '復元中')
    setOffline(true, 'オフライン — 最後に受け取った状態です')
  }

  void fetchState()

  if (typeof EventSource === 'function') {
    connect()
  }

  setInterval(tick, 1000)
  // The poll is a cheap safety net for a stalled SSE stream; it also keeps the
  // page fresh when the phone returns from the background.
  setInterval(() => void fetchState({ quiet: true }), 8000)

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      void fetchState({ quiet: true })
      if (!sseOpen && reconnectTimer === null) scheduleReconnect()
    }
  })

  window.addEventListener('online', () => {
    if (!sseOpen && reconnectTimer === null) scheduleReconnect()
  })

  window.addEventListener('offline', () => {
    setConn('offline', 'オフライン')
    setOffline(true, 'オフライン — 最後に受け取った状態です')
  })
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true })
} else {
  init()
}

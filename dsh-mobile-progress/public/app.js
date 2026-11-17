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
  if (location.hash === '#logsCard') els.logsCard.open = true
  void registerServiceWorker()

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

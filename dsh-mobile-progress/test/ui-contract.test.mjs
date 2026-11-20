/**
 * UI contract tests for the phone page.
 *
 * These read the real shipped files as text, so they run with plain `node --test`
 * and no browser, DOM or network. They pin the pieces the Host contract depends
 * on: the compose card's element ids and order, the two fetch endpoints, the
 * `POST /api/session` request shape, the "result is textContent, never innerHTML"
 * rule, the mobile layout guarantees, and the service-worker cache policy.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const publicDir = path.join(here, '..', 'public')
const read = (name) => readFileSync(path.join(publicDir, name), 'utf8')

const html = read('index.html')
const app = read('app.js')
const css = read('style.css')
const sw = read('sw.js')

test('the compose card is the first card and rewrites nothing else', () => {
  assert.ok(html.includes('id="composeCard"'), 'composeCard is missing')
  // Reading order on a 360px phone: start a session, then watch it, then read it.
  const order = [
    'id="composeCard"',
    'id="progressCard"',
    'id="requestCard"',
    'id="steps"',
    'id="resultCard"',
    'class="card meta"',
  ]
  for (const id of order) assert.ok(html.includes(id), `${id} is missing`)
  const positions = order.map((id) => html.indexOf(id))
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, 'cards are out of order')
  assert.ok(html.indexOf('id="composeCard"') < html.indexOf('id="statusChip"'))
})

test('every compose control has an id, a label and a disabled initial state', () => {
  for (const id of ['composeCard', 'workspaceSelect', 'promptInput', 'fanoutToggle', 'startBtn', 'composeStatus']) {
    assert.ok(html.includes(`id="${id}"`), `${id} is missing`)
  }
  assert.match(html, /<label[^>]*for="workspaceSelect"/, 'the workspace select has no label')
  assert.match(html, /<label[^>]*for="promptInput"/, 'the prompt textarea has no label')
  assert.match(html, /<label[^>]*for="fanoutToggle"/, 'the fan-out toggle has no label')
  assert.match(html, /<select[^>]*id="workspaceSelect"[^>]*disabled/, 'the select must start disabled')
  assert.match(html, /<button[^>]*id="startBtn"[^>]*disabled[^>]*>送信して開始</, 'start button must start disabled')
  assert.match(html, /id="composeStatus"[^>]*role="status"/, 'the compose status must be a live region')
})

test('the prompt input is a bounded textarea with the agreed placeholder', () => {
  assert.match(html, /<textarea[^>]*id="promptInput"/)
  assert.match(html, /<textarea[^>]*maxlength="8000"/)
  assert.match(html, /placeholder="このワークスペースで何を頼む？"/)
  assert.match(html, /id="promptCount"/, 'the prompt counter is missing')
})

test('the result card is hidden by default and has its heading and badge', () => {
  assert.match(html, /<section[^>]*class="card result"[^>]*id="resultCard"[^>]*hidden/)
  assert.match(html, /id="resultBadge"/)
  assert.match(html, /id="resultText"/)
  assert.match(html, /id="resultMeta"/)
  assert.ok(!html.includes('id="resultText" hidden'), 'the text node itself must stay in the DOM')
})

test('the client asks the host for workspaces and POSTs a new session', () => {
  assert.ok(app.includes('/api/workspaces'), 'the workspace endpoint is missing')
  assert.ok(app.includes('`/api/session${search()}`'), 'the session POST must keep ?k= via search()')
  assert.match(app, /method: 'POST'/)
  assert.match(app, /headers: \{ 'content-type': 'application\/json' \}/)
  assert.match(app, /body: JSON\.stringify\(\{ workspaceId, prompt: outbound \}\)/)
  assert.match(app, /response\.status === 201/, 'only a 201 counts as a started session')
})

test('workspaces load on boot and again whenever the stream reconnects', () => {
  assert.match(app, /async function loadWorkspaces\(/)
  assert.match(app, /void loadWorkspaces\(\)/, 'init must load the workspace list')
  assert.match(app, /source\.onopen = \(\) => \{[\s\S]*?void loadWorkspaces\(\{ quiet: true \}\)/)
  assert.match(app, /if \(response\.status === 401\)/, 'a missing token needs its own branch')
})

test('the workspace select shows only the leaf directory name', () => {
  assert.match(app, /function pathLeaf\(value\)/)
  assert.ok(!app.includes('shortPath'), 'the old tail-of-path formatter must be gone')
  assert.match(app, /pathLeaf\(item\.path\) \|\| item\.title/)
  assert.match(app, /option\.title = item\.path/, 'the full path must stay on the option title')
  assert.ok(
    app.includes("chosen.title !== leaf ? chosen.title : ''"),
    'the hint must be a name, not the full path',
  )
})

test('the fan-out toggle turns into a one-shot prompt directive', () => {
  assert.match(html, /<input[^>]*type="checkbox"[^>]*id="fanoutToggle"/)
  assert.match(app, /const fanout = els\.fanoutToggle\?\.checked === true/)
  assert.match(app, /function buildPrompt\(text, fanout\)/)
  assert.ok(
    app.includes('const outbound = buildPrompt(prompt, fanout)'),
    'the toggle must only change the outbound prompt',
  )
  assert.match(app, /outbound\.length > PROMPT_MAX/, 'the directive must stay inside the prompt budget')
  assert.ok(app.includes('fanout_start'), 'the directive must name the fan-out tool')
  assert.match(app, /els\.fanoutToggle\.checked = false/, 'the toggle is one-shot')
})

test('compose failures explain themselves in Japanese, per HTTP status and code', () => {
  assert.ok(app.includes('?k='), 'the 401 message must point at the token parameter')
  assert.match(app, /status === 401/)
  assert.match(app, /status === 503/)
  assert.ok(app.includes('セッション制御が使えません'), 'the 503 message must name session control')
  for (const code of [
    'prompt_required',
    'prompt_too_long',
    'workspace_required',
    'workspace_not_found',
    'control_disabled',
    'payload_too_large',
    'unsupported_media_type',
    'session_create_failed',
    'session_control_unavailable',
  ]) {
    assert.ok(app.includes(code), `the ${code} failure has no message`)
  }
})

test('sending disables the button and shows progress text', () => {
  assert.match(app, /'開始しています…'/)
  assert.match(app, /els\.startBtn\.disabled = true/)
  assert.match(app, /els\.promptInput\.value = ''/, 'a successful start clears the prompt')
  assert.match(app, /scrollToProgress\(\)/, 'a successful start scrolls to the progress card')
})

test('the result is rendered as text, never as markup', () => {
  assert.match(app, /text\(els\.resultText, body\)/)
  assert.ok(!/\.innerHTML\s*=/.test(app), 'innerHTML must never be assigned')
  assert.ok(!app.includes('insertAdjacentHTML'), 'insertAdjacentHTML must never be used')
  assert.ok(!app.includes('outerHTML'), 'outerHTML must never be used')
  assert.match(app, /els\.resultBadge\.dataset\.state/, 'the badge must follow the live state')
  assert.match(app, /'受信中'/)
  assert.match(app, /'完成'/)
  assert.match(app, /truncated === true/)
})

test('a changed session id repaints the step and log lists', () => {
  assert.match(app, /let renderedSessionId = null/)
  assert.match(app, /const switched = sessionId !== null && renderedSessionId !== null/)
  assert.match(app, /stepSignature = ''/)
  assert.match(app, /logSignature = ''/)
  assert.match(app, /renderedSessionId = sessionId/)
})

test('the stylesheet keeps a 360px phone readable and reachable', () => {
  assert.ok(css.includes('env(safe-area-inset-bottom)'), 'the bottom inset is not respected')
  assert.match(css, /white-space: pre-wrap/, 'the result must keep its newlines')
  assert.match(css, /word-break: break-word/, 'long tokens must wrap')
  assert.match(css, /min-height: 44px/, 'tap targets must be at least 44px')
  assert.match(css, /:focus-visible/, 'keyboard focus must stay visible')
  assert.ok(css.includes('prefers-reduced-motion'), 'reduced motion is not respected')
  assert.ok(css.includes('@media (max-width: 380px)'), 'the narrow-phone layout is missing')
})

test('the service worker is v6 and never caches a session start', () => {
  assert.match(sw, /const VERSION = 'v6'/)
  assert.ok(sw.includes("'/api/workspaces'"), 'the workspace read is not in the cacheable API list')
  assert.match(sw, /if \(request\.method !== 'GET'\) return/, 'non-GET requests must bypass the cache')
  assert.ok(sw.includes("if (url.pathname === '/api/session') return"), 'POST /api/session must bypass the cache')
  assert.match(sw, /networkFirstJson/)
  assert.match(sw, /caches\.delete/, 'stale caches must still be deleted on activate')
})

test('the service worker cache key still drops the access token', () => {
  assert.match(sw, /function cacheKey\(url\)/)
  assert.ok(sw.includes('${parsed.origin}${parsed.pathname}'), 'the cache key must be origin + pathname only')
  assert.ok(!sw.includes('cacheKey(request.url)}?k='), 'the token must not leak into a cache key')
})

test('offline restore and the live stream survive the redesign', () => {
  assert.match(app, /new EventSource\(`\/api\/stream\$\{search\(\)\}`\)/)
  assert.ok(app.includes('/api/state'))
  assert.ok(app.includes('localStorage'))
  assert.match(app, /setOffline\(/)
})

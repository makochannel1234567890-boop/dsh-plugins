/* dsh-mobile-progress service worker (v2).
 *
 * Makes the phone page a real PWA:
 *  - the app shell is precached, so the app opens with no network at all;
 *  - `/api/state` is network-first with the last good snapshot as fallback, so
 *    an offline phone still shows the last progress it received;
 *  - `/api/stream` (SSE) is never intercepted.
 *
 * Service workers only run on a secure origin. The LAN URL over plain HTTP
 * installs as a bookmark-like shortcut; the public HTTPS tunnel URL (or
 * localhost) gets the full offline app.
 *
 * The page registers `/sw.js<search>`, so `self.location.search` carries the
 * `?k=<token>` query needed to re-fetch token-protected resources.
 */

const VERSION = 'v4'
const SHELL_CACHE = `dsh-progress-shell-${VERSION}`
const DATA_CACHE = `dsh-progress-data-${VERSION}`
const TOKEN = self.location.search || ''

const SHELL = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/icon.svg',
  '/icon-180.png',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-512.png',
  '/manifest.webmanifest',
]

/** Attach the token query the same way the Host plugin does. */
function withToken(url, token) {
  const raw = String(url || '/')
  if (!token) return raw
  const hashAt = raw.indexOf('#')
  const hash = hashAt >= 0 ? raw.slice(hashAt) : ''
  const base = hashAt >= 0 ? raw.slice(0, hashAt) : raw
  const pathPart = base.length > 0 ? base : '/'
  const separator = pathPart.includes('?') ? '&' : '?'
  return `${pathPart}${separator}k=${encodeURIComponent(token.replace(/^\?k=/, ''))}${hash}`
}

/** Cache keys ignore the query string, so `/` and `/?k=…` share one entry. */
function cacheKey(url) {
  const parsed = new URL(url, self.location.origin)
  return `${parsed.origin}${parsed.pathname}`
}

async function precache() {
  const cache = await caches.open(SHELL_CACHE)
  await Promise.all(
    SHELL.map(async (path) => {
      const target = withToken(path, TOKEN)
      try {
        const response = await fetch(target, { cache: 'reload' })
        if (response.ok) await cache.put(cacheKey(target), response.clone())
      } catch {
        // A single missing asset must not abort the install.
      }
    }),
  )
}

self.addEventListener('install', (event) => {
  event.waitUntil(precache().catch(() => undefined))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys()
      await Promise.all(
        keys
          .filter((key) => key !== SHELL_CACHE && key !== DATA_CACHE)
          .map((key) => caches.delete(key)),
      )
      await self.clients.claim()
    })().catch(() => undefined),
  )
})

self.addEventListener('message', (event) => {
  const data = event.data
  if (data && data.type === 'SKIP_WAITING') {
    void self.skipWaiting()
  }
  if (data && data.type === 'PING') {
    event.source?.postMessage?.({ type: 'PONG', version: VERSION })
  }
})

async function cachedShell(request) {
  const cache = await caches.open(SHELL_CACHE)
  return (
    (await cache.match(cacheKey(request.url))) ||
    (await cache.match(cacheKey(`${self.location.origin}/`))) ||
    (await cache.match(cacheKey(`${self.location.origin}/index.html`)))
  )
}

async function networkFirstNavigation(request) {
  let response = null
  try {
    response = await fetch(withToken(request.url, TOKEN), { cache: 'no-store' })
  } catch {
    response = null
  }
  // A dead tunnel answers 502/530 instead of failing the request, so a non-2xx
  // navigation must fall back to the cached shell just like a network error.
  if (response !== null && response.ok) {
    const cache = await caches.open(SHELL_CACHE)
    await cache.put(cacheKey(request.url), response.clone())
    return response
  }
  const cached = await cachedShell(request)
  if (cached) {
    const headers = new Headers(cached.headers)
    headers.set('x-dsh-offline', '1')
    return new Response(cached.body, { status: 200, headers })
  }
  if (response !== null) return response
  return new Response(
    '<!doctype html><meta charset="utf-8"><title>オフライン</title><p style="font-family:system-ui;padding:24px">まだ画面を保存できていません。PC 側で DSH が起動しているか確認してください。</p>',
    { status: 503, headers: { 'content-type': 'text/html; charset=utf-8' } },
  )
}

async function networkFirstJson(request) {
  const cache = await caches.open(DATA_CACHE)
  const key = cacheKey(request.url)
  let response = null
  try {
    response = await fetch(withToken(request.url, TOKEN), { cache: 'no-store' })
  } catch {
    response = null
  }
  if (response !== null && response.ok) {
    await cache.put(key, response.clone())
    return response
  }
  const cached = await cache.match(key)
  if (cached) {
    const headers = new Headers(cached.headers)
    headers.set('x-dsh-offline', '1')
    return new Response(cached.body, { status: 200, headers })
  }
  if (response !== null) return response
  return new Response(JSON.stringify({ ok: false, offline: true, error: 'offline' }), {
    status: 503,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(SHELL_CACHE)
  const key = cacheKey(request.url)
  const cached = await cache.match(key)
  const update = fetch(withToken(request.url, TOKEN))
    .then(async (response) => {
      if (response.ok) await cache.put(key, response.clone())
      return response
    })
    .catch(() => null)
  if (cached) {
    void update
    return cached
  }
  const fresh = await update
  if (fresh) return fresh
  return new Response('', { status: 504 })
}

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  // Live streams must never be served from, or written to, a cache.
  if (url.pathname === '/api/stream') return
  if (url.pathname === '/healthz') return
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(networkFirstJson(request))
    return
  }
  if (request.mode === 'navigate') {
    event.respondWith(networkFirstNavigation(request))
    return
  }
  event.respondWith(staleWhileRevalidate(request))
})

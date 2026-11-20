/**
 * dsh-social-desktop-agent / lib/browser/cdp-driver.js
 *
 * 実ブラウザ用ドライバ（Chrome DevTools Protocol / 依存ゼロ）。
 *
 * ★ このファイルはテストでは一切使わない。
 *   単体テストは stub-driver.js だけを使い、ネットワーク呼び出しゼロで完結する。
 *   ここは「本番でだけ通る経路」なので、import しただけでは何も起きない（接続しない）。
 *
 * 前提と安全策:
 *   - DSH を `--remote-debugging-port=9222` で起動していること（未起動なら NO_TARGET で失敗）
 *   - 操作対象は **webview target のみ**。DSH のシェル（type:"page"）は既定で絶対に掴まない。
 *     これは dsh-browser-agent が実際に「シェルを example.com にナビゲートした」事故の再発防止。
 *   - `open()` は http(s) 以外と `user:pass@` 付き URL を接続前に拒否する
 *   - Cookie の読み書き・永続化はしない（資格情報を一切保存しない）
 *
 * Node 24 のグローバル WebSocket / fetch だけを使う（npm 依存の追加なし）。
 */

import { DriverError, normalizeSnapshotResult } from './driver.js';
import { parseTargetUrl } from './policies.js';

const DEFAULT_PORT = 9222;
const RPC_TIMEOUT_MS = 20000;
const CONNECT_TIMEOUT_MS = 6000;

/** ref → `[data-dsa-ref="e3"]`。式に埋め込むときは必ず JSON.stringify する。 */
function refSelector(ref) {
  return `[data-dsa-ref="${String(ref).replace(/["\\]/g, '')}"]`;
}

/**
 * ページ内で「操作可能な要素」を列挙し、ref（e1, e2, ...）を振る。
 * ref は DOM 属性 `data-dsa-ref` として要素に書き込むので、後続の click/type は
 * その属性で引き当てられる（スナップショットと操作の間で DOM が変わっても、
 * 同じ要素が残っていれば正しく当たる／消えていれば NO_SUCH_REF で失敗する）。
 *
 * ⚠️ 限界: これは DOM ベースの近似アクセシビリティツリー。
 *    shadow DOM / iframe 内部は対象外。Instagram のような SPA では
 *    「スナップショット → クリック」の間に再レンダリングされると ref が失効する。
 */
const SNAPSHOT_SCRIPT = `(() => {
  const SNAP = String(SNAP_ID);
  const SEL = [
    'a[href]', 'button', 'input', 'textarea', 'select',
    '[role="button"]', '[role="link"]', '[role="textbox"]', '[role="menuitem"]',
    '[role="tab"]', '[role="checkbox"]', '[contenteditable="true"]'
  ].join(',');
  const roleOf = (el) => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'select') return 'combobox';
    if (tag === 'input') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      if (t === 'checkbox' || t === 'radio') return t;
      if (t === 'submit' || t === 'button' || t === 'reset') return 'button';
      return 'textbox';
    }
    return 'generic';
  };
  const nameOf = (el) => {
    const aria = el.getAttribute('aria-label');
    if (aria) return aria;
    const tag = el.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea') {
      return el.getAttribute('placeholder') || el.getAttribute('title') || el.value || '';
    }
    const text = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
    if (text) return text;
    return el.getAttribute('title') || el.getAttribute('alt') || '';
  };
  const limit = Number(MAX_NODES) || 200;
  const out = [];
  let i = 0;
  for (const el of document.querySelectorAll(SEL)) {
    if (i >= limit) break;
    if (!(el instanceof Element)) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    if (el.getAttribute('aria-hidden') === 'true') continue;
    const style = window.getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') continue;
    i += 1;
    const ref = 'e' + i;
    el.setAttribute('data-dsa-ref', ref);
    el.setAttribute('data-dsa-snap', SNAP);
    out.push({
      ref,
      role: roleOf(el),
      name: String(nameOf(el)).replace(/\\s+/g, ' ').trim().slice(0, 200),
      type: el.getAttribute('type') || null,
      url: el.tagName.toLowerCase() === 'a' && el.href ? el.href : null,
      disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true'
    });
  }
  return {
    url: location.href,
    title: document.title,
    text: (document.body && document.body.innerText ? document.body.innerText : '').slice(0, 20000),
    snap: SNAP,
    nodes: out
  };
})()`;

/**
 * 実ブラウザドライバを作る。
 *
 * @param {object} [options]
 * @param {number} [options.port=9222]     CDP のポート
 * @param {string} [options.wsUrl]         直接指定（target 探索を飛ばす。上級者向け）
 * @param {boolean} [options.allowShell]   DSH シェル（type:"page"）も対象にする。既定 false。
 * @param {number} [options.settleMs=350]  遷移/クリック後に落ち着くのを待つ時間
 */
export function createCdpDriver(options = {}) {
  const port = Number(options.port) > 0 ? Number(options.port) : DEFAULT_PORT;
  const explicitWsUrl = typeof options.wsUrl === 'string' && options.wsUrl ? options.wsUrl : null;
  const allowPageTargets = options.allowShell === true || options.allowPageTargets === true;
  const settleMs = Number.isFinite(options.settleMs) ? Math.max(0, Number(options.settleMs)) : 350;

  const stats = { connects: 0, sends: 0, opens: 0 };
  let ws = null;
  let seq = 0;
  let target = null;
  const pending = new Map();

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function fail(code, message) {
    throw new DriverError(code, message);
  }

  async function fetchJson(path, timeoutMs) {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) fail('CDP_HTTP_ERROR', `CDP ${path} が HTTP ${res.status} を返しました`);
    return res.json();
  }

  /** webview target を選ぶ。type:"page"（DSH シェル）は allowShell 明示時のみ。 */
  async function pickTarget() {
    const list = await fetchJson('/json/list', 4000);
    const targets = (Array.isArray(list) ? list : []).filter((t) => t && t.webSocketDebuggerUrl);
    const usable = targets.filter((t) => t.type === 'webview' || (allowPageTargets && t.type === 'page'));
    const httpOnes = usable.filter((t) => /^https?:/i.test(String(t.url ?? '')));
    const chosen = httpOnes[httpOnes.length - 1] ?? usable[usable.length - 1];
    if (!chosen) {
      fail(
        'NO_TARGET',
        allowPageTargets
          ? 'CDP で操作できる target がありません（--remote-debugging-port と、そのポートで開いているタブを確認してください）'
          : '操作できる webview target がありません。DSH を --remote-debugging-port 付きで起動し、ブラウザタブを開いてください（シェルは安全のため対象外）',
      );
    }
    return { id: chosen.id, type: chosen.type, url: String(chosen.url ?? ''), wsUrl: chosen.webSocketDebuggerUrl };
  }

  function onMessage(event) {
    let msg;
    try {
      msg = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
    } catch {
      return;
    }
    if (msg.id == null) return; // イベントは無視（このドライバは request/response のみ使う）
    const slot = pending.get(msg.id);
    if (!slot) return;
    pending.delete(msg.id);
    clearTimeout(slot.timer);
    if (msg.error) slot.reject(new DriverError('CDP_ERROR', `CDP ${slot.method}: ${msg.error.message ?? 'error'}`, msg.error));
    else slot.resolve(msg.result);
  }

  /**
   * 古いスナップショットの ref を掴んでいないか確認する。
   * ref は DOM 属性（data-dsa-ref）で引き当てるため、再スナップショットで採番が
   * 変わると別要素に当たってしまう。要素に刻んだスナップショット ID を照合し、
   * 不一致なら操作せず STALE_REF で止める。
   */
  async function assertSameSnapshot(selector, expected) {
    const current = await evaluate(
      `(() => { const el = document.querySelector(${selector}); return el ? el.getAttribute('data-dsa-snap') : null; })()`,
    );
    if (current !== expected) {
      fail('STALE_REF', 'ref は別のスナップショットのものです（browse_snapshot を取り直してください）');
    }
  }

  async function ensureConnected() {    if (ws && ws.readyState === 1) return;
    if (explicitWsUrl) {
      target = { id: 'explicit', type: 'explicit', url: '', wsUrl: explicitWsUrl };
    } else {
      target = await pickTarget();
    }
    stats.connects += 1;
    await new Promise((resolve, reject) => {
      let settled = false;
      const socket = new WebSocket(target.wsUrl);
      ws = socket;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          socket.close();
        } catch {}
        reject(new DriverError('CDP_TIMEOUT', `CDP 接続がタイムアウトしました（${CONNECT_TIMEOUT_MS}ms）`));
      }, CONNECT_TIMEOUT_MS);

      socket.addEventListener('open', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      });
      socket.addEventListener('error', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new DriverError('CDP_CONNECT_FAILED', `CDP に接続できません: ${target.wsUrl}`));
      });
      socket.addEventListener('message', onMessage);
      socket.addEventListener('close', () => {
        for (const [, slot] of pending) {
          clearTimeout(slot.timer);
          slot.reject(new DriverError('CDP_CLOSED', 'CDP 接続が閉じられました'));
        }
        pending.clear();
        ws = null;
      });
    });
  }

  async function rpc(method, params = {}, timeoutMs = RPC_TIMEOUT_MS) {
    await ensureConnected();
    const id = ++seq;
    stats.sends += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new DriverError('CDP_TIMEOUT', `CDP ${method} がタイムアウトしました（${timeoutMs}ms）`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer, method });
      try {
        ws.send(JSON.stringify({ id, method, params }));
      } catch (e) {
        clearTimeout(timer);
        pending.delete(id);
        reject(new DriverError('CDP_SEND_FAILED', `CDP 送信に失敗しました: ${String(e?.message ?? e)}`));
      }
    });
  }

  /** ページ内で式を評価して値を返す（例外は DriverError に変換）。 */
  async function evaluate(expression) {
    const result = await rpc('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result?.exceptionDetails) {
      const text = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'page exception';
      fail('PAGE_EXCEPTION', `ページ内で例外が発生しました: ${String(text).slice(0, 400)}`);
    }
    return result?.result?.value;
  }

  const driver = {
    async open(url) {
      // 接続前に検証する（ネットワークに一切触れずに落とせる）
      const parsed = parseTargetUrl(url);
      if (!parsed.ok) fail('INVALID_URL', parsed.message);
      await rpc('Page.enable');
      await rpc('Page.navigate', { url: parsed.url });
      await sleep(settleMs);
      stats.opens += 1;
      const page = await driver.getPage();
      return { url: page.url, title: page.title };
    },

    async getPage() {
      const page = await evaluate(
        `(() => ({
          url: location.href,
          title: document.title,
          text: (document.body && document.body.innerText ? document.body.innerText : '').slice(0, 20000)
        }))()`,
      );
      return {
        url: String(page?.url ?? ''),
        title: String(page?.title ?? ''),
        text: String(page?.text ?? ''),
      };
    },

    async snapshot(snapOptions = {}) {
      const maxNodes = Number(snapOptions.maxNodes) > 0 ? Math.trunc(Number(snapOptions.maxNodes)) : 200;
      // 各スナップショットに固有 ID を振る。ref は DOM 属性に書き込まれるため、
      // 再スナップショットで採番が変わると古い ref が別要素を指す。呼び出し側は
      // この snapId を click/type に渡し、取り違えを STALE_REF として弾く。
      const snapId = `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      const script = SNAPSHOT_SCRIPT.replace('Number(MAX_NODES) || 200', String(maxNodes)).replace(
        'String(SNAP_ID)',
        JSON.stringify(snapId),
      );
      const raw = await evaluate(script);
      return { ...normalizeSnapshotResult(raw), snapId };
    },

    async describe(ref) {
      const selector = JSON.stringify(refSelector(ref));
      const node = await evaluate(
        `(() => {
          const el = document.querySelector(${selector});
          if (!el) return null;
          return {
            ref: String(el.getAttribute('data-dsa-ref')),
            role: el.getAttribute('role') || el.tagName.toLowerCase(),
            name: (el.getAttribute('aria-label') || el.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 200),
            type: el.getAttribute('type') || null,
            url: el.tagName.toLowerCase() === 'a' && el.href ? el.href : null,
            disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
            snap: el.getAttribute('data-dsa-snap')
          };
        })()`,
      );
      return node ?? null;
    },

    async click(ref, clickOptions = {}) {
      const selector = JSON.stringify(refSelector(ref));
      if (clickOptions.snapId) await assertSameSnapshot(selector, clickOptions.snapId);
      const rect = await evaluate(
        `(() => {
          const el = document.querySelector(${selector});
          if (!el) return null;
          el.scrollIntoView({ block: 'center', inline: 'center' });
          const r = el.getBoundingClientRect();
          return {
            x: Math.round(r.left + r.width / 2),
            y: Math.round(r.top + r.height / 2),
            role: el.getAttribute('role') || el.tagName.toLowerCase(),
            name: (el.getAttribute('aria-label') || el.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 200)
          };
        })()`,
      );
      if (!rect) fail('NO_SUCH_REF', `ref ${ref} は現在のページにありません（browse_snapshot を取り直してください）`);

      // 実際のポインタ操作を流す（element.click() より信頼される）
      await rpc('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y, button: 'none' });
      await rpc('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
      await rpc('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
      await sleep(settleMs);

      return { ref: String(ref), role: rect.role, name: rect.name };
    },

    async type(ref, text, typeOptions = {}) {
      const selector = JSON.stringify(refSelector(ref));
      if (typeOptions.snapId) await assertSameSnapshot(selector, typeOptions.snapId);
      const focused = await evaluate(
        `(() => {
          const el = document.querySelector(${selector});
          if (!el) return false;
          el.focus();
          if (typeof el.select === 'function') el.select();
          return true;
        })()`,
      );
      if (!focused) fail('NO_SUCH_REF', `ref ${ref} は現在のページにありません`);

      await rpc('Input.insertText', { text: String(text) });
      if (typeOptions.submit === true) {
        await rpc('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 13, key: 'Enter', code: 'Enter' });
        await rpc('Input.dispatchKeyEvent', { type: 'char', text: '\r', key: 'Enter' });
        await rpc('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 13, key: 'Enter', code: 'Enter' });
      }
      await sleep(Math.min(settleMs, 200));
      return { ref: String(ref), submitted: typeOptions.submit === true };
    },

    async scroll(scrollOptions = {}) {
      const deltaY = Number(scrollOptions.deltaY) || 0;
      if (scrollOptions.ref) {
        await evaluate(
          `(() => {
            const el = document.querySelector('[data-dsa-ref="${String(scrollOptions.ref).replace(/["\\]/g, '')}"]');
            if (el) el.scrollIntoView({ block: 'center' });
            return true;
          })()`,
        );
      } else {
        // ビューポート中央で実ホイールを回す（フォーカス非依存）
        const metrics = await evaluate('({ w: window.innerWidth, h: window.innerHeight })');
        const x = Math.round((metrics?.w ?? 800) / 2);
        const y = Math.round((metrics?.h ?? 600) / 2);
        await rpc('Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x,
          y,
          deltaX: 0,
          deltaY,
          button: 'none',
        });
      }
      await sleep(Math.min(settleMs, 250));
      const y = await evaluate('window.scrollY');
      return { y: Number.isFinite(y) ? y : null, deltaY };
    },

    async screenshot(shotOptions = {}) {
      const result = await rpc('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: shotOptions.fullPage === true,
      });
      const base64 = String(result?.data ?? '');
      if (!base64) fail('SCREENSHOT_FAILED', 'スクリーンショットの取得に失敗しました');
      return { mimeType: 'image/png', dataUrl: `data:image/png;base64,${base64}` };
    },

    async close() {
      try {
        ws?.close();
      } catch {}
      ws = null;
      pending.clear();
      return { ok: true };
    },

    /** 診断用（ツールではない）。 */
    status() {
      return {
        connected: Boolean(ws && ws.readyState === 1),
        port,
        // `allowShell` is the historical name kept for diagnostics compatibility;
        // `allowPageTargets` is the same value under the clearer name.
        allowShell: allowPageTargets,
        allowPageTargets,
        target,
        stats: { ...stats },
      };
    },
  };

  return driver;
}

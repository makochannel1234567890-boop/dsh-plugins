/**
 * dsh-social-desktop-agent / lib/browser/stub-driver.js
 *
 * テスト用のフェイクページドライバ。
 * ネットワークも実ブラウザも一切使わない。呼ばれた回数を全部記録する。
 *
 * 使い方:
 *   const driver = createStubDriver({
 *     pages: [{ url: 'https://www.instagram.com/', title: 'Instagram', text: '...', nodes: [...] }],
 *   });
 *   await driver.open('https://www.instagram.com/');
 *   driver.count('open');   // => 1
 *
 * ページ定義（Node の形は driver.js の契約と同じ）:
 *   { url, title, text, nodes: [{ ref, role, name, value?, url?, type?, disabled?, navigatesTo? }] }
 * `navigatesTo` を付けたノードは、クリックでその URL へ遷移したことになる
 * （ログイン画面 / チェックポイントへの遷移をテストで再現するため）。
 */

import { DriverError, normalizeSnapshotResult } from './driver.js';
import { parseTargetUrl } from './policies.js';

const BLANK = Object.freeze({ url: 'about:blank', title: '', text: '', nodes: [] });

function clonePage(page) {
  return {
    url: String(page.url ?? ''),
    title: String(page.title ?? ''),
    text: String(page.text ?? ''),
    nodes: Array.isArray(page.nodes) ? page.nodes.map((n) => ({ ...n })) : [],
  };
}

export function createStubDriver(options = {}) {
  const pages = Array.isArray(options.pages) ? options.pages.map(clonePage) : [];
  const defaultPage = options.defaultPage ? clonePage(options.defaultPage) : null;

  /** 呼び出し履歴（{ method, args, at }）。テストの「呼ばれていない」検証に使う。 */
  const calls = [];
  /** method -> { remaining, error } 。failNext で注入する。 */
  const failures = new Map();
  let current = null;
  let scrollY = 0;
  let closed = false;

  function record(method, args) {
    calls.push({ method, args, at: Date.now() });
    const injected = failures.get(method);
    if (!injected) return;
    if (injected.remaining <= 1) failures.delete(method);
    else injected.remaining -= 1;
    throw injected.error;
  }

  function matchPage(url) {
    const exact = pages.find((p) => p.url === url);
    if (exact) return exact;
    const prefix = pages.find((p) => p.url && url.startsWith(p.url));
    if (prefix) return prefix;
    return defaultPage;
  }

  const driver = {
    async open(url) {
      record('open', { url });
      const parsed = parseTargetUrl(url);
      if (!parsed.ok) throw new DriverError('INVALID_URL', parsed.message);
      const page = matchPage(parsed.url);
      current = page ? clonePage(page) : { url: parsed.url, title: parsed.url, text: '', nodes: [] };
      closed = false;
      return { url: current.url, title: current.title };
    },

    async getPage() {
      record('getPage', {});
      return {
        url: current?.url ?? BLANK.url,
        title: current?.title ?? BLANK.title,
        text: current?.text ?? BLANK.text,
      };
    },

    async snapshot(snapOptions = {}) {
      record('snapshot', { ...snapOptions });
      const page = current ?? BLANK;
      const maxNodes =
        Number.isFinite(snapOptions.maxNodes) && snapOptions.maxNodes > 0 ? Number(snapOptions.maxNodes) : null;
      const raw = {
        url: page.url,
        title: page.title,
        text: page.text,
        nodes: maxNodes ? page.nodes.slice(0, maxNodes) : page.nodes,
      };
      return { ...normalizeSnapshotResult(raw), text: raw.text };
    },

    async describe(ref) {
      if (typeof ref !== 'string') return null;
      const node = (current?.nodes ?? []).find((n) => n.ref === ref);
      return node ? { ...node } : null;
    },

    async click(ref) {
      record('click', { ref });
      const node = (current?.nodes ?? []).find((n) => n.ref === ref);
      if (!node) throw new DriverError('NO_SUCH_REF', `ref ${String(ref)} は現在のスナップショットにありません`);
      if (node.navigatesTo) {
        const next = matchPage(String(node.navigatesTo));
        current = next
          ? clonePage(next)
          : { url: String(node.navigatesTo), title: '', text: '', nodes: [] };
      }
      return { ref: node.ref, role: node.role, name: node.name };
    },

    async type(ref, text, typeOptions = {}) {
      record('type', { ref, text, submit: typeOptions.submit === true });
      const node = (current?.nodes ?? []).find((n) => n.ref === ref);
      if (!node) throw new DriverError('NO_SUCH_REF', `ref ${String(ref)} は現在のスナップショットにありません`);
      node.value = String(text);
      return { ref: node.ref, submitted: typeOptions.submit === true };
    },

    async scroll(scrollOptions = {}) {
      record('scroll', { ...scrollOptions });
      const deltaY = Number(scrollOptions.deltaY) || 0;
      scrollY += deltaY;
      return { y: scrollY, deltaY };
    },

    async screenshot(shotOptions = {}) {
      record('screenshot', { ...shotOptions });
      return {
        mimeType: 'image/png',
        dataUrl: 'data:image/png;base64,ZmFrZS1wbmc=',
        fullPage: shotOptions.fullPage === true,
      };
    },

    async close() {
      record('close', {});
      closed = true;
      return { ok: true };
    },

    /** テスト専用: 現在ページを強制的に差し替える（SPA 遷移・リダイレクトの再現）。 */
    setPage(page) {
      if (!page) {
        current = null;
        return null;
      }
      current = clonePage(page);
      return current;
    },
  };

  Object.defineProperty(driver, 'calls', { value: calls, enumerable: false });
  Object.defineProperty(driver, 'closed', { get: () => closed, enumerable: false });
  Object.defineProperty(driver, 'currentPage', { get: () => current, enumerable: false });
  Object.defineProperty(driver, 'scrollY', { get: () => scrollY, enumerable: false });

  /** 特定メソッドが何回呼ばれたか。 */
  driver.count = (method) => calls.filter((c) => c.method === method).length;
  /** 履歴をリセットする（操作回数の検証を途中から数え直す）。 */
  driver.clearCalls = () => {
    calls.length = 0;
  };
  /** 次の times 回、そのメソッドを失敗させる（エラー経路のテスト用）。 */
  driver.failNext = (method, code = 'STUB_FAILURE', message = `stub failure: ${method}`, times = 1) => {
    const error = new DriverError(code, message);
    failures.set(method, { remaining: Math.max(1, Number(times) || 1), error });
    return error;
  };

  return driver;
}

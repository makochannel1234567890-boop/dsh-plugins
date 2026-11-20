/**
 * test/browser/helpers.mjs
 *
 * テスト用の共有フィクスチャ。
 * ネットワークも実ブラウザも使わない（fetch / WebSocket を一切呼ばない）。
 */

import { createBrowseTools } from '../../lib/browser/tools.js';
import { createStubDriver } from '../../lib/browser/stub-driver.js';

export const IG_HOME = 'https://www.instagram.com/';
export const IG_LOGIN = 'https://www.instagram.com/accounts/login/';
export const IG_CHALLENGE = 'https://www.instagram.com/challenge/action/123/';
export const IG_TWO_FACTOR = 'https://www.instagram.com/two_factor/';

/** Instagram のログイン済みフィードを模した固定ページ。 */
export function instagramPages() {
  return [
    {
      url: IG_HOME,
      title: 'Instagram',
      text: 'Instagram. Photos and videos from your friends.',
      nodes: [
        { ref: 'e1', role: 'link', name: 'Home', url: `${IG_HOME}home/` },
        { ref: 'e2', role: 'link', name: 'Explore', url: `${IG_HOME}explore/` },
        { ref: 'e3', role: 'button', name: 'Like' },
        { ref: 'e4', role: 'button', name: 'Follow' },
        { ref: 'e5', role: 'textbox', name: 'Search' },
        { ref: 'e6', role: 'link', name: 'Photo by alice on March 1', url: `${IG_HOME}p/abc/` },
        { ref: 'e7', role: 'textbox', name: 'Add a comment' },
        // 実際のフィードには password 欄は無い。認証面（password 欄あり）は
        // IG_LOGIN 側に分離してある。ここに password 欄を混ぜると、ページ単位の
        // 認証面判定（detectAuthSurface）がフィード全体をログイン画面とみなしてしまう。
        { ref: 'e8', role: 'textbox', name: 'Search photos' },
        { ref: 'e9', role: 'link', name: 'External link', url: 'https://evil.example.com/', navigatesTo: 'https://evil.example.com/' },
      ],
    },
    {
      url: IG_LOGIN,
      title: 'Login • Instagram',
      text: 'Log in to Instagram to see photos from your friends.',
      nodes: [
        { ref: 'e1', role: 'textbox', name: 'Phone number, username, or email' },
        { ref: 'e2', role: 'textbox', name: 'Password', type: 'password' },
      ],
    },
    {
      url: IG_CHALLENGE,
      title: 'Checkpoint',
      text: 'Suspicious activity detected. Confirm your identity to continue.',
      nodes: [],
    },
    {
      url: IG_TWO_FACTOR,
      title: 'Two-factor authentication',
      text: 'Enter the 6-digit code we sent to your phone.',
      nodes: [],
    },
  ];
}

export function createStub(options = {}) {
  return createStubDriver({ pages: instagramPages(), ...options });
}

/**
 * 共有契約 `check({scope, kind, target})` を満たすフェイクポリシー。
 * `extra` を渡すと、スコープ判定より先に任意の拒否を差し込める（kill switch 等）。
 */
export function createFakePolicy({ scopes = ['browse.read', 'browse.interact'], extra = null, allowAll = false } = {}) {
  const calls = [];
  const policy = {
    calls,
    check(action) {
      calls.push({ ...action });
      if (typeof extra === 'function') {
        const override = extra(action);
        if (override) return override;
      }
      if (allowAll) return { ok: true };
      if (action.kind === 'social.write') {
        // 実ポリシーと同じく恒久拒否。tools 側の二重防御を検証するときは allowAll を使う。
        return { ok: false, code: 'TARGET_DENIED', message: 'ソーシャル書き込みはこのプラグインでは提供しない' };
      }
      if (!scopes.includes(action.scope)) {
        return { ok: false, code: 'SCOPE_DENIED', message: `scope ${action.scope} は許可されていません` };
      }
      return { ok: true };
    },
    require(action) {
      const decision = policy.check(action);
      if (!decision.ok) {
        const error = new Error(decision.message);
        error.code = decision.code;
        throw error;
      }
      return true;
    },
  };
  return policy;
}

/** 監査ログの採取器。 */
export function createAudit() {
  const entries = [];
  return {
    entries,
    record(entry) {
      entries.push(entry);
    },
    count(decision) {
      return entries.filter((e) => e.decision === decision).length;
    },
  };
}

/** 注入可能な時計。`clock()` で現在 ms、`clock.advance(ms)` で進める。 */
export function createClock(start = 0) {
  const clock = () => clock.t;
  clock.t = start;
  clock.advance = (ms) => {
    clock.t += ms;
    return clock.t;
  };
  return clock;
}

/**
 * 既定のテスト用ツール一式。
 * レート制限は既定で無効化する（レート制御のテストだけが明示的に値を渡す）。
 * `rateLimit: null` を渡すとツール側の既定値（1500ms / 200 回）になる。
 */
export function makeTools(options = {}) {
  const driver = options.driver ?? createStub();
  const policy = options.policy ?? createFakePolicy({ scopes: options.scopes });
  const rateLimit = options.rateLimit === undefined ? { minIntervalMs: 0 } : options.rateLimit;
  return createBrowseTools({
    driver,
    policy,
    audit: options.audit,
    clock: options.clock,
    allowlist: options.allowlist,
    maxSnapshotChars: options.maxSnapshotChars,
    ...(rateLimit === null ? {} : { rateLimit }),
  });
}

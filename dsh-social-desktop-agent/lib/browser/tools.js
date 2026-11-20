/**
 * dsh-social-desktop-agent / lib/browser/tools.js
 *
 * ブラウザ層のツール実装（DI 前提・純 ESM・新規依存ゼロ）。
 *
 * 設計の要点
 * ----------
 * 1) すべて DI。`createBrowseTools({ driver, policy, audit, confirm, clock })`。
 *    driver は契約（lib/browser/driver.js）、policy は共有契約 `check({scope,kind,target})`。
 *    このファイルは lib/core を import しない（他ワーカーの実装と疎結合に保つ）。
 *
 * 2) 判定は 4 段。上から順に評価し、拒否されたらドライバを触らない。
 *      (a) 人間介入ラッチ（一度でもログイン/2FA/チェックポイント/CAPTCHA を検出したら以降は全部停止）
 *      (b) 恒久拒否（social.write はポリシーの許可如何に関わらず常に拒否）
 *      (c) policy.check（スコープ / ドメイン allowlist / kill switch）
 *      (d) レート制御（最小間隔・1 セッションの操作上限）
 *
 * 3) 資格情報は受け取らない。
 *    - パスワード入力ツールは存在しない
 *    - パスワード / ワンタイムコード / ユーザー名らしき欄は type でも click でも拒否する
 *    - Cookie の永続化は行わない（この層は Cookie を一切読まない・書かない）
 *    - ログインは「人間がブラウザ UI で行う」前提。ログイン画面を検出したら停止して人間に渡す
 *
 * 4) 通信は driver の内側だけ。tools 層自身は fetch も WebSocket も使わない。
 */

import {
  DEFAULT_ALLOWED_DOMAINS,
  DEFAULT_RATE_LIMIT,
  SOCIAL_WRITE_REASON,
  detectCredentialInput,
  detectAuthSurface,
  detectHumanIntervention,
  detectSocialWrite,
  isHostAllowed,
  parseTargetUrl,
  renderSnapshot,
} from './policies.js';
import {
  DriverError,
  assertDriver,
  assertPolicy,
  assertRef,
  normalizePageInfo,
  normalizeSnapshotResult,
} from './driver.js';

/** この層が公開するツール名（index.js 側の登録に使う）。 */
export const BROWSE_TOOL_NAMES = Object.freeze([
  'browse_open',
  'browse_snapshot',
  'browse_click',
  'browse_type',
  'browse_scroll',
  'browse_screenshot',
  'browse_close',
]);

/**
 * index.js / cordis.patch.yml 側がツール登録に使える簡易スキーマ。
 * （parameters は JSON Schema 風の最小表現。実バリデーションは各ツールが行う）
 */
export const BROWSE_TOOL_DEFINITIONS = Object.freeze([
  {
    name: 'browse_open',
    description: 'allowlist 内の URL を開く（browse.read）。Instagram の URL のみ既定で許可。',
    parameters: { url: { type: 'string', description: 'http(s) の URL' } },
  },
  {
    name: 'browse_snapshot',
    description: '現在ページの accessibility 風スナップショット（[eN] role "name"）を返す（browse.read）。',
    parameters: { maxNodes: { type: 'number', description: '取得するノード上限（既定 200）' } },
  },
  {
    name: 'browse_click',
    description: 'スナップショットの ref をクリック（browse.interact）。ソーシャル書き込みは恒久拒否。',
    parameters: { ref: { type: 'string' }, purpose: { type: 'string' } },
  },
  {
    name: 'browse_type',
    description: 'ref に文字を入力（browse.interact）。パスワード等の資格情報欄は拒否。',
    parameters: { ref: { type: 'string' }, text: { type: 'string' }, submit: { type: 'boolean' } },
  },
  {
    name: 'browse_scroll',
    description: 'スクロール（browse.read）。',
    parameters: { deltaY: { type: 'number' }, ref: { type: 'string' } },
  },
  {
    name: 'browse_screenshot',
    description: '現在ページのスクリーンショット（browse.read）。',
    parameters: { fullPage: { type: 'boolean' } },
  },
  {
    name: 'browse_close',
    description: 'このセッションのブラウザタブを閉じる（人間介入ラッチも解除）。',
    parameters: {},
  },
]);

/* ------------------------------------------------------------------ */
/* ユーティリティ                                                      */
/* ------------------------------------------------------------------ */

function normalizeClock(clock) {
  if (typeof clock === 'function') return () => Number(clock());
  if (clock && typeof clock.now === 'function') return () => Number(clock.now());
  return () => Date.now();
}

function toInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/* ------------------------------------------------------------------ */
/* createBrowseTools                                                   */
/* ------------------------------------------------------------------ */

/**
 * ブラウザツール一式を生成する。
 *
 * @param {object} options
 * @param {object} options.driver   ブラウザドライバ（lib/browser/driver.js の契約）
 * @param {object} options.policy   `check({scope,kind,target}) -> {ok:true}|{ok:false,code,message}`
 * @param {object|Function} [options.audit] 監査ログ。`audit.record(entry)` か `audit(entry)`
 * @param {Function} [options.confirm]      確認トークン用（ブラウザ層では未使用。受け取るだけ）
 * @param {Function} [options.clock]        現在時刻（ms）。テストで時間を進めるために注入する
 * @param {string[]} [options.allowlist]    追加・差し替えのドメイン allowlist
 * @param {{minIntervalMs?:number,maxOps?:number}} [options.rateLimit]
 * @param {number} [options.maxSnapshotChars]
 */
export function createBrowseTools(options = {}) {
  const driver = options.driver;
  const policy = options.policy;
  assertDriver(driver);
  assertPolicy(policy);

  const audit = options.audit ?? null;
  const clock = normalizeClock(options.clock);
  const allowlist =
    Array.isArray(options.allowlist) && options.allowlist.length > 0
      ? options.allowlist.slice()
      : DEFAULT_ALLOWED_DOMAINS.slice();
  const rateLimitConfig = { ...DEFAULT_RATE_LIMIT, ...(options.rateLimit ?? {}) };
  const minIntervalMs = Math.max(0, Number(rateLimitConfig.minIntervalMs) || 0);
  const maxOps =
    Number(rateLimitConfig.maxOps) > 0 ? Number(rateLimitConfig.maxOps) : DEFAULT_RATE_LIMIT.maxOps;
  const maxSnapshotChars =
    Number(options.maxSnapshotChars) > 0 ? Number(options.maxSnapshotChars) : 8000;

  const state = {
    ops: 0,
    lastOpAt: null,
    closed: false,
    humanIntervention: null,
    lastKnownUrl: null,
    lastSnapshot: null,
    startedAt: clock(),
  };

  /* --- 監査 ------------------------------------------------------------ */

  function log(entry) {
    const record = { at: clock(), ...entry };
    try {
      if (typeof audit === 'function') audit(record);
      else if (audit && typeof audit.record === 'function') audit.record(record);
    } catch {
      // 監査ログの失敗でブラウザ操作を壊さない（記録は best-effort）
    }
    return record;
  }

  /* --- 拒否結果 -------------------------------------------------------- */

  function humanStop(tool) {
    const h = state.humanIntervention;
    return {
      ok: false,
      tool,
      code: 'NEEDS_HUMAN',
      needsHuman: true,
      kind: h.kind,
      reason: h.reason,
      url: h.url ?? state.lastKnownUrl ?? null,
      stopped: true,
    };
  }

  function socialDenied(tool, target) {
    const message = `${SOCIAL_WRITE_REASON}（拒否した対象: ${String(target ?? 'unknown').slice(0, 120)}）`;
    log({
      tool,
      scope: 'browse.interact',
      kind: 'social.write',
      target: target ?? null,
      decision: 'deny',
      code: 'TARGET_DENIED',
      message,
    });
    return { ok: false, tool, kind: 'social.write', code: 'TARGET_DENIED', message, permanent: true };
  }

  function credentialDenied(tool, ref, reason) {
    log({
      tool,
      scope: 'browse.interact',
      kind: 'credential',
      target: ref ?? null,
      decision: 'deny',
      code: 'TARGET_DENIED',
      message: reason,
    });
    return {
      ok: false,
      tool,
      code: 'TARGET_DENIED',
      needsHuman: true,
      reason,
      message: reason,
      detail: { ref: ref ?? null },
    };
  }

  /* --- レート制御 ------------------------------------------------------ */

  function rateFailure(tool) {
    if (state.ops >= maxOps) {
      return {
        ok: false,
        tool,
        code: 'RATE_LIMITED',
        message: `1 セッションの操作上限（${maxOps} 回）に達しました`,
        ops: state.ops,
        maxOps,
      };
    }
    if (state.lastOpAt != null) {
      const elapsed = clock() - state.lastOpAt;
      if (elapsed < minIntervalMs) {
        return {
          ok: false,
          tool,
          code: 'RATE_LIMITED',
          message: `操作間隔が短すぎます（最小 ${minIntervalMs}ms / 経過 ${Math.max(0, elapsed)}ms）`,
          retryAfterMs: minIntervalMs - elapsed,
          minIntervalMs,
        };
      }
    }
    return null;
  }

  function consumeOp() {
    state.ops += 1;
    state.lastOpAt = clock();
  }

  /* --- ポリシー -------------------------------------------------------- */

  async function policyCheck(action) {
    const normalized = {
      scope: action.scope,
      kind: action.kind ?? action.scope,
      target: action.target ?? null,
    };
    let decision;
    try {
      decision = await policy.check(normalized);
    } catch (e) {
      return {
        ok: false,
        action: normalized,
        code: 'POLICY_ERROR',
        message: `ポリシー評価に失敗しました: ${String(e?.message ?? e)}`,
      };
    }
    if (decision && decision.ok === true) return { ok: true, action: normalized };
    return {
      ok: false,
      action: normalized,
      code: decision?.code ?? 'SCOPE_DENIED',
      message: decision?.message ?? 'ポリシーにより拒否されました',
    };
  }

  /**
   * 操作前の関門。null を返したら続行、オブジェクトを返したらそれを呼び出し元へ返す。
   */
  async function preflight(tool, action) {
    if (state.humanIntervention) return humanStop(tool);
    if (state.closed) {
      return {
        ok: false,
        tool,
        code: 'CLOSED',
        message: 'ブラウザセッションは閉じられています。browse_open で開き直してください。',
      };
    }
    // (b) 恒久拒否: ポリシーが許可していても social.write は通さない
    if (action.kind === 'social.write') return socialDenied(tool, action.target);

    // (c) ポリシー（スコープ / ドメイン / kill switch）
    const decision = await policyCheck(action);
    if (!decision.ok) {
      log({
        tool,
        ...decision.action,
        decision: 'deny',
        code: decision.code,
        message: decision.message,
      });
      return { ok: false, tool, code: decision.code, message: decision.message };
    }

    // (d) レート制御
    const limited = rateFailure(tool);
    if (limited) {
      log({ tool, ...decision.action, decision: 'deny', code: 'RATE_LIMITED', message: limited.message });
      return limited;
    }

    consumeOp();
    return null;
  }

  /* --- 現在ページ / ノード --------------------------------------------- */

  /**
   * ラッチ済み / クローズ済みの早期チェック。
   * resolveNode() は driver.describe() を呼ぶので、その前にここで止める
   * （人間に渡した後はページ読み取りすらしない、という不変条件を守る）。
   */
  function earlyStop(tool) {
    if (state.humanIntervention) return humanStop(tool);
    if (state.closed) {
      return {
        ok: false,
        tool,
        code: 'CLOSED',
        message: 'ブラウザセッションは閉じられています。browse_open で開き直してください。',
      };
    }
    return null;
  }

  function requireAllowedPage(tool) {
    const url = state.lastKnownUrl;
    if (!url) {
      return {
        ok: false,
        tool,
        code: 'TARGET_DENIED',
        message: 'ページがまだ開かれていません。先に browse_open を呼んでください。',
      };
    }
    const parsed = parseTargetUrl(url);
    if (!parsed.ok) return { ok: false, tool, code: parsed.code, message: parsed.message };
    if (!isHostAllowed(parsed.host, allowlist)) {
      return {
        ok: false,
        tool,
        code: 'TARGET_DENIED',
        message: `現在のページが許可されていないドメインです: ${parsed.host}（自動操作を停止します）`,
      };
    }
    return { ok: true, url: parsed.url, host: parsed.host };
  }

  async function resolveNode(ref) {
    if (typeof driver.describe === 'function') {
      try {
        const node = await driver.describe(ref);
        if (node && typeof node === 'object') return node;
      } catch {
        // describe 未対応/失敗時は最後のスナップショットから引く
      }
    }
    const nodes = state.lastSnapshot?.nodes ?? [];
    return nodes.find((n) => n.ref === ref) ?? null;
  }

  /* --- ドライバ呼び出し ------------------------------------------------ */

  async function callDriver(tool, fn) {
    try {
      return { ok: true, value: await fn() };
    } catch (e) {
      const code = e instanceof DriverError ? e.code : e?.code ?? 'DRIVER_ERROR';
      const message = String(e?.message ?? e);
      log({ tool, decision: 'error', code, message });
      return { ok: false, err: { ok: false, tool, code, message, driverCode: e?.code ?? null } };
    }
  }

  /* --- 操作後: ページ観測 + 人間介入検出 ------------------------------- */

  async function afterOp(tool, result, fallback = {}) {
    let page = {
      url: String(fallback.url ?? ''),
      title: String(fallback.title ?? ''),
      text: typeof fallback.text === 'string' ? fallback.text : '',
    };

    if (!page.text && typeof driver.getPage === 'function') {
      try {
        page = normalizePageInfo(await driver.getPage(), page);
      } catch {
        // 観測に失敗しても操作結果は返す（介入検出だけ諦める）
      }
    }

    if (page.url) state.lastKnownUrl = page.url;

    const hit = detectHumanIntervention(page);
    if (!hit.needed) {
      return { ...result, url: page.url || result.url, title: page.title || result.title };
    }

    // ラッチ: 以後の自動操作はすべて NEEDS_HUMAN で止まる
    state.humanIntervention = {
      kind: hit.kind,
      reason: hit.reason,
      at: clock(),
      tool,
      url: page.url || state.lastKnownUrl,
    };
    log({
      tool,
      scope: 'browse.read',
      kind: 'human.intervention',
      target: page.url,
      decision: 'stop',
      code: 'NEEDS_HUMAN',
      message: hit.reason,
    });

    return {
      ok: false,
      tool,
      code: 'NEEDS_HUMAN',
      needsHuman: true,
      kind: hit.kind,
      reason: hit.reason,
      url: page.url,
      title: page.title,
      stopped: true,
    };
  }

  /* ------------------------------------------------------------------ */
  /* ツール群                                                            */
  /* ------------------------------------------------------------------ */

  async function browse_open(args = {}) {
    const raw = typeof args === 'string' ? args : args?.url;
    const parsed = parseTargetUrl(raw);
    if (!parsed.ok) {
      return { ok: false, tool: 'browse_open', code: parsed.code, message: parsed.message };
    }
    if (!isHostAllowed(parsed.host, allowlist)) {
      log({
        tool: 'browse_open',
        scope: 'browse.read',
        kind: 'browse.read',
        target: parsed.url,
        decision: 'deny',
        code: 'TARGET_DENIED',
        message: 'allowlist 外のドメイン',
      });
      return {
        ok: false,
        tool: 'browse_open',
        code: 'TARGET_DENIED',
        message: `許可されていないドメインです: ${parsed.host}（許可: ${allowlist.join(', ')}）`,
      };
    }

    // close 済みでも open で復帰できるようにする（人間介入ラッチは解除しない）
    if (state.closed) state.closed = false;

    const guard = await preflight('browse_open', {
      scope: 'browse.read',
      kind: 'browse.read',
      target: parsed.url,
    });
    if (guard) return guard;

    const res = await callDriver('browse_open', () => driver.open(parsed.url));
    if (!res.ok) return res.err;

    const page = normalizePageInfo(res.value, { url: parsed.url, title: '' });
    state.lastKnownUrl = page.url || parsed.url;
    log({
      tool: 'browse_open',
      scope: 'browse.read',
      kind: 'browse.read',
      target: state.lastKnownUrl,
      decision: 'allow',
    });

    return afterOp(
      'browse_open',
      { ok: true, tool: 'browse_open', url: state.lastKnownUrl, title: page.title },
      { url: state.lastKnownUrl, title: page.title },
    );
  }

  async function browse_snapshot(args = {}) {
    const page = requireAllowedPage('browse_snapshot');
    if (!page.ok) return page;

    const guard = await preflight('browse_snapshot', {
      scope: 'browse.read',
      kind: 'browse.read',
      target: page.url,
    });
    if (guard) return guard;

    const maxNodes = toInt(args?.maxNodes, 1, 500, 200);
    const res = await callDriver('browse_snapshot', () => driver.snapshot({ maxNodes }));
    if (!res.ok) return res.err;

    let snap;
    try {
      snap = normalizeSnapshotResult(res.value);
    } catch (e) {
      return { ok: false, tool: 'browse_snapshot', code: e?.code ?? 'DRIVER_ERROR', message: String(e?.message ?? e) };
    }

    state.lastSnapshot = {
      url: snap.url,
      title: snap.title,
      nodes: snap.nodes,
      snapId: snap.snapId ?? null,
      at: clock(),
    };
    if (snap.url) state.lastKnownUrl = snap.url;

    const text = renderSnapshot({
      url: snap.url,
      title: snap.title,
      nodes: snap.nodes,
      maxChars: maxSnapshotChars,
    });
    log({
      tool: 'browse_snapshot',
      scope: 'browse.read',
      kind: 'browse.read',
      target: snap.url,
      decision: 'allow',
      detail: { nodes: snap.nodes.length },
    });

    return afterOp(
      'browse_snapshot',
      {
        ok: true,
        tool: 'browse_snapshot',
        url: snap.url || page.url,
        title: snap.title,
        count: snap.nodes.length,
        snapshot: text,
      },
      { url: snap.url || page.url, title: snap.title, text: snap.text },
    );
  }

  async function browse_click(args = {}) {
    let ref;
    try {
      ref = assertRef(args?.ref);
    } catch (e) {
      return { ok: false, tool: 'browse_click', code: e?.code ?? 'INVALID_REF', message: String(e?.message ?? e) };
    }

    const halted = earlyStop('browse_click');
    if (halted) return halted;

    const node = await resolveNode(ref);

    // ソーシャル操作の分類:
    //   social.engage（いいね / 保存 / フォロー）… social.write スコープがある場合だけ通る
    //   social.write（投稿 / DM / コメント / 削除 等）… 恒久拒否
    const social = detectSocialWrite({ purpose: args?.purpose, node });
    if (social.isWrite && social.kind !== 'social.engage') {
      return socialDenied('browse_click', node?.name ?? ref);
    }

    if (node) {
      const cred = detectCredentialInput({ node });
      if (cred.isCredential) return credentialDenied('browse_click', ref, cred.reason);
    }

    const page = requireAllowedPage('browse_click');
    if (!page.ok) return page;

    const engage = social.isWrite && social.kind === 'social.engage';
    const actionScope = engage ? 'social.write' : 'browse.interact';
    const actionKind = engage ? 'social.engage' : 'browse.interact';

    const guard = await preflight('browse_click', {
      scope: actionScope,
      kind: actionKind,
      target: page.url,
    });
    if (guard) return guard;

    const res = await callDriver('browse_click', () =>
      driver.click(ref, { snapId: state.lastSnapshot?.snapId ?? undefined }),
    );
    if (!res.ok) return res.err;

    log({
      tool: 'browse_click',
      scope: actionScope,
      kind: actionKind,
      target: page.url,
      decision: 'allow',
      detail: { ref, role: node?.role ?? null, name: node?.name ?? null, action: social.action ?? null },
    });

    const out = {
      ok: true,
      tool: 'browse_click',
      ref,
      role: node?.role ?? null,
      name: node?.name ?? null,
      url: page.url,
    };
    return afterOp('browse_click', out, { url: page.url, title: state.lastSnapshot?.title ?? '' });
  }

  async function browse_type(args = {}) {
    let ref;
    try {
      ref = assertRef(args?.ref);
    } catch (e) {
      return { ok: false, tool: 'browse_type', code: e?.code ?? 'INVALID_REF', message: String(e?.message ?? e) };
    }

    const text = args?.text;
    if (typeof text !== 'string') {
      return { ok: false, tool: 'browse_type', code: 'INVALID_ARGS', message: 'text は文字列で指定してください' };
    }
    if (text.length > 2000) {
      return { ok: false, tool: 'browse_type', code: 'INVALID_ARGS', message: '一度に入力できるのは 2000 文字までです' };
    }
    const submit = args?.submit === true;

    const halted = earlyStop('browse_type');
    if (halted) return halted;

    const node = await resolveNode(ref);

    const social = detectSocialWrite({ purpose: args?.purpose, node });
    if (social.isWrite) return socialDenied('browse_type', node?.name ?? ref);

    const cred = detectCredentialInput({ node, type: node?.type });
    if (cred.isCredential) return credentialDenied('browse_type', ref, cred.reason);

    // ラベルが空の入力欄でも、ページが認証面なら入力しない。
    // （実測: Instagram のログイン画面はラベルなし textbox + password 欄で、
    //   ラベルだけを見る判定をすり抜けた）
    const auth = detectAuthSurface({
      url: state.lastSnapshot?.url ?? '',
      nodes: state.lastSnapshot?.nodes ?? [],
    });
    if (auth.isAuth) return credentialDenied('browse_type', ref, auth.reason);

    const page = requireAllowedPage('browse_type');
    if (!page.ok) return page;

    const guard = await preflight('browse_type', {
      scope: 'browse.interact',
      kind: 'browse.interact',
      target: page.url,
    });
    if (guard) return guard;

    const res = await callDriver('browse_type', () =>
      driver.type(ref, text, { submit, snapId: state.lastSnapshot?.snapId ?? undefined }),
    );
    if (!res.ok) return res.err;

    log({
      tool: 'browse_type',
      scope: 'browse.interact',
      kind: 'browse.interact',
      target: page.url,
      decision: 'allow',
      detail: { ref, chars: text.length, submit },
    });

    // 入力内容そのものは返さない（資格情報が紛れ込んだ場合の漏洩面を減らす）
    const out = {
      ok: true,
      tool: 'browse_type',
      ref,
      chars: text.length,
      submitted: submit,
      url: page.url,
    };
    return afterOp('browse_type', out, { url: page.url });
  }

  async function browse_scroll(args = {}) {
    const page = requireAllowedPage('browse_scroll');
    if (!page.ok) return page;

    const guard = await preflight('browse_scroll', {
      scope: 'browse.read',
      kind: 'browse.read',
      target: page.url,
    });
    if (guard) return guard;

    const deltaY = toInt(args?.deltaY, -5000, 5000, 600);
    const ref = typeof args?.ref === 'string' && args.ref.trim() ? args.ref.trim() : null;
    const res = await callDriver('browse_scroll', () =>
      ref ? driver.scroll({ ref, deltaY }) : driver.scroll({ deltaY }),
    );
    if (!res.ok) return res.err;

    log({
      tool: 'browse_scroll',
      scope: 'browse.read',
      kind: 'browse.read',
      target: page.url,
      decision: 'allow',
      detail: { deltaY, ref },
    });

    const out = {
      ok: true,
      tool: 'browse_scroll',
      deltaY,
      ...(ref ? { ref } : {}),
      y: Number.isFinite(res.value?.y) ? res.value.y : null,
      url: page.url,
    };
    return afterOp('browse_scroll', out, { url: page.url });
  }

  async function browse_screenshot(args = {}) {
    const page = requireAllowedPage('browse_screenshot');
    if (!page.ok) return page;

    const guard = await preflight('browse_screenshot', {
      scope: 'browse.read',
      kind: 'browse.read',
      target: page.url,
    });
    if (guard) return guard;

    const fullPage = args?.fullPage === true;
    const res = await callDriver('browse_screenshot', () => driver.screenshot({ fullPage }));
    if (!res.ok) return res.err;

    log({
      tool: 'browse_screenshot',
      scope: 'browse.read',
      kind: 'browse.read',
      target: page.url,
      decision: 'allow',
      detail: { fullPage },
    });

    const shot = res.value ?? {};
    const dataUrl = typeof shot.dataUrl === 'string' ? shot.dataUrl : null;
    return {
      ok: true,
      tool: 'browse_screenshot',
      mimeType: String(shot.mimeType ?? 'image/png'),
      dataUrl,
      bytes: dataUrl ? dataUrl.length : 0,
      fullPage,
      url: page.url,
    };
  }

  async function browse_close() {
    if (state.closed) return { ok: true, tool: 'browse_close', alreadyClosed: true };

    // close は「止める」方向の操作なので、人間介入ラッチもレート制限も越えられる。
    // ただしスコープ（browse.read）と kill switch は通す。
    const decision = await policyCheck({ scope: 'browse.read', kind: 'browse.read', target: state.lastKnownUrl ?? '' });
    if (!decision.ok) {
      log({ tool: 'browse_close', ...decision.action, decision: 'deny', code: decision.code, message: decision.message });
      return { ok: false, tool: 'browse_close', code: decision.code, message: decision.message };
    }

    const res = await callDriver('browse_close', () => driver.close());
    if (!res.ok) return res.err;

    state.closed = true;
    state.lastSnapshot = null;
    state.humanIntervention = null;
    log({
      tool: 'browse_close',
      scope: 'browse.read',
      kind: 'browse.read',
      target: decision.action.target,
      decision: 'allow',
    });
    return { ok: true, tool: 'browse_close' };
  }

  /* ------------------------------------------------------------------ */
  /* API                                                                 */
  /* ------------------------------------------------------------------ */

  const api = {
    browse_open,
    browse_snapshot,
    browse_click,
    browse_type,
    browse_scroll,
    browse_screenshot,
    browse_close,
  };

  // 登録側は Object.keys() で 7 ツールだけを見る。補助 API は enumerable: false。
  Object.defineProperty(api, 'toolNames', { value: BROWSE_TOOL_NAMES, enumerable: false });
  Object.defineProperty(api, 'definitions', { value: BROWSE_TOOL_DEFINITIONS, enumerable: false });
  Object.defineProperty(api, 'state', { get: () => state, enumerable: false });
  Object.defineProperty(api, 'control', {
    value: {
      status: () => ({
        ops: state.ops,
        maxOps,
        minIntervalMs,
        closed: state.closed,
        humanIntervention: state.humanIntervention ? { ...state.humanIntervention } : null,
        url: state.lastKnownUrl,
        allowedDomains: allowlist.slice(),
      }),
      reset: () => {
        state.ops = 0;
        state.lastOpAt = null;
        state.closed = false;
        state.humanIntervention = null;
        state.lastSnapshot = null;
        state.lastKnownUrl = null;
      },
    },
    enumerable: false,
  });

  return api;
}

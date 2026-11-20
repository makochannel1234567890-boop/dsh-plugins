/**
 * dsh-social-desktop-agent / lib/browser/policies.js
 *
 * ブラウザ層の「純粋判定」ロジック。
 * 副作用なし・I/O なし・ネットワークなし・資格情報なし。単体テストはここを直接叩けば足りる。
 *
 * 判定の柱は 4 つ:
 *   1. ドメイン allowlist（既定は Instagram 系のみ。`*.example.com` 形式のワイルドカード可）
 *   2. ソーシャル書き込みの恒久拒否（いいね / フォロー / DM 送信 / 投稿 / コメント / シェア / 保存）
 *   3. 人間介入の検出（ログイン要求 / 2FA / チェックポイント / CAPTCHA）
 *   4. 資格情報入力欄の検出（パスワード・ワンタイムコード・ユーザー名などは触らない）
 *
 * ここは「判定」だけを行い、「止める」のは tools.js の責務。
 * そのため、どの関数も例外を投げず判定オブジェクトを返す（呼び出し側が一貫して扱えるように）。
 */

/**
 * 既定の許可ドメイン。
 * `*.cdninstagram.com` は Instagram の画像/動画 CDN（scontent.cdninstagram.com など）。
 * `*.fbcdn.net` は Instagram が Meta の CDN を使う場合の保険。
 */
export const DEFAULT_ALLOWED_DOMAINS = Object.freeze([
  'instagram.com',
  'www.instagram.com',
  'i.instagram.com',
  '*.cdninstagram.com',
  '*.fbcdn.net',
]);

/**
 * 既定のレート制御。tools.js が同じ既定値を自前で持つ（DI で上書き可能）。
 * - minIntervalMs: 連続操作の最小間隔
 * - maxOps: 1 セッションの操作上限
 */
export const DEFAULT_RATE_LIMIT = Object.freeze({ minIntervalMs: 1500, maxOps: 200 });

/** ソーシャル書き込み拒否の理由。要件上この日本語句を必ず含める。 */
export const SOCIAL_WRITE_REASON =
  'ソーシャル書き込みはこのプラグインでは提供しない（いいね / フォロー / DM 送信 / 投稿 / コメント / シェア / 保存は恒久拒否）';

/* ------------------------------------------------------------------ */
/* URL / ドメイン                                                      */
/* ------------------------------------------------------------------ */

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

function targetDenied(message) {
  return { ok: false, code: 'TARGET_DENIED', message };
}

/**
 * 開いてよい URL かを検証して正規化する。
 *
 * 方針:
 *   - スキーム無し（`www.instagram.com/x`）は https を補う
 *   - http / https 以外（javascript:, data:, file:, chrome:, ftp: …）は拒否
 *   - `user:pass@host` 形式は拒否（資格情報を URL に載せない）
 */
export function parseTargetUrl(raw) {
  if (raw == null) return targetDenied('URL が指定されていません');
  const text = String(raw).trim();
  if (!text) return targetDenied('URL が空です');

  const candidate = SCHEME_RE.test(text) ? text : `https://${text}`;
  let url;
  try {
    url = new URL(candidate);
  } catch {
    return targetDenied(`URL として解釈できません: ${text.slice(0, 200)}`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return targetDenied(`HTTP(S) 以外の URL は開けません: ${url.protocol}`);
  }
  if (url.username || url.password) {
    return targetDenied('URL に資格情報（user:pass@）を含められません');
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!host) return targetDenied('ホスト名がありません');

  return { ok: true, url: url.toString(), host, protocol: url.protocol.slice(0, -1) };
}

/**
 * 1 つのドメインパターンとホストの照合。
 * `*.example.com` は example.com 自身と全サブドメインに一致する。
 * それ以外は完全一致のみ（`instagram.com.evil.com` を通さないため）。
 */
export function matchDomainPattern(host, pattern) {
  if (!host || !pattern) return false;
  const h = String(host).toLowerCase().replace(/\.$/, '');
  const p = String(pattern).toLowerCase().trim().replace(/\.$/, '');
  if (!p) return false;
  if (p === '*') return true;
  if (p.startsWith('*.')) {
    const base = p.slice(2);
    if (!base) return false;
    return h === base || h.endsWith(`.${base}`);
  }
  return h === p;
}

/** allowlist に含まれるホストか。 */
export function isHostAllowed(host, allowlist = DEFAULT_ALLOWED_DOMAINS) {
  if (!host) return false;
  const list = Array.isArray(allowlist) ? allowlist : [];
  for (const pattern of list) {
    if (typeof pattern !== 'string' || !pattern.trim()) continue;
    if (matchDomainPattern(host, pattern)) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* ソーシャル書き込み                                                  */
/* ------------------------------------------------------------------ */

/**
 * 完全一致で書き込みとみなすラベル（正規化後: 小文字・末尾記号除去）。
 * 「投稿」一覧へのリンクのように副詞的でない語は、完全一致のみで判定する
 * （誤爆を避けつつ、その手のボタンは確実に止める）。
 */
const SOCIAL_WRITE_EXACT = Object.freeze(
  new Set([
    'like', 'unlike', 'follow', 'unfollow', 'following', 'follow back',
    'comment', 'reply', 'post', 'share', 'save', 'send', 'bookmark', 'story',
    'いいね', 'いいね！', 'フォロー', 'フォロー中', 'フォローする',
    'コメント', '返信', '投稿', 'シェア', '保存', '送信', 'ストーリー',
  ]),
);

/**
 * 部分一致で書き込みとみなすパターン（動作を表す動詞のみ）。
 * 注意: `/\bpost\b/` は入れない。「Photo by …」のような閲覧リンクを巻き込むため。
 */
const SOCIAL_WRITE_PATTERNS = Object.freeze([
  /\blike\b/i,
  /\bunlike\b/i,
  /\bfollow\b/i,
  /\bfollowing\b/i,
  /\bunfollow\b/i,
  /\bfollow back\b/i,
  /\bcomment(s|ed|ing)?\b/i,
  /\breply\b/i,
  /\bshare\b/i,
  /\bsend\b/i,
  /\bbookmark\b/i,
  /いいね/,
  /フォロー/,
  /コメントする/,
  /返信する/,
  /シェアする/,
  /送信する/,
  /投稿する/,
  /新規投稿/,
]);

/**
 * エンゲージ操作（いいね / 保存 / フォロー系）。
 * `social.write` スコープを明示的に有効化した場合だけ許可される。
 * 投稿・DM・コメント・削除・通報はここに入れない（恒久拒否のまま）。
 */
const ENGAGE_EXACT = Object.freeze(
  new Set([
    'like',
    'unlike',
    'いいね',
    'いいね！',
    'いいねする',
    'save',
    'saved',
    'unsave',
    '保存',
    '保存する',
    'follow',
    'following',
    'unfollow',
    'フォロー',
    'フォロー中',
    'フォローする',
    'フォローをやめる',
  ]),
);

/** ラベルがエンゲージ操作かを判定する。 */
export function classifyEngageLabel(label) {
  if (label == null) return null;
  const raw = String(label).replace(/\s+/g, ' ').trim();
  if (!raw) return null;
  const stripped = raw.toLowerCase().replace(/[!.。,、…：:\s]+$/u, '');
  return ENGAGE_EXACT.has(stripped) ? stripped : null;
}

/** ラベル 1 つを書き込み判定する。書き込みなら理由文字列、そうでなければ null。 */
export function classifySocialLabel(label) {
  if (label == null) return null;
  const raw = String(label).replace(/\s+/g, ' ').trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();
  const stripped = lower.replace(/[!.。,、…：:\s]+$/u, '');
  if (SOCIAL_WRITE_EXACT.has(lower) || SOCIAL_WRITE_EXACT.has(stripped)) return `exact:${stripped}`;
  for (const re of SOCIAL_WRITE_PATTERNS) {
    if (re.test(raw)) return `pattern:${re.source}`;
  }
  return null;
}

/**
 * 操作がソーシャル書き込みかどうかを判定する。
 *
 * @param {object} input
 * @param {string} [input.purpose] 呼び出し側が明示する意図（'social.write' なら即拒否）
 * @param {object} [input.node] スナップショットのノード（name / role / type）
 * @param {string} [input.label] 追加ラベル
 * @returns {{ isWrite: boolean, matched: string|null, reason: string|null }}
 */
export function detectSocialWrite(input = {}) {
  const purpose = input.purpose == null ? '' : String(input.purpose).trim().toLowerCase();
  if (purpose === 'social.write' || purpose === 'social_write' || purpose === 'write') {
    return { isWrite: true, kind: 'social.write', action: null, matched: 'purpose', reason: SOCIAL_WRITE_REASON };
  }

  const labels = [];
  if (input.node && typeof input.node === 'object') {
    if (input.node.name) labels.push(input.node.name);
    if (input.node.label) labels.push(input.node.label);
  }
  if (input.label) labels.push(input.label);

  for (const label of labels) {
    // いいね / 保存 / フォロー系は「エンゲージ」: social.write スコープがある場合だけ通る。
    const engage = classifyEngageLabel(label);
    if (engage) {
      return {
        isWrite: true,
        kind: 'social.engage',
        action: engage,
        matched: `engage:${engage}`,
        reason: `ソーシャル操作「${engage}」を検出しました。social.write スコープが有効な場合のみ実行します。`,
      };
    }
    const matched = classifySocialLabel(label);
    if (matched) {
      return {
        isWrite: true,
        kind: 'social.write',
        action: null,
        matched,
        reason: `${SOCIAL_WRITE_REASON}（検出したラベル: ${String(label).replace(/\s+/g, ' ').trim().slice(0, 80)}）`,
      };
    }
  }
  return { isWrite: false, kind: null, action: null, matched: null, reason: null };
}

/* ------------------------------------------------------------------ */
/* 資格情報入力欄                                                      */
/* ------------------------------------------------------------------ */

const CREDENTIAL_PATTERNS = Object.freeze([
  /password/i,
  /パスワード/,
  /passcode/i,
  /passphrase/i,
  /one[- ]?time (code|password)/i,
  /\botp\b/i,
  /verification code/i,
  /security code/i,
  /認証コード/,
  /確認コード/,
  /ワンタイム/,
  /username/i,
  /ユーザー名/,
  /\be-?mail\b/i,
  /メールアドレス/i,
  /phone number/i,
  /電話番号/,
]);

/**
 * 資格情報（またはその入力欄）を検出する。
 * requirement: パスワード入力ツールは作らない。ログインは人間がブラウザ UI で行う。
 *
 * @param {object} input
 * @param {object} [input.node] スナップショットのノード
 * @param {string} [input.type] input の type（'password' など）
 * @param {string} [input.label] 追加ラベル
 */
export function detectCredentialInput(input = {}) {
  const node = input.node && typeof input.node === 'object' ? input.node : null;
  const type = String(input.type ?? node?.type ?? '').toLowerCase();
  if (type === 'password') {
    return {
      isCredential: true,
      reason: 'パスワード欄への入力は受け付けません。ログインは人間がブラウザ UI で行ってください。',
    };
  }
  const labels = [input.label, node?.name, node?.placeholder]
    .filter((v) => v != null && String(v).trim() !== '')
    .map((v) => String(v).replace(/\s+/g, ' ').trim());

  for (const label of labels) {
    for (const re of CREDENTIAL_PATTERNS) {
      if (re.test(label)) {
        return {
          isCredential: true,
          reason: `資格情報らしき入力欄を検出しました（${label.slice(0, 60)}）。ログイン / 2FA は人間が行ってください。`,
        };
      }
    }
  }
  return { isCredential: false, reason: null };
}

/* ------------------------------------------------------------------ */
/* 人間介入（ログイン / 2FA / チェックポイント / CAPTCHA）              */
/* ------------------------------------------------------------------ */

const URL_RULES = Object.freeze([
  { kind: 'checkpoint', re: /\/(challenge|checkpoint)(\/|\?|#|$)/i, label: 'チェックポイント（本人確認）画面' },
  { kind: '2fa', re: /\/(two_factor|two-factor|2fa)(\/|\?|#|$)/i, label: '二要素認証（2FA）画面' },
  { kind: 'login', re: /\/(accounts\/)?(login|signin)(\/|\?|#|$)/i, label: 'ログイン画面' },
  { kind: 'captcha', re: /\/captcha(\/|\?|#|$)/i, label: 'CAPTCHA 画面' },
]);

const TEXT_RULES = Object.freeze([
  {
    kind: 'captcha',
    re: /captcha|recaptcha|hcaptcha|not a robot|ロボットではありません|verify you(?:'|’)?re human|verify you are human|人間であることを確認/i,
    label: 'CAPTCHA / ボット判定',
  },
  {
    kind: '2fa',
    re: /two[- ]factor|2要素認証|二段階認証|two-step verification|認証コード|確認コード|security code|enter the \d{1,2}[- ]digit|one[- ]time code|verification code/i,
    label: '二要素認証（2FA）',
  },
  {
    kind: 'checkpoint',
    re: /checkpoint|confirm your identity|suspicious activity|unusual activity|本人確認|不審なアクティビティ|アカウントの確認/i,
    label: 'チェックポイント（本人確認）',
  },
  {
    kind: 'login',
    re: /log ?in to continue|login required|ログインが必要|ログインしてください|enter your password|パスワードを入力|forgot password|パスワードをお忘れ/i,
    label: 'ログイン要求',
  },
]);

const MAX_TEXT_SCAN = 20000;

/**
 * 人間の介入が必要な状態を検出する。
 * URL パターンを優先し、次にタイトル + 本文テキストを見る。
 *
 * @returns {{ needed: boolean, kind: string|null, reason: string|null }}
 */
export function detectHumanIntervention(input = {}) {
  const url = typeof input.url === 'string' ? input.url : '';
  const title = typeof input.title === 'string' ? input.title : '';
  const text = typeof input.text === 'string' ? input.text.slice(0, MAX_TEXT_SCAN) : '';

  for (const rule of URL_RULES) {
    if (url && rule.re.test(url)) return humanHit(rule, url);
  }
  const haystack = `${title}\n${text}`;
  if (haystack.trim()) {
    for (const rule of TEXT_RULES) {
      if (rule.re.test(haystack)) return humanHit(rule, url);
    }
  }
  return { needed: false, kind: null, reason: null };
}

function humanHit(rule, url) {
  const where = url ? `（URL: ${url}）` : '';
  return {
    needed: true,
    kind: rule.kind,
    reason: `人間の介入が必要です: ${rule.label}${where}。自動操作を停止しました。ブラウザ UI で人間が対応してください。`,
  };
}

/* ------------------------------------------------------------------ */
/* 認証面（ログイン / パスワード欄があるページ）                        */
/* ------------------------------------------------------------------ */

/**
 * ページ全体が「認証面」かどうかを判定する。
 *
 * ラベル（name / placeholder）が空の入力欄でも、同じページに password 欄が
 * あればログイン画面とみなす。実測: Instagram のログイン画面は
 * `[e1] textbox`（ラベルなし）+ password 欄という形で、ラベルだけを見る
 * 従来の判定をすり抜けた。この関数はその穴を塞ぐための最終防衛線。
 *
 * @param {object} input
 * @param {string} [input.url]
 * @param {Array<object>} [input.nodes] スナップショットのノード
 * @param {string} [input.text] ページ本文
 * @returns {{ isAuth: boolean, reason: string|null }}
 */
export function detectAuthSurface(input = {}) {
  const url = typeof input.url === 'string' ? input.url : '';
  const nodes = Array.isArray(input.nodes) ? input.nodes : [];
  const text = typeof input.text === 'string' ? input.text.slice(0, MAX_TEXT_SCAN) : '';

  const passwordNode = nodes.find((node) => String(node?.type ?? '').toLowerCase() === 'password');
  if (passwordNode) {
    return {
      isAuth: true,
      reason:
        'ページにパスワード入力欄があります（ログイン / 2FA 画面）。このプラグインは資格情報を扱わないため入力しません。人間がブラウザ UI でログインしてください。',
    };
  }

  const haystack = `${url}\n${text}`;
  if (url) {
    for (const rule of URL_RULES) {
      if (rule.re.test(url)) {
        return {
          isAuth: true,
          reason: `${rule.label}を検出しました（URL: ${url}）。入力は人間がブラウザ UI で行ってください。`,
        };
      }
    }
  }
  if (haystack.trim()) {
    for (const rule of TEXT_RULES) {
      if ((rule.kind === 'login' || rule.kind === '2fa' || rule.kind === 'checkpoint') && rule.re.test(haystack)) {
        return {
          isAuth: true,
          reason: `ログイン要求を検出しました（${rule.label}）。入力は人間がブラウザ UI で行ってください。`,
        };
      }
    }
  }
  return { isAuth: false, reason: null };
}

/* ------------------------------------------------------------------ */
/* スナップショット整形                                                */
/* ------------------------------------------------------------------ */

function cleanLabel(value, max = 120) {
  return String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/"/g, "'")
    .trim()
    .slice(0, max);
}

/**
 * accessibility 風の番号付きテキストにする。
 *
 *   # page: https://www.instagram.com/ — Instagram
 *   # nodes: 2
 *   [e1] link "Explore" -> https://www.instagram.com/explore/
 *   [e2] button "Like"
 *
 * ref はそのまま `[eN]` として本文に出す（モデルはこれを読んで browse_click に渡す）。
 */
export function renderSnapshot({ url = '', title = '', nodes = [], maxChars = 8000 } = {}) {
  const list = Array.isArray(nodes) ? nodes : [];
  const lines = [];
  const head = url ? `# page: ${url}${title ? ` — ${title}` : ''}` : '# page: (none)';
  lines.push(head);
  lines.push(`# nodes: ${list.length}`);

  for (const node of list) {
    const ref = node?.ref == null ? '?' : String(node.ref);
    const role = String(node?.role ?? 'unknown');
    const name = cleanLabel(node?.name);
    let line = `[${ref}] ${role}`;
    if (name) line += ` "${name}"`;
    if (node?.value != null && String(node.value) !== '') line += ` value="${cleanLabel(node.value, 80)}"`;
    if (node?.url) line += ` -> ${cleanLabel(node.url, 300)}`;
    if (node?.disabled) line += ' [disabled]';
    lines.push(line);
  }

  let out = lines.join('\n');
  const cap = Number.isFinite(maxChars) && maxChars > 0 ? maxChars : 8000;
  if (out.length > cap) {
    const dropped = out.length - cap;
    out = `${out.slice(0, cap)}\n... (truncated: 残り ${dropped} 文字)`;
  }
  return out;
}

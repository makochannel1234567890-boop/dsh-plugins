/**
 * dsh-social-desktop-agent / lib/browser/driver.js
 *
 * ブラウザドライバの抽象インターフェース + 契約検証。
 *
 * この層の目的は「実装」ではなく「境界」を固定すること:
 *   - tools.js は driver を DI で受け取り、契約（メソッド名と戻り値の形）だけに依存する
 *   - 本番は cdp-driver.js、テストは stub-driver.js。tools.js は両者を区別しない
 *
 * 必須メソッド（すべて async 可・同期でもよい。tools 側は必ず await する）:
 *
 *   open(url)                   -> { url, title }        遷移して現在ページを返す
 *   getPage()                   -> { url, title, text }   現在ページの観測。text は本文（上限あり）
 *   snapshot({ maxNodes })      -> { url, title, text?, nodes: Node[] }
 *   click(ref)                  -> { ref, role?, name? }  ref は snapshot が返した文字列
 *   type(ref, text, { submit }) -> { ref }                入力（submit で Enter）
 *   scroll({ deltaY, ref? })    -> { y?, deltaY? }
 *   screenshot({ fullPage })    -> { mimeType, dataUrl }  dataUrl は `data:image/png;base64,...`
 *   close()                     -> { ok? }
 *
 * 任意メソッド:
 *   describe(ref) -> Node | null    ref のメタ情報。無ければ tools が最後の snapshot から引く
 *
 * Node = { ref, role, name, value?, url?, type?, disabled? }
 */

export const DRIVER_METHODS = Object.freeze([
  'open',
  'getPage',
  'snapshot',
  'click',
  'type',
  'scroll',
  'screenshot',
  'close',
]);

export const OPTIONAL_DRIVER_METHODS = Object.freeze(['describe']);

/** ドライバ・ポリシー・ref の契約違反を表すエラー。code は機械可読。 */
export class DriverError extends Error {
  constructor(code, message, detail = null) {
    super(message);
    this.name = 'DriverError';
    this.code = code;
    if (detail !== null) this.detail = detail;
  }
}

/**
 * ドライバが契約を満たしているか検証する。満たさなければ DriverError を投げる。
 * 生成時に一度だけ呼ぶ想定（毎操作の検証はコストの無駄）。
 */
export function assertDriver(driver) {
  if (!driver || typeof driver !== 'object') {
    throw new DriverError('DRIVER_INVALID', 'ブラウザドライバが指定されていません（createBrowseTools({ driver })）');
  }
  const missing = DRIVER_METHODS.filter((name) => typeof driver[name] !== 'function');
  if (missing.length > 0) {
    throw new DriverError('DRIVER_INVALID', `ブラウザドライバに必須メソッドがありません: ${missing.join(', ')}`);
  }
  return driver;
}

/**
 * ポリシーが共有契約（check(action)）を満たしているか検証する。
 * require(action) は任意（あれば型だけ確認する）。
 */
export function assertPolicy(policy) {
  if (!policy || typeof policy.check !== 'function') {
    throw new DriverError('POLICY_INVALID', 'policy.check(action) を持つポリシーが必要です');
  }
  if (policy.require != null && typeof policy.require !== 'function') {
    throw new DriverError('POLICY_INVALID', 'policy.require は関数か未定義でなければなりません');
  }
  return policy;
}

/** 操作対象の ref を検証する。空文字・非文字列は拒否。 */
export function assertRef(ref) {
  if (typeof ref !== 'string' || !ref.trim()) {
    throw new DriverError('INVALID_REF', 'ref は空でない文字列で指定してください（browse_snapshot の [eN]）');
  }
  return ref.trim();
}

/** ページ情報の形をそろえる。欠けたフィールドは fallback で埋める。 */
export function normalizePageInfo(raw, fallback = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    url: typeof src.url === 'string' && src.url ? src.url : String(fallback.url ?? ''),
    title: typeof src.title === 'string' ? src.title : String(fallback.title ?? ''),
    text: typeof src.text === 'string' ? src.text : String(fallback.text ?? ''),
  };
}

/**
 * snapshot() の戻り値を正規化する。
 * ref の無いノードは捨てる（ref が無いとクリックできないため、UI に出しても害しかない）。
 */
export function normalizeSnapshotResult(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new DriverError('DRIVER_INVALID_RESULT', 'snapshot() は { url, title, nodes } を返す必要があります');
  }
  const nodesIn = Array.isArray(raw.nodes) ? raw.nodes : [];
  const nodes = [];
  const seen = new Set();

  for (const node of nodesIn) {
    if (!node || typeof node !== 'object') continue;
    const ref = typeof node.ref === 'string' ? node.ref.trim() : '';
    if (!ref || seen.has(ref)) continue;
    seen.add(ref);
    nodes.push({
      ref,
      role: String(node.role ?? 'unknown'),
      name: String(node.name ?? '').replace(/\s+/g, ' ').trim(),
      value: node.value == null ? undefined : String(node.value),
      url: node.url == null ? undefined : String(node.url),
      type: node.type == null ? undefined : String(node.type),
      disabled: node.disabled === true,
    });
  }

  return {
    url: String(raw.url ?? ''),
    title: String(raw.title ?? ''),
    text: typeof raw.text === 'string' ? raw.text : '',
    nodes,
  };
}

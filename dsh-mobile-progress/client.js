/**
 * dsh-mobile-progress — client half (browser / renderer).
 *
 * Adds a resident entry to the Harness Web left sidebar: one icon in the panel
 * row, and the page it selects. The page answers the two questions a user has
 * when the phone feed is mentioned — "is it running?" and "what do I open on
 * the phone?" — and then mirrors the live progress the agent publishes.
 *
 * The Host half owns all state. This file only paints it, read through the
 * same-origin bridge the Host mounts on the Web server:
 *
 *   GET /mobile-progress-api/state -> { ..., phoneUrl, publicUrl, qrUrl, qr }
 *
 * Being same-origin matters: the phone page itself lives on a different port on
 * `0.0.0.0`, so reading it here would need CORS and the access token.
 *
 * Hard constraints (see the fanout client half, which shares this shape):
 *   - plain JS, no build step, only `require('react')`.
 *   - no global CSS, no `document.body` writes, no literal colours outside
 *     artwork (the QR card is artwork: a QR needs a light quiet zone to scan).
 *   - never throw during render; every payload is treated as untrusted data.
 */

window.__ModuleLoader__.load({
  // The id must equal the package name: the boot graph keys each `dsh.client`
  // row by its package, and a factory registered under any other id never
  // materializes — the sidebar entry would silently never appear.
  id: '@local/dsh-mobile-progress',
  factory(require) {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const React = require('react');
    const h = React.createElement;
    const useEffect = React.useEffect;
    const useRef = React.useRef;
    const useState = React.useState;

    /* ------------------------------------------------------------------ *
     * Constants
     * ------------------------------------------------------------------ */

    const PANEL_ID = 'mobile-progress';
    const PANEL_ORDER = 40;
    const BRIDGE_PATH = '/mobile-progress-api/state';
    const POLL_MS = 3000;
    const HIDDEN_POLL_MS = 20000;
    const REQUEST_TIMEOUT_MS = 6000;
    const MAX_STEPS = 12;
    const MAX_LOGS = 4;

    /* ------------------------------------------------------------------ *
     * Strings — Japanese is the product language for this installation; an
     * optional locale service may override individual keys (locale/*.json).
     * ------------------------------------------------------------------ */

    const STRINGS_JA = {
      navLabel: 'スマホ進捗',
      title: 'スマホ進捗',
      subtitle: 'アプリが起動している間ずっと配信しています',
      resident: '常駐',
      statusLive: '配信中',
      statusDown: '停止',
      statusUnknown: '確認中',
      refresh: '更新',
      refreshing: '更新中…',
      disconnected: 'Host 側のブリッジに届いていません。アプリを再起動すると直ることがあります。',
      bridgeTitle: 'スマホで開く',
      qrHint: 'カメラで読み取ると、いまの進捗画面が開きます',
      qrMissing: 'QR を作れませんでした。下の URL を使ってください。',
      lanLabel: '同じ Wi-Fi から',
      publicLabel: '外から（トンネル）',
      publicNone: 'トンネル未接続',
      copy: 'コピー',
      copied: 'コピーしました',
      copyFailed: 'コピーできませんでした',
      open: '開く',
      progressTitle: 'いまの進み具合',
      progressEmpty: 'まだ進捗がありません',
      progressEmptyHint: 'エージェントが作業を始めると、ここに進捗と手順が出ます。',
      percentUnknown: '—',
      steps: '手順',
      noSteps: '手順はまだありません',
      stepPending: '待機',
      stepActive: '実行中',
      stepDone: '完了',
      recent: '直近の動き',
      metaUpdated: '最終更新',
      metaPort: 'ポート',
      metaSession: 'セッション',
      metaTunnel: 'トンネル',
      metaAwake: 'スリープ防止',
      tunnelOn: '接続中',
      tunnelOff: '未使用',
      awakeOn: '有効',
      awakeOff: '無効',
      secondsAgo: '秒前',
      minutesAgo: '分前',
      hoursAgo: '時間前',
      justNow: 'たったいま',
      statusWorking: '作業中',
      statusDone: '完了',
      statusBlocked: '待機・確認待ち',
      statusError: 'エラー',
      statusIdle: '待機中',
      resultReady: '結果あり',
      request: '依頼',
    };

    const STRINGS_EN = {
      navLabel: 'Phone progress',
      title: 'Phone progress',
      subtitle: 'Served continuously while the app is running',
      resident: 'Always on',
      statusLive: 'Live',
      statusDown: 'Stopped',
      statusUnknown: 'Checking',
      refresh: 'Refresh',
      refreshing: 'Refreshing…',
      disconnected: 'The Host bridge is not answering. Restarting the app usually fixes it.',
      bridgeTitle: 'Open on the phone',
      qrHint: 'Scan it with the camera to open the live progress page',
      qrMissing: 'Could not build the QR code. Use the URL below.',
      lanLabel: 'Same Wi-Fi',
      publicLabel: 'From anywhere (tunnel)',
      publicNone: 'tunnel not connected',
      copy: 'Copy',
      copied: 'Copied',
      copyFailed: 'Copy failed',
      open: 'Open',
      progressTitle: 'Progress now',
      progressEmpty: 'No progress yet',
      progressEmptyHint: 'Once the agent starts working, its progress and steps appear here.',
      percentUnknown: '—',
      steps: 'Steps',
      noSteps: 'No steps yet',
      stepPending: 'queued',
      stepActive: 'running',
      stepDone: 'done',
      recent: 'Recent activity',
      metaUpdated: 'Updated',
      metaPort: 'port',
      metaSession: 'session',
      metaTunnel: 'tunnel',
      metaAwake: 'keep awake',
      tunnelOn: 'connected',
      tunnelOff: 'off',
      awakeOn: 'on',
      awakeOff: 'off',
      secondsAgo: 's ago',
      minutesAgo: 'm ago',
      hoursAgo: 'h ago',
      justNow: 'just now',
      statusWorking: 'working',
      statusDone: 'done',
      statusBlocked: 'waiting',
      statusError: 'error',
      statusIdle: 'idle',
      resultReady: 'result ready',
      request: 'request',
    };

    let activeStrings = STRINGS_JA;

    function asString(value) {
      return typeof value === 'string' ? value : '';
    }

    function isObject(value) {
      return !!value && typeof value === 'object' && !Array.isArray(value);
    }

    /** Copy only keys we know about, and only when the override is non-empty. */
    function mergeStrings(target, override) {
      if (!isObject(override)) return target;
      const keys = Object.keys(target);
      for (let i = 0; i < keys.length; i += 1) {
        const key = keys[i];
        const value = override[key];
        if (typeof value === 'string' && value) target[key] = value;
      }
      return target;
    }

    function resolveStrings(ctx) {
      const table = Object.assign({}, STRINGS_JA);
      try {
        const locale = ctx && typeof ctx.get === 'function' ? ctx.get('locale') : null;
        if (isObject(locale)) {
          if (isObject(locale.mobileProgress)) mergeStrings(table, locale.mobileProgress);
          else if (isObject(locale.strings) && isObject(locale.strings.mobileProgress)) {
            mergeStrings(table, locale.strings.mobileProgress);
          }
          const language = asString(locale.language).toLowerCase();
          if (language.indexOf('ja') !== 0 && isObject(locale.en) && isObject(locale.en.mobileProgress)) {
            mergeStrings(table, locale.en.mobileProgress);
          }
        }
      } catch (err) {
        /* locale is optional: the built-in table stands on its own */
      }
      return table;
    }

    /* ------------------------------------------------------------------ *
     * Theme tokens — verified against the live theme (client inspect:
     * Theme.listTokens). Every token keeps a currentColor/transparent
     * fallback so a renamed token degrades instead of disappearing.
     * ------------------------------------------------------------------ */

    const T = {
      labelPrimary: 'var(--dsw-alias-label-primary, currentColor)',
      labelSecondary: 'var(--dsw-alias-label-secondary, currentColor)',
      labelCaption: 'var(--dsw-alias-label-caption, var(--dsw-alias-label-tertiary, currentColor))',
      borderL1: 'var(--dsw-alias-border-l1, currentColor)',
      borderL2: 'var(--dsw-alias-border-l2, currentColor)',
      bgBase: 'var(--dsw-alias-bg-base, transparent)',
      bgLayer1: 'var(--dsw-alias-bg-layer-1, transparent)',
      bgLayer2: 'var(--dsw-alias-bg-layer-2, transparent)',
      brand: 'var(--dsw-alias-brand-primary, currentColor)',
      success: 'var(--dsw-alias-state-success-primary, currentColor)',
      error: 'var(--dsw-alias-state-error-primary, currentColor)',
      warn: 'var(--dsw-alias-state-warn-primary, currentColor)',
      idle: 'var(--dsw-alias-state-idle-primary, var(--dsw-alias-label-tertiary, currentColor))',
      mono: 'var(--dsw-alias-font-family-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
    };

    const FS = { title: 15, body: 13, small: 12, tiny: 11 };

    const S = {
      page: {
        fontFamily: 'inherit',
        fontSize: FS.body,
        color: T.labelPrimary,
        background: T.bgBase,
        height: '100%',
        overflowY: 'auto',
        padding: '18px 20px 40px',
        boxSizing: 'border-box',
        lineHeight: 1.55,
      },
      column: {
        maxWidth: 760,
        margin: '0 auto',
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
      },
      header: {
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        flexWrap: 'wrap',
        minHeight: 34,
      },
      headerText: {
        display: 'flex',
        flexDirection: 'column',
        gap: 1,
        minWidth: 0,
      },
      title: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        fontSize: FS.title,
        fontWeight: 600,
        color: T.labelPrimary,
      },
      subtitle: {
        fontSize: FS.tiny,
        color: T.labelCaption,
      },
      chip: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        fontSize: FS.tiny,
        color: T.labelSecondary,
        background: T.bgLayer1,
        border: '1px solid ' + T.borderL1,
        borderRadius: 999,
        padding: '2px 9px',
        whiteSpace: 'nowrap',
      },
      dot: {
        width: 7,
        height: 7,
        borderRadius: '50%',
        display: 'inline-block',
        flex: '0 0 auto',
      },
      spacer: {
        marginLeft: 'auto',
      },
      button: {
        font: 'inherit',
        fontSize: FS.small,
        color: T.labelSecondary,
        background: 'transparent',
        border: '1px solid ' + T.borderL2,
        borderRadius: 7,
        padding: '4px 11px',
        cursor: 'pointer',
        lineHeight: 1.5,
        whiteSpace: 'nowrap',
      },
      buttonSmall: {
        font: 'inherit',
        fontSize: FS.tiny,
        color: T.labelSecondary,
        background: 'transparent',
        border: '1px solid ' + T.borderL1,
        borderRadius: 6,
        padding: '2px 8px',
        cursor: 'pointer',
        lineHeight: 1.5,
        whiteSpace: 'nowrap',
      },
      card: {
        background: T.bgLayer1,
        border: '1px solid ' + T.borderL1,
        borderRadius: 12,
        padding: '14px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        minWidth: 0,
      },
      cardTitle: {
        fontSize: FS.small,
        fontWeight: 600,
        color: T.labelSecondary,
        letterSpacing: '0.02em',
      },
      phoneGrid: {
        display: 'flex',
        gap: 16,
        flexWrap: 'wrap',
        alignItems: 'flex-start',
      },
      qrCard: {
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 8,
        padding: '12px 12px 10px',
        // Artwork: a QR needs a light field and a quiet zone to scan at all.
        background: '#ffffff',
        border: '1px solid ' + T.borderL2,
        borderRadius: 12,
      },
      qrHint: {
        fontSize: FS.tiny,
        color: '#4a4a4a',
        textAlign: 'center',
        maxWidth: 200,
        lineHeight: 1.4,
      },
      urlList: {
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        flex: '1 1 260px',
        minWidth: 0,
      },
      urlRow: {
        display: 'flex',
        flexDirection: 'column',
        gap: 3,
        minWidth: 0,
      },
      urlHead: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        flexWrap: 'wrap',
      },
      urlLabel: {
        fontSize: FS.tiny,
        color: T.labelCaption,
      },
      urlValue: {
        fontFamily: T.mono,
        fontSize: FS.tiny,
        color: T.labelPrimary,
        background: T.bgLayer2,
        border: '1px solid ' + T.borderL1,
        borderRadius: 6,
        padding: '4px 7px',
        wordBreak: 'break-all',
        userSelect: 'all',
      },
      muted: {
        color: T.labelCaption,
        fontSize: FS.tiny,
      },
      progressHead: {
        display: 'flex',
        alignItems: 'baseline',
        gap: 10,
        flexWrap: 'wrap',
        minWidth: 0,
      },
      progressTitle: {
        fontSize: FS.title,
        fontWeight: 600,
        color: T.labelPrimary,
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      percent: {
        marginLeft: 'auto',
        fontSize: 22,
        fontWeight: 700,
        color: T.labelPrimary,
        fontVariantNumeric: 'tabular-nums',
        lineHeight: 1.1,
      },
      barTrack: {
        position: 'relative',
        height: 8,
        borderRadius: 999,
        background: T.bgLayer2,
        border: '1px solid ' + T.borderL1,
        overflow: 'hidden',
      },
      barFill: {
        position: 'absolute',
        left: 0,
        top: 0,
        bottom: 0,
        borderRadius: 999,
        background: T.brand,
        transition: 'width 240ms ease',
      },
      currentStep: {
        fontSize: FS.body,
        color: T.labelPrimary,
        display: 'flex',
        alignItems: 'flex-start',
        gap: 7,
      },
      stepList: {
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        margin: 0,
        padding: 0,
        listStyle: 'none',
      },
      stepRow: {
        display: 'flex',
        alignItems: 'flex-start',
        gap: 8,
        fontSize: FS.small,
        color: T.labelSecondary,
        lineHeight: 1.5,
      },
      stepText: {
        minWidth: 0,
        wordBreak: 'break-word',
      },
      stepTextDone: {
        color: T.labelCaption,
      },
      stepState: {
        marginLeft: 'auto',
        fontSize: FS.tiny,
        color: T.labelCaption,
        whiteSpace: 'nowrap',
        flex: '0 0 auto',
      },
      metaRow: {
        display: 'flex',
        gap: 14,
        flexWrap: 'wrap',
        fontSize: FS.tiny,
        color: T.labelCaption,
        borderTop: '1px solid ' + T.borderL1,
        paddingTop: 9,
        marginTop: 2,
      },
      metaPair: {
        display: 'inline-flex',
        gap: 5,
        alignItems: 'baseline',
      },
      metaValue: {
        color: T.labelSecondary,
        fontVariantNumeric: 'tabular-nums',
      },
      notice: {
        display: 'flex',
        alignItems: 'flex-start',
        gap: 8,
        fontSize: FS.small,
        color: T.labelSecondary,
        background: T.bgLayer2,
        border: '1px solid ' + T.borderL1,
        borderLeft: '3px solid ' + T.warn,
        borderRadius: 8,
        padding: '9px 11px',
        lineHeight: 1.5,
      },
      empty: {
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 6,
        padding: '26px 10px',
        textAlign: 'center',
      },
      emptyTitle: {
        fontSize: FS.body,
        fontWeight: 600,
        color: T.labelSecondary,
      },
      logList: {
        display: 'flex',
        flexDirection: 'column',
        gap: 3,
        margin: 0,
        padding: 0,
        listStyle: 'none',
        fontSize: FS.tiny,
        color: T.labelCaption,
      },
      logTime: {
        fontVariantNumeric: 'tabular-nums',
        marginRight: 6,
        color: T.labelCaption,
      },
    };

    /* ------------------------------------------------------------------ *
     * Data shaping — the payload is untrusted input
     * ------------------------------------------------------------------ */

    function asCount(value, fallback) {
      const n = Number(value);
      return Number.isFinite(n) ? n : fallback;
    }

    function normalizeSteps(raw) {
      const out = [];
      if (!Array.isArray(raw)) return out;
      for (let i = 0; i < raw.length; i += 1) {
        const item = raw[i];
        if (!isObject(item)) continue;
        const text = asString(item.text).trim();
        if (!text) continue;
        let status = asString(item.status).toLowerCase();
        if (status !== 'done' && status !== 'in_progress') status = 'pending';
        out.push({ text: text, status: status });
      }
      return out;
    }

    function normalizeLogs(raw) {
      const out = [];
      if (!Array.isArray(raw)) return out;
      for (let i = 0; i < raw.length; i += 1) {
        const item = raw[i];
        if (!isObject(item)) continue;
        const text = asString(item.text).trim();
        if (!text) continue;
        out.push({ at: asCount(item.at, 0), text: text });
      }
      return out;
    }

    function normalizeQr(raw) {
      if (!isObject(raw)) return null;
      const size = asCount(raw.size, 0);
      const rows = raw.rows;
      if (!Number.isFinite(size) || size < 21 || size > 57) return null;
      if (!Array.isArray(rows) || rows.length !== size) return null;
      const checked = [];
      for (let r = 0; r < rows.length; r += 1) {
        const row = rows[r];
        if (typeof row !== 'string' || row.length !== size) return null;
        checked.push(row);
      }
      return { size: size, rows: checked };
    }

    function normalizeSession(raw) {
      if (!isObject(raw)) return null;
      const steps = normalizeSteps(raw.steps);
      const percent = Number(raw.percent);
      return {
        id: asString(raw.id),
        short: asString(raw.short),
        title: asString(raw.title),
        request: asString(raw.request),
        status: asString(raw.status) || 'idle',
        percent: Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : null,
        currentStep: asString(raw.currentStep),
        note: asString(raw.note),
        steps: steps,
        logs: normalizeLogs(raw.logs).slice(-MAX_LOGS),
        updatedAt: asCount(raw.updatedAt, 0),
        agentRunning: raw.agentRunning === true,
        cwdName: asString(raw.cwdName),
        resultState: asString(raw.resultState),
      };
    }

    function normalizePayload(raw, receivedAt) {
      const out = {
        ok: false,
        receivedAt: receivedAt,
        listening: false,
        title: 'DSH Progress',
        port: 0,
        phoneUrl: '',
        publicUrl: '',
        qrUrl: '',
        qr: null,
        tunnel: { enabled: false, status: 'off', error: '' },
        keepAwake: { enabled: false, active: false },
        server: { host: '', lanUrls: [] },
        session: null,
      };
      if (!isObject(raw)) return out;
      out.ok = raw.ok === true;
      out.listening = raw.listening === true;
      out.title = asString(raw.title) || out.title;
      out.port = asCount(raw.port, 0);
      out.phoneUrl = asString(raw.phoneUrl);
      out.publicUrl = asString(raw.publicUrl);
      out.qrUrl = asString(raw.qrUrl);
      out.qr = normalizeQr(raw.qr);
      if (isObject(raw.server)) {
        out.server.host = asString(raw.server.host);
        if (Array.isArray(raw.server.lanUrls)) {
          out.server.lanUrls = raw.server.lanUrls.filter(function keep(value) {
            return typeof value === 'string' && value.length > 0;
          });
        }
      }
      if (isObject(raw.tunnel)) {
        out.tunnel.enabled = raw.tunnel.enabled === true;
        out.tunnel.status = asString(raw.tunnel.status) || 'off';
        out.tunnel.error = asString(raw.tunnel.error);
      }
      if (isObject(raw.keepAwake)) {
        out.keepAwake.enabled = raw.keepAwake.enabled === true;
        out.keepAwake.active = raw.keepAwake.active === true;
      }
      out.session = normalizeSession(raw.session);
      return out;
    }

    /* ------------------------------------------------------------------ *
     * Store + polling hub
     *
     * apply() owns the timer through ctx.effect; the components only subscribe.
     * The hub is module scoped, so an HMR re-apply hands the mounted component
     * the fresh store instead of leaving a subscription on a dead one.
     * ------------------------------------------------------------------ */

    function createStore(initial) {
      let state = initial;
      const listeners = new Set();
      function emit() {
        const snapshot = Array.from(listeners);
        for (let i = 0; i < snapshot.length; i += 1) {
          try {
            snapshot[i]();
          } catch (err) {
            /* one broken listener must not break the others */
          }
        }
      }
      return {
        get() {
          return state;
        },
        set(patch) {
          if (!patch) return;
          const next = typeof patch === 'function' ? patch(state) : patch;
          if (!isObject(next)) return;
          state = Object.assign({}, state, next);
          emit();
        },
        subscribe(listener) {
          if (typeof listener !== 'function') return function noop() {};
          listeners.add(listener);
          return function unsubscribe() {
            listeners.delete(listener);
          };
        },
      };
    }

    function emptySnapshot() {
      return {
        connected: false,
        busy: false,
        error: '',
        data: null,
        fetchedAt: 0,
        copyNotice: '',
      };
    }

    const hub = {
      get() {
        return activeRuntime ? activeRuntime.store.get() : emptySnapshot();
      },
      subscribe(listener) {
        if (!activeRuntime) return function noop() {};
        return activeRuntime.store.subscribe(listener);
      },
    };

    let activeRuntime = null;

    async function fetchState() {
      if (typeof fetch !== 'function') return { ok: false, error: 'fetch unavailable' };
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      let timer = null;
      if (controller) {
        timer = setTimeout(function abortNow() {
          try {
            controller.abort();
          } catch (err) {
            /* already settled */
          }
        }, REQUEST_TIMEOUT_MS);
      }
      try {
        const init = { method: 'GET', headers: { accept: 'application/json' }, cache: 'no-store' };
        if (controller) init.signal = controller.signal;
        const res = await fetch(BRIDGE_PATH, init);
        const text = await res.text().catch(function noText() {
          return '';
        });
        let data = null;
        if (text) {
          try {
            data = JSON.parse(text);
          } catch (err) {
            data = null;
          }
        }
        if (!res.ok) return { ok: false, error: 'HTTP ' + res.status };
        return { ok: true, data: data };
      } catch (err) {
        return { ok: false, error: (err && err.message) || 'network error' };
      } finally {
        if (timer) clearTimeout(timer);
      }
    }

    /* ------------------------------------------------------------------ *
     * Small view helpers
     * ------------------------------------------------------------------ */

    function pad2(value) {
      return value < 10 ? '0' + value : String(value);
    }

    function timeAgo(ms, strings) {
      if (!Number.isFinite(ms) || ms <= 0) return '';
      const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
      if (seconds < 5) return strings.justNow;
      if (seconds < 60) return seconds + strings.secondsAgo;
      const minutes = Math.round(seconds / 60);
      if (minutes < 60) return minutes + strings.minutesAgo;
      const hours = Math.round(minutes / 60);
      return hours + strings.hoursAgo;
    }

    function clockOf(ms) {
      if (!Number.isFinite(ms) || ms <= 0) return '';
      const date = new Date(ms);
      return pad2(date.getHours()) + ':' + pad2(date.getMinutes()) + ':' + pad2(date.getSeconds());
    }

    function statusTextOf(status, strings) {
      const value = asString(status).toLowerCase();
      if (value === 'working') return strings.statusWorking;
      if (value === 'done') return strings.statusDone;
      if (value === 'blocked') return strings.statusBlocked;
      if (value === 'error') return strings.statusError;
      return strings.statusIdle;
    }

    function statusToneOf(status) {
      const value = asString(status).toLowerCase();
      if (value === 'done') return T.success;
      if (value === 'error') return T.error;
      if (value === 'blocked') return T.warn;
      return T.brand;
    }

    function stepLabelOf(status, strings) {
      if (status === 'done') return strings.stepDone;
      if (status === 'in_progress') return strings.stepActive;
      return strings.stepPending;
    }

    function stepToneOf(status) {
      if (status === 'done') return T.success;
      if (status === 'in_progress') return T.brand;
      return T.idle;
    }

    /** Clipboard with a selection fallback for when the async API is denied. */
    function copyText(text) {
      if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard
          .writeText(text)
          .then(function done() {
            return true;
          })
          .catch(function fallback() {
            return legacyCopy(text);
          });
      }
      return Promise.resolve(legacyCopy(text));
    }

    function legacyCopy(text) {
      try {
        const area = document.createElement('textarea');
        area.value = text;
        area.setAttribute('readonly', 'readonly');
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        const ok = typeof document.execCommand === 'function' ? document.execCommand('copy') : false;
        document.body.removeChild(area);
        return ok === true;
      } catch (err) {
        return false;
      }
    }

    /* ------------------------------------------------------------------ *
     * Artwork: sidebar icon
     * ------------------------------------------------------------------ */

    function PanelIcon(props) {
      const size = props && Number.isFinite(props.size) ? props.size : 20;
      const active = !!(props && props.active);
      const color = active ? T.brand : 'currentColor';
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          'aria-hidden': 'true',
          focusable: 'false',
          style: { display: 'block' },
        },
        [
          // Handset
          h('rect', {
            key: 'body',
            x: 6.5,
            y: 2.5,
            width: 11,
            height: 19,
            rx: 2.6,
            stroke: color,
            strokeWidth: 1.5,
          }),
          h('line', {
            key: 'screen',
            x1: 6.5,
            y1: 5.6,
            x2: 17.5,
            y2: 5.6,
            stroke: color,
            strokeWidth: 1.2,
            opacity: 0.55,
          }),
          // Progress bar inside the handset
          h('rect', { key: 'bar-bg', x: 8.6, y: 9.4, width: 6.8, height: 2.1, rx: 1, fill: color, opacity: 0.22 }),
          h('rect', { key: 'bar-fill', x: 8.6, y: 9.4, width: 4.1, height: 2.1, rx: 1, fill: color }),
          h('line', {
            key: 'line-1',
            x1: 8.6,
            y1: 13.6,
            x2: 15.4,
            y2: 13.6,
            stroke: color,
            strokeWidth: 1.2,
            strokeLinecap: 'round',
            opacity: 0.6,
          }),
          h('line', {
            key: 'line-2',
            x1: 8.6,
            y1: 16.2,
            x2: 13.2,
            y2: 16.2,
            stroke: color,
            strokeWidth: 1.2,
            strokeLinecap: 'round',
            opacity: 0.35,
          }),
          // Signal: the phone is live
          h('path', {
            key: 'wave',
            d: 'M19.6 4.2 a5.4 5.4 0 0 1 0 6.2',
            stroke: color,
            strokeWidth: 1.4,
            strokeLinecap: 'round',
            opacity: 0.85,
          }),
        ],
      );
    }

    /* ------------------------------------------------------------------ *
     * QR canvas
     * ------------------------------------------------------------------ */

    function QrCanvas(props) {
      const ref = useRef(null);
      const matrix = props.matrix;
      const size = props.size || 180;

      useEffect(
        function paint() {
          const canvas = ref.current;
          if (!canvas || !matrix) return;
          const context = typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
          if (!context) return;
          const ratio = typeof window !== 'undefined' && window.devicePixelRatio ? window.devicePixelRatio : 1;
          const modules = matrix.size + 4; // 2-module quiet zone on each side
          const scale = Math.max(1, Math.floor((size * ratio) / modules));
          const dimension = modules * scale;
          canvas.width = dimension;
          canvas.height = dimension;
          canvas.style.width = dimension / ratio + 'px';
          canvas.style.height = dimension / ratio + 'px';
          context.fillStyle = '#ffffff';
          context.fillRect(0, 0, dimension, dimension);
          context.fillStyle = '#111111';
          for (let r = 0; r < matrix.size; r += 1) {
            const row = matrix.rows[r];
            for (let c = 0; c < matrix.size; c += 1) {
              if (row.charAt(c) !== '1') continue;
              context.fillRect((c + 2) * scale, (r + 2) * scale, scale, scale);
            }
          }
        },
        [matrix, size],
      );

      if (!matrix) return null;
      return h('canvas', {
        ref: ref,
        role: 'img',
        'data-mobile-progress-qr': '1',
        'aria-label': activeStrings.qrHint,
        style: { display: 'block', borderRadius: 4, background: '#ffffff' },
      });
    }

    /* ------------------------------------------------------------------ *
     * Panel pieces
     * ------------------------------------------------------------------ */

    function Chip(props) {
      return h(
        'span',
        { style: props.style ? Object.assign({}, S.chip, props.style) : S.chip },
        [
          h('span', {
            key: 'dot',
            style: Object.assign({}, S.dot, { background: props.tone || T.idle }),
            'aria-hidden': 'true',
          }),
          h('span', { key: 'text' }, props.children),
        ],
      );
    }

    function UrlRow(props) {
      const [copied, setCopied] = useState('');
      const url = asString(props.url);

      const onCopy = function onCopy() {
        if (!url) return;
        copyText(url).then(function afterCopy(ok) {
          setCopied(ok ? 'ok' : 'fail');
          setTimeout(function clear() {
            setCopied('');
          }, 1600);
        });
      };

      const head = [
        h('span', { key: 'label', style: S.urlLabel }, props.label),
        copied
          ? h(
              'span',
              {
                key: 'notice',
                style: { fontSize: FS.tiny, color: copied === 'ok' ? T.success : T.error },
                role: 'status',
              },
              copied === 'ok' ? activeStrings.copied : activeStrings.copyFailed,
            )
          : null,
        h(
          'button',
          {
            key: 'copy',
            type: 'button',
            style: S.buttonSmall,
            disabled: !url,
            onClick: onCopy,
          },
          activeStrings.copy,
        ),
        url
          ? h(
              'a',
              {
                key: 'open',
                href: url,
                target: '_blank',
                rel: 'noreferrer noopener',
                style: Object.assign({}, S.buttonSmall, { textDecoration: 'none' }),
              },
              activeStrings.open,
            )
          : null,
      ].filter(Boolean);

      return h('div', { style: S.urlRow }, [
        h('div', { key: 'head', style: S.urlHead }, head),
        h(
          'div',
          { key: 'value', style: S.urlValue, title: url },
          url || props.placeholder || activeStrings.publicNone,
        ),
      ]);
    }

    function ProgressCard(props) {
      const session = props.session;
      const s = activeStrings;
      if (!session) {
        return h('section', { style: S.card }, [
          h('div', { key: 'title', style: S.cardTitle }, s.progressTitle),
          h('div', { key: 'empty', style: S.empty }, [
            h('div', { key: 't', style: S.emptyTitle }, s.progressEmpty),
            h('div', { key: 'h', style: S.muted }, s.progressEmptyHint),
          ]),
        ]);
      }

      const percent = session.percent === null ? null : session.percent;
      const head = [
        h('span', { key: 'dot', style: Object.assign({}, S.dot, { background: statusToneOf(session.status) }), 'aria-hidden': 'true' }),
        h(
          'span',
          { key: 'title', style: S.progressTitle, title: session.title || session.request },
          session.title || session.request || session.short || s.title,
        ),
        h('span', { key: 'status', style: S.muted }, statusTextOf(session.status, s)),
        percent === null
          ? h('span', { key: 'pct', style: S.percent }, s.percentUnknown)
          : h('span', { key: 'pct', style: S.percent }, String(Math.round(percent)) + '%'),
      ];

      const bar = h(
        'div',
        {
          key: 'bar',
          style: S.barTrack,
          role: 'progressbar',
          'aria-valuemin': 0,
          'aria-valuemax': 100,
          'aria-valuenow': percent === null ? 0 : Math.round(percent),
        },
        h('div', {
          style: Object.assign({}, S.barFill, {
            width: (percent === null ? 0 : Math.max(0, Math.min(100, percent))) + '%',
            background: statusToneOf(session.status),
          }),
        }),
      );

      const current = session.currentStep
        ? h('div', { key: 'current', style: S.currentStep }, [
            h('span', { key: 'dot', style: Object.assign({}, S.dot, { background: T.brand, marginTop: 7 }), 'aria-hidden': 'true' }),
            h('span', { key: 'text' }, session.currentStep),
          ])
        : null;

      const list = h(
        'div',
        { key: 'list' },
        session.steps.length
          ? h('ul', { style: S.stepList }, session.steps.slice(0, MAX_STEPS).map(function row(step, index) {
              const done = step.status === 'done';
              return h('li', { key: String(index) + ':' + step.text, style: S.stepRow }, [
                h('span', {
                  key: 'dot',
                  style: Object.assign({}, S.dot, { background: stepToneOf(step.status), marginTop: 6 }),
                  'aria-hidden': 'true',
                }),
                h(
                  'span',
                  { key: 'text', style: done ? Object.assign({}, S.stepText, S.stepTextDone) : S.stepText },
                  step.text,
                ),
                h('span', { key: 'state', style: S.stepState }, stepLabelOf(step.status, activeStrings)),
              ]);
            }))
          : h('div', { style: S.muted }, s.noSteps),
      );

      const logs = session.logs.length
        ? h(
            'ul',
            { key: 'logs', style: S.logList },
            session.logs.map(function line(log, index) {
              return h('li', { key: String(index) + ':' + log.at }, [
                h('span', { key: 't', style: S.logTime }, clockOf(log.at)),
                h('span', { key: 'x' }, log.text),
              ]);
            }),
          )
        : null;

      return h(
        'section',
        { style: S.card, 'data-mobile-progress-progress': '1' },
        [
          h('div', { key: 'head', style: S.progressHead }, head),
          bar,
          current,
          list,
          logs,
        ].filter(Boolean),
      );
    }

    function MetaRow(props) {
      const data = props.data;
      const s = activeStrings;
      if (!data) return null;
      const pairs = [];
      const updated = timeAgo(props.fetchedAt, s);
      if (updated) pairs.push(['updated', s.metaUpdated, updated]);
      if (data.port) pairs.push(['port', s.metaPort, String(data.port)]);
      if (data.session && data.session.short) pairs.push(['session', s.metaSession, data.session.short]);
      pairs.push([
        'tunnel',
        s.metaTunnel,
        data.publicUrl ? s.tunnelOn : s.tunnel.enabled ? asString(data.tunnel.status) || s.tunnelOff : s.tunnelOff,
      ]);
      pairs.push(['awake', s.metaAwake, data.keepAwake.active ? s.awakeOn : s.awakeOff]);
      return h(
        'div',
        { style: S.metaRow },
        pairs.map(function pair(item) {
          return h('span', { key: item[0], style: S.metaPair }, [
            h('span', { key: 'k' }, item[1]),
            h('span', { key: 'v', style: S.metaValue }, item[2]),
          ]);
        }),
      );
    }

    /* ------------------------------------------------------------------ *
     * Panel
     * ------------------------------------------------------------------ */

    function useSnapshot() {
      const [snapshot, setSnapshot] = useState(function initial() {
        return hub.get();
      });
      useEffect(
        function subscribe() {
          return hub.subscribe(function onChange() {
            setSnapshot(hub.get());
          });
        },
        [],
      );
      return snapshot;
    }

    function MobileProgressPanel() {
      const snapshot = useSnapshot();
      const s = activeStrings;
      const data = snapshot.data;
      let body;

      try {
        const live = !!(data && data.ok && data.listening);
        const headerChips = [
          h(Chip, {
            key: 'live',
            tone: live ? T.success : T.error,
          }, live ? s.statusLive : snapshot.connected ? s.statusDown : s.statusUnknown),
          h(Chip, { key: 'resident', tone: T.brand }, s.resident),
        ];

        const header = h('div', { key: 'header', style: S.header }, [
          h('span', { key: 'icon', style: { display: 'inline-flex', color: T.brand } }, h(PanelIcon, { size: 24, active: true })),
          h('div', { key: 'text', style: S.headerText }, [
            h('span', { key: 'title', style: S.title }, s.title),
            h('span', { key: 'sub', style: S.subtitle }, s.subtitle),
          ]),
          h('div', { key: 'chips', style: { display: 'inline-flex', gap: 6, flexWrap: 'wrap' } }, headerChips),
          h('span', { key: 'spacer', style: S.spacer, 'aria-hidden': 'true' }),
          h(
            'button',
            {
              key: 'refresh',
              type: 'button',
              style: S.button,
              disabled: !!snapshot.busy,
              onClick: function onRefreshClick() {
                if (activeRuntime) activeRuntime.refresh();
              },
            },
            snapshot.busy ? s.refreshing : s.refresh,
          ),
        ]);

        const notice = !snapshot.connected
          ? h('div', { key: 'notice', style: S.notice, role: 'status' }, s.disconnected)
          : null;

        const phoneCard = h('section', { key: 'phone', style: S.card }, [
          h('div', { key: 't', style: S.cardTitle }, s.bridgeTitle),
          h('div', { key: 'grid', style: S.phoneGrid }, [
            data && data.qr
              ? h('div', { key: 'qr', style: S.qrCard }, [
                  h(QrCanvas, { key: 'c', matrix: data.qr, size: 176 }),
                  h('div', { key: 'h', style: S.qrHint }, s.qrHint),
                ])
              : null,
            h('div', { key: 'urls', style: S.urlList }, [
              h(UrlRow, { key: 'lan', label: s.lanLabel, url: data ? data.phoneUrl : '' }),
              h(UrlRow, {
                key: 'public',
                label: s.publicLabel,
                url: data ? data.publicUrl : '',
                placeholder: s.publicNone,
              }),
              data && !data.qr ? h('div', { key: 'nofqr', style: S.muted }, s.qrMissing) : null,
            ]),
          ]),
        ]);

        body = [
          header,
          notice,
          phoneCard,
          h(ProgressCard, { key: 'progress', session: data ? data.session : null }),
          data ? h(MetaRow, { key: 'meta', data: data, fetchedAt: snapshot.fetchedAt }) : null,
        ].filter(Boolean);
      } catch (err) {
        // A render fault must not take the panel host down with it.
        body = h('div', { style: S.notice }, s.disconnected);
      }

      return h('div', { style: S.page, 'data-mobile-progress-panel': '1' }, h('div', { style: S.column }, body));
    }

    /* ------------------------------------------------------------------ *
     * Registration
     * ------------------------------------------------------------------ */

    function apply(ctx) {
      activeStrings = resolveStrings(ctx);

      const store = createStore(emptySnapshot());
      let timer = null;
      let disposed = false;

      const runtime = {
        store: store,
        async refresh() {
          if (disposed) return;
          store.set({ busy: true });
          const result = await fetchState();
          if (disposed) return;
          if (result.ok) {
            store.set({
              connected: true,
              busy: false,
              error: '',
              data: normalizePayload(result.data, Date.now()),
              fetchedAt: Date.now(),
            });
          } else {
            store.set({ connected: false, busy: false, error: result.error || 'error' });
          }
        },
      };

      activeRuntime = runtime;

      ctx.effect(function startPolling() {
        let alive = true;
        let interval = null;

        const schedule = function schedule() {
          if (interval) clearInterval(interval);
          const hidden = typeof document !== 'undefined' && document.hidden === true;
          interval = setInterval(function tick() {
            if (!alive) return;
            runtime.refresh();
          }, hidden ? HIDDEN_POLL_MS : POLL_MS);
        };

        const onVisibility = function onVisibility() {
          if (!alive) return;
          schedule();
          if (typeof document !== 'undefined' && document.hidden !== true) runtime.refresh();
        };

        runtime.refresh();
        schedule();
        try {
          if (typeof document !== 'undefined' && document.addEventListener) {
            document.addEventListener('visibilitychange', onVisibility);
          }
        } catch (err) {
          /* no document: the panel is not mounted in a page */
        }

        return function stopPolling() {
          alive = false;
          disposed = true;
          if (interval) clearInterval(interval);
          interval = null;
          timer = null;
          try {
            if (typeof document !== 'undefined' && document.removeEventListener) {
              document.removeEventListener('visibilitychange', onVisibility);
            }
          } catch (err) {
            /* already gone */
          }
          if (activeRuntime === runtime) activeRuntime = null;
        };
      });

      // `inject` keeps each registration scoped to a slot that exists: a host
      // without the sidebar still gets nothing broken, and a missing `main`
      // never costs the caller the icon.
      try {
        ctx.slots.inject('sidebar.panellist', function injectRow() {
          return ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: PANEL_ORDER,
              label: function sidebarRowLabel() {
                return activeStrings.navLabel;
              },
            },
            PanelIcon,
          );
        });
      } catch (err) {
        try {
          console.warn('[dsh-mobile-progress] sidebar row registration failed:', String((err && err.message) || err));
        } catch (ignored) {
          /* console may be unavailable */
        }
      }

      try {
        ctx.slots.inject('main', function injectPanel() {
          return ctx.slots.register(
            {
              name: 'main',
              key: PANEL_ID,
              inject: function panelInjected() {
                let layout = null;
                try {
                  layout = ctx.get('layout');
                } catch (err) {
                  layout = null;
                }
                return {
                  onClose:
                    layout && typeof layout.selectPanel === 'function'
                      ? function closePanel() {
                          layout.selectPanel(null);
                        }
                      : function closePanelNoop() {},
                };
              },
            },
            MobileProgressPanel,
          );
        });
      } catch (err) {
        try {
          console.warn('[dsh-mobile-progress] panel registration failed:', String((err && err.message) || err));
        } catch (ignored) {
          /* console may be unavailable */
        }
      }
    }

    exports.inject = ['slots'];
    exports.apply = apply;
    return module.exports;
  },
});

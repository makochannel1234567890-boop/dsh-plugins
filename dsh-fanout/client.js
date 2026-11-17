/**
 * dsh-fanout — client half (browser / renderer).
 *
 * Renders a compact dock bar under the conversation input and drives the Host
 * half through its loopback JSON bridge:
 *
 *   GET  /health  -> { ok, token }            (only unauthenticated route)
 *   GET  /state   -> { ok, config, runs, active_run_id }
 *   POST /config  -> { ok, config }           (slider persistence, debounced)
 *   POST /start   -> { ok, run_id } | { ok:false, error }
 *   POST /stop    -> { ok }
 *
 * Everything else carries the `x-fanout-token` header returned by /health.
 *
 * Hard constraints (see DESIGN.md, "Panel contract"):
 *   - plain JS, no build step, no imports of host packages; only `require('react')`.
 *   - no global CSS, no `document.body` writes, no literal colours (theme tokens only).
 *   - never throw during render; every response is treated as untrusted data.
 */

window.__ModuleLoader__.load({
  id: 'dsh-fanout',
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

    const SLOT_NAME = 'conversation.input.dock';
    const REGISTRATION_ID = 'fanout-dock';
    const REGISTRATION_ORDER = 15;

    const DEFAULT_PORT = 51337;
    const POLL_MS = 2000;
    const CONFIG_DEBOUNCE_MS = 500;
    const REQUEST_TIMEOUT_MS = 6000;
    const START_TIMEOUT_MS = 25000;

    const MIN_WORKERS = 1;
    const MAX_WORKERS = 8;
    const DEFAULT_WORKERS = 4;
    const MIN_EXPANSION = 0;
    const MAX_EXPANSION = 100;
    const DEFAULT_EXPANSION = 40;

    const MAX_TASKS = 64;
    const MAX_VERIFY = 12;

    /* ------------------------------------------------------------------ *
     * Small pure helpers (none of these throw on bad input)
     * ------------------------------------------------------------------ */

    function clamp(value, min, max) {
      const n = Number(value);
      if (!Number.isFinite(n)) return min;
      if (n < min) return min;
      if (n > max) return max;
      return n;
    }

    function isObject(value) {
      return !!value && typeof value === 'object' && !Array.isArray(value);
    }

    function asString(value) {
      return typeof value === 'string' ? value : '';
    }

    function asCount(value) {
      const n = Number(value);
      return Number.isFinite(n) && n >= 0 ? n : 0;
    }

    /** One task per line: `title :: brief :: weight` (brief/weight optional). */
    function parseTasks(text) {
      const out = [];
      const lines = asString(text).split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        const raw = lines[i].trim();
        if (!raw) continue;
        const parts = raw.split('::');
        const title = asString(parts[0]).trim();
        if (!title) continue;
        const task = { title: title };
        const brief = asString(parts[1]).trim();
        if (brief) task.brief = brief;
        if (parts.length > 2) {
          const weight = Number(asString(parts[2]).trim());
          if (Number.isFinite(weight) && weight > 0) task.weight = weight;
        }
        out.push(task);
        if (out.length >= MAX_TASKS) break;
      }
      return out;
    }

    /** Comma separated verification commands. */
    function parseVerify(text) {
      const out = [];
      const parts = asString(text).split(',');
      for (let i = 0; i < parts.length; i += 1) {
        const cmd = parts[i].trim();
        if (!cmd) continue;
        out.push(cmd);
        if (out.length >= MAX_VERIFY) break;
      }
      return out;
    }

    function formatTokens(value) {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0) return '';
      if (n >= 1000) {
        const k = n / 1000;
        return (k >= 100 ? Math.round(k) : Math.round(k * 10) / 10) + 'k';
      }
      return String(Math.round(n));
    }

    function shortenId(runId) {
      const id = asString(runId);
      if (id.length <= 10) return id;
      return id.slice(0, 8);
    }

    /* ------------------------------------------------------------------ *
     * Strings — Japanese built in (the dock speaks Japanese), overridable by
     * an optional default-locale service; locale/*.json mirror these keys.
     * ------------------------------------------------------------------ */

    const STRINGS_JA = {
      title: 'Fan-out',
      expand: '展開',
      collapse: '折りたたむ',
      workersLabel: '分岐セッション数',
      expansionLabel: '思考拡張',
      expansionOff: 'オフ',
      expansionShallow: '浅く1軸',
      expansionTri: '3軸',
      expansionFive: '5軸',
      expansionDeep: '8軸+分類ゲート',
      objectiveLabel: '目的',
      objectivePlaceholder: '例: 3つの大規模で非対称な作業を…',
      tasksLabel: 'タスク（任意）',
      tasksPlaceholder: '1行1件: title :: brief :: weight',
      tasksHint: '空欄なら自動分割',
      verifyLabel: '検証コマンド（任意・カンマ区切り）',
      verifyPlaceholder: '例: pnpm test, pnpm build',
      start: '開始',
      stop: '停止',
      refresh: '更新',
      connected: '接続済み',
      disconnected: '未接続（Host 側プラグインを確認）',
      idle: '実行なし',
      statusLabel: '状態',
      runLabel: '実行ID',
      settledLabel: '完了',
      failedLabel: '失敗',
      tokensLabel: '推定トークン',
      busyLabel: '通信中…',
      errorPrefix: 'エラー: ',
      objectiveRequired: '目的を入力してください',
      statusRunning: '実行中',
      statusIntegrating: '統合中',
      statusCompleted: '完了',
      statusStopped: '停止',
      statusFailed: '失敗',
      statusQueued: '待機中',
    };

    const STRINGS_EN = {
      title: 'Fan-out',
      expand: 'Expand',
      collapse: 'Collapse',
      workersLabel: 'Branch sessions',
      expansionLabel: 'Thought expansion',
      expansionOff: 'Off',
      expansionShallow: '1 shallow axis',
      expansionTri: '3 axes',
      expansionFive: '5 axes',
      expansionDeep: '8 axes + classification gate',
      objectiveLabel: 'Objective',
      objectivePlaceholder: 'e.g. three large, asymmetric jobs…',
      tasksLabel: 'Tasks (optional)',
      tasksPlaceholder: 'one per line: title :: brief :: weight',
      tasksHint: 'blank = auto-split',
      verifyLabel: 'Verify commands (optional, comma separated)',
      verifyPlaceholder: 'e.g. pnpm test, pnpm build',
      start: 'Start',
      stop: 'Stop',
      refresh: 'Refresh',
      connected: 'Connected',
      disconnected: 'Not connected (check the Host half)',
      idle: 'No run',
      statusLabel: 'Status',
      runLabel: 'Run',
      settledLabel: 'settled',
      failedLabel: 'failed',
      tokensLabel: 'est. tokens',
      busyLabel: 'Working…',
      errorPrefix: 'Error: ',
      objectiveRequired: 'Enter an objective first',
      statusRunning: 'running',
      statusIntegrating: 'integrating',
      statusCompleted: 'completed',
      statusStopped: 'stopped',
      statusFailed: 'failed',
      statusQueued: 'queued',
    };

    let activeStrings = STRINGS_JA;

    /** Copy only keys we know about, only when the override is a non-empty string. */
    function mergeDockStrings(target, override) {
      if (!isObject(override)) return target;
      const keys = Object.keys(target);
      for (let i = 0; i < keys.length; i += 1) {
        const key = keys[i];
        const value = override[key];
        if (typeof value === 'string' && value) target[key] = value;
      }
      return target;
    }

    /**
     * The dock defaults to Japanese (that is the product language for this
     * installation). A locale service, when the client exposes one, may
     * override individual strings through `dock` — see locale/*.json.
     */
    function resolveStrings(ctx) {
      const table = mergeDockStrings(Object.assign({}, STRINGS_JA), null);
      try {
        const locale = ctx && typeof ctx.get === 'function' ? ctx.get('locale') : null;
        if (isObject(locale)) {
          if (isObject(locale.dock)) mergeDockStrings(table, locale.dock);
          else if (isObject(locale.strings) && isObject(locale.strings.dock)) mergeDockStrings(table, locale.strings.dock);
          const language = asString(locale.language).toLowerCase();
          if (language.indexOf('ja') !== 0 && isObject(locale.en) && isObject(locale.en.dock)) {
            mergeDockStrings(table, locale.en.dock);
          }
        }
      } catch (err) {
        /* locale is optional: fall back to the built-in table */
      }
      return table;
    }

    function expansionCaptionOf(value) {
      const s = activeStrings;
      const v = clamp(value, MIN_EXPANSION, MAX_EXPANSION);
      if (v <= 0) return s.expansionOff;
      if (v <= 30) return s.expansionShallow;
      if (v <= 60) return s.expansionTri;
      if (v <= 85) return s.expansionFive;
      return s.expansionDeep;
    }

    function statusTextOf(raw) {
      const s = activeStrings;
      const value = asString(raw).toLowerCase();
      if (!value) return '';
      if (value === 'running' || value === 'active' || value.indexOf('run') === 0) return s.statusRunning;
      if (value === 'integrating') return s.statusIntegrating;
      if (value === 'completed' || value === 'complete' || value === 'done' || value === 'succeeded' || value === 'success') return s.statusCompleted;
      if (value === 'stopped' || value === 'cancelled' || value === 'canceled') return s.statusStopped;
      if (value === 'failed' || value === 'error') return s.statusFailed;
      if (value === 'pending' || value === 'queued' || value === 'waiting') return s.statusQueued;
      return asString(raw);
    }

    /* ------------------------------------------------------------------ *
     * Store + hub
     *
     * apply() owns the polling timer through ctx.effect; the component only
     * subscribes. The hub is module scoped so a re-apply (HMR / reload) hands
     * the component a fresh store without leaving a stale subscription.
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
            /* a broken listener must not break the others */
          }
        }
      }
      return {
        get() {
          return state;
        },
        set(patch) {
          if (!patch) return;
          let next = null;
          try {
            next = typeof patch === 'function' ? patch(state) : patch;
          } catch (err) {
            return;
          }
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

    function createEmptySnapshot() {
      return {
        token: null,
        connected: false,
        state: null,
        busy: false,
        error: null,
        expanded: true,
        lastRunId: null,
      };
    }

    const hub = {
      get() {
        return activeRuntime ? activeRuntime.store.get() : createEmptySnapshot();
      },
      subscribe(listener) {
        if (!activeRuntime) return function noop() {};
        return activeRuntime.store.subscribe(listener);
      },
    };

    /** Set by apply(); read lazily by the component so re-apply stays correct. */
    let activeRuntime = null;

    /* ------------------------------------------------------------------ *
     * Bridge (loopback JSON over HTTP)
     * ------------------------------------------------------------------ */

    function createBridge() {
      const port = Number(window.__DSH_FANOUT_PORT__) || DEFAULT_PORT;
      // Loopback listener is the documented carrier; `/fanout-api` is the same
      // handler mounted on the Web server (no CORS / no CSP connect-src risk).
      const loopbackBase = 'http://127.0.0.1:' + port;
      const sameOriginBase = '/fanout-api';
      let base = loopbackBase;
      let token = null;
      let configTimer = null;
      let pendingConfig = null;

      function withToken(hasBody) {
        const headers = { accept: 'application/json' };
        if (token) headers['x-fanout-token'] = token;
        if (hasBody) headers['content-type'] = 'application/json';
        return headers;
      }

      /**
       * One request, one result object. Never rejects: transport problems are
       * reported as `{ ok:false, error }` so callers decide what to show.
       */
      function request(path, body, timeoutMs) {
        if (typeof fetch !== 'function') {
          return Promise.resolve({ ok: false, error: 'fetch unavailable' });
        }
        const hasBody = body !== undefined;
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        let timer = null;
        if (controller) {
          timer = setTimeout(function abortNow() {
            try {
              controller.abort();
            } catch (err) {
              /* already settled */
            }
          }, timeoutMs || REQUEST_TIMEOUT_MS);
        }
        const init = { method: hasBody ? 'POST' : 'GET', headers: withToken(hasBody), cache: 'no-store' };
        if (hasBody) init.body = JSON.stringify(body);
        if (controller) init.signal = controller.signal;

        return fetch(base + path, init)
          .then(function onResponse(res) {
            return res
              .text()
              .catch(function onTextError() {
                return '';
              })
              .then(function onText(text) {
                let data = null;
                if (text) {
                  try {
                    data = JSON.parse(text);
                  } catch (err) {
                    data = null;
                  }
                }
                if (!res.ok) {
                  const message = isObject(data) && typeof data.error === 'string' ? data.error : 'HTTP ' + res.status;
                  return { ok: false, status: res.status, data: data, error: message };
                }
                return { ok: true, status: res.status, data: data };
              });
          })
          .catch(function onTransportError(err) {
            return { ok: false, status: 0, error: (err && err.message) || 'network error' };
          })
          .then(function finish(result) {
            if (timer) clearTimeout(timer);
            return result;
          });
      }

      function readToken(res) {
        if (res && res.ok && isObject(res.data) && typeof res.data.token === 'string' && res.data.token) {
          token = res.data.token;
          return true;
        }
        return false;
      }

      /**
       * `/health` is the unauthenticated bootstrap route. Try the loopback
       * listener first; if that is unreachable (port taken, CSP, Host not up
       * yet) fall back once to the same-origin carrier and stay there.
       */
      function health() {
        return request('/health', undefined, 3000).then(function onLoopback(res) {
          if (readToken(res)) return { ok: true, token: token, via: base };
          if (base !== loopbackBase) return { ok: false, error: res.error || 'health failed' };
          base = sameOriginBase;
          return request('/health', undefined, 3000).then(function onSameOrigin(alt) {
            if (readToken(alt)) return { ok: true, token: token, via: base };
            base = loopbackBase;
            return { ok: false, error: alt.error || res.error || 'health failed' };
          });
        });
      }

      function getState() {
        return request('/state', undefined, REQUEST_TIMEOUT_MS).then(function onState(res) {
          if (res.ok && isObject(res.data)) return { ok: true, data: res.data };
          return { ok: false, error: res.error || 'state failed' };
        });
      }

      function postConfig(config) {
        return request('/config', { workers: config.workers, expansion: config.expansion }, REQUEST_TIMEOUT_MS);
      }

      function postStart(payload) {
        return request('/start', payload, START_TIMEOUT_MS);
      }

      function postStop(runId) {
        const body = runId ? { run_id: runId } : {};
        return request('/stop', body, REQUEST_TIMEOUT_MS);
      }

      /** Slider moves are coalesced: last value wins, failures stay silent. */
      function scheduleConfig(config) {
        pendingConfig = { workers: config.workers, expansion: config.expansion };
        if (configTimer) clearTimeout(configTimer);
        configTimer = setTimeout(function flushConfig() {
          configTimer = null;
          const next = pendingConfig;
          pendingConfig = null;
          if (!next) return;
          postConfig(next).catch(function ignore() {
            /* persistence is best effort — never surface it to the user */
          });
        }, CONFIG_DEBOUNCE_MS);
      }

      function dispose() {
        if (configTimer) {
          clearTimeout(configTimer);
          configTimer = null;
        }
        pendingConfig = null;
      }

      return {
        base: base,
        health: health,
        getState: getState,
        scheduleConfig: scheduleConfig,
        start: postStart,
        stop: postStop,
        dispose: dispose,
      };
    }

    /* ------------------------------------------------------------------ *
     * Response normalisation — every field is shape checked
     * ------------------------------------------------------------------ */

    function normalizeRun(raw) {
      // The Host reports `estimate_tokens`; the tool-side name is `approx_tokens`.
      const tokens = Number.isFinite(Number(raw.estimate_tokens))
        ? Number(raw.estimate_tokens)
        : Number.isFinite(Number(raw.approx_tokens))
          ? Number(raw.approx_tokens)
          : null;
      return {
        run_id: asString(raw.run_id),
        status: asString(raw.status),
        total: asCount(raw.total),
        settled: asCount(raw.settled),
        failed: asCount(raw.failed),
        workers: Number.isFinite(Number(raw.workers)) ? Number(raw.workers) : null,
        approx_tokens: tokens,
        updated_at: asString(raw.updated_at),
      };
    }

    function normalizeState(raw) {
      const out = {
        config: { workers: DEFAULT_WORKERS, expansion: DEFAULT_EXPANSION },
        runs: [],
        active_run_id: '',
      };
      if (!isObject(raw)) return out;
      if (isObject(raw.config)) {
        if (raw.config.workers !== undefined) out.config.workers = clamp(raw.config.workers, MIN_WORKERS, MAX_WORKERS);
        if (raw.config.expansion !== undefined) out.config.expansion = clamp(raw.config.expansion, MIN_EXPANSION, MAX_EXPANSION);
      }
      if (Array.isArray(raw.runs)) {
        for (let i = 0; i < raw.runs.length; i += 1) {
          if (isObject(raw.runs[i])) out.runs.push(normalizeRun(raw.runs[i]));
        }
      }
      out.active_run_id = asString(raw.active_run_id);
      return out;
    }

    /** Active run first, then the run this dock started, then the newest one. */
    function pickRun(state, lastRunId) {
      if (!isObject(state)) return null;
      const runs = Array.isArray(state.runs) ? state.runs : [];
      const activeId = asString(state.active_run_id);
      if (activeId) {
        for (let i = 0; i < runs.length; i += 1) {
          if (runs[i] && runs[i].run_id === activeId) return runs[i];
        }
        return normalizeRun({ run_id: activeId, status: 'running' });
      }
      const hint = asString(lastRunId);
      if (hint) {
        for (let i = 0; i < runs.length; i += 1) {
          if (runs[i] && runs[i].run_id === hint) return runs[i];
        }
      }
      return runs.length ? runs[0] : null;
    }

    /* ------------------------------------------------------------------ *
     * Styles — theme tokens only, with hard fallbacks so a missing token can
     * never blank the dock out.
     * ------------------------------------------------------------------ */

    const T = {
      textPrimary: 'var(--dsw-alias-label-primary, currentColor)',
      textSecondary: 'var(--dsw-alias-label-secondary, currentColor)',
      textTertiary: 'var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary, currentColor))',
      border: 'var(--dsw-alias-border-l2, var(--dsw-alias-border-l1, currentColor))',
      borderSoft: 'var(--dsw-alias-border-l1, var(--dsw-alias-border-l2, currentColor))',
      surface: 'var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1, transparent))',
      surfaceSunken: 'var(--dsw-alias-bg-sunken, transparent)',
      brand: 'var(--dsw-alias-brand-primary, var(--dsw-alias-accent-primary, currentColor))',
      success: 'var(--dsw-alias-state-success-primary, var(--dsw-alias-brand-primary, currentColor))',
      danger: 'var(--dsw-alias-danger-primary, var(--dsw-alias-state-danger-primary, currentColor))',
      radius: 'var(--dsw-alias-radius-md, 8px)',
      radiusSm: 'var(--dsw-alias-radius-sm, 6px)',
      font: 'var(--dsw-alias-font-family, inherit)',
      fontMono: 'var(--dsw-alias-font-family-mono, ui-monospace, monospace)',
      sizeXs: 'var(--dsw-alias-font-size-xs, 11px)',
      sizeSm: 'var(--dsw-alias-font-size-sm, 12px)',
    };

    const S = {
      root: {
        fontFamily: T.font,
        fontSize: T.sizeSm,
        color: T.textPrimary,
        background: T.surface,
        border: '1px solid ' + T.borderSoft,
        borderRadius: T.radius,
        padding: '6px 10px',
        margin: '4px 0',
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        lineHeight: 1.45,
        boxSizing: 'border-box',
      },
      titleRow: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        minHeight: '20px',
      },
      title: {
        fontWeight: 600,
        fontSize: T.sizeSm,
        letterSpacing: '0.01em',
        color: T.textPrimary,
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
      },
      dot: {
        width: '8px',
        height: '8px',
        borderRadius: '50%',
        flex: '0 0 auto',
        display: 'inline-block',
      },
      muted: {
        color: T.textTertiary,
        fontSize: T.sizeXs,
        opacity: 0.9,
      },
      chip: {
        color: T.textSecondary,
        fontSize: T.sizeXs,
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        fontVariantNumeric: 'tabular-nums',
      },
      toggle: {
        marginLeft: 'auto',
        font: 'inherit',
        fontSize: T.sizeXs,
        color: T.textSecondary,
        background: 'transparent',
        border: '1px solid ' + T.borderSoft,
        borderRadius: T.radiusSm,
        padding: '1px 8px',
        cursor: 'pointer',
        lineHeight: 1.6,
      },
      body: {
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
      },
      sliderRow: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
      },
      sliderLabel: {
        flex: '0 0 auto',
        minWidth: '96px',
        color: T.textSecondary,
        fontSize: T.sizeXs,
      },
      slider: {
        flex: '1 1 auto',
        minWidth: '80px',
        accentColor: T.brand,
      },
      sliderValue: {
        flex: '0 0 auto',
        minWidth: '28px',
        textAlign: 'right',
        fontVariantNumeric: 'tabular-nums',
        color: T.textPrimary,
        fontSize: T.sizeXs,
      },
      caption: {
        color: T.textTertiary,
        fontSize: T.sizeXs,
        marginLeft: '104px',
        marginTop: '-4px',
      },
      field: {
        display: 'flex',
        flexDirection: 'column',
        gap: '2px',
      },
      fieldLabel: {
        color: T.textSecondary,
        fontSize: T.sizeXs,
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
      },
      textarea: {
        width: '100%',
        boxSizing: 'border-box',
        resize: 'vertical',
        font: 'inherit',
        fontSize: T.sizeSm,
        lineHeight: 1.4,
        color: T.textPrimary,
        background: T.surfaceSunken,
        border: '1px solid ' + T.borderSoft,
        borderRadius: T.radiusSm,
        padding: '4px 6px',
      },
      input: {
        width: '100%',
        boxSizing: 'border-box',
        font: 'inherit',
        fontSize: T.sizeSm,
        color: T.textPrimary,
        background: T.surfaceSunken,
        border: '1px solid ' + T.borderSoft,
        borderRadius: T.radiusSm,
        padding: '3px 6px',
      },
      actions: {
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        flexWrap: 'wrap',
      },
      button: {
        font: 'inherit',
        fontSize: T.sizeXs,
        color: T.textSecondary,
        background: 'transparent',
        border: '1px solid ' + T.borderSoft,
        borderRadius: T.radiusSm,
        padding: '2px 12px',
        cursor: 'pointer',
        lineHeight: 1.7,
      },
      buttonPrimary: {
        font: 'inherit',
        fontSize: T.sizeXs,
        fontWeight: 600,
        color: T.brand,
        background: 'transparent',
        border: '1px solid ' + T.brand,
        borderRadius: T.radiusSm,
        padding: '2px 14px',
        cursor: 'pointer',
        lineHeight: 1.7,
      },
      disabled: {
        opacity: 0.45,
        cursor: 'default',
      },
      status: {
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        flexWrap: 'wrap',
        color: T.textSecondary,
        fontSize: T.sizeXs,
        fontVariantNumeric: 'tabular-nums',
        minHeight: '14px',
      },
      statusKey: {
        color: T.textTertiary,
      },
      mono: {
        fontFamily: T.fontMono,
        fontSize: T.sizeXs,
        color: T.textPrimary,
      },
      error: {
        color: T.danger,
        opacity: 0.9,
        fontSize: T.sizeXs,
        wordBreak: 'break-word',
      },
    };

    function withDisabled(base, disabled) {
      return disabled ? Object.assign({}, base, S.disabled) : base;
    }

    /* ------------------------------------------------------------------ *
     * Rendering
     * ------------------------------------------------------------------ */

    function glyph(color) {
      return h(
        'svg',
        {
          width: 14,
          height: 14,
          viewBox: '0 0 24 24',
          'aria-hidden': 'true',
          focusable: 'false',
          style: { display: 'block', flex: '0 0 auto' },
        },
        [
          h('path', {
            key: 'tree',
            d: 'M5 12 H8 M8 12 C13 12 13 5 19 5 M8 12 H19 M8 12 C13 12 13 19 19 19',
            fill: 'none',
            stroke: color,
            strokeWidth: 1.6,
            strokeLinecap: 'round',
          }),
          h('circle', { key: 'root', cx: 5, cy: 12, r: 2.2, fill: color }),
          h('circle', { key: 'c1', cx: 19, cy: 5, r: 1.8, fill: color }),
          h('circle', { key: 'c2', cx: 19, cy: 12, r: 1.8, fill: color }),
          h('circle', { key: 'c3', cx: 19, cy: 19, r: 1.8, fill: color }),
        ],
      );
    }

    function sliderRow(opts) {
      return h('div', { style: S.sliderRow }, [
        h('span', { key: 'label', style: S.sliderLabel }, opts.label),
        h('input', {
          key: 'range',
          type: 'range',
          min: opts.min,
          max: opts.max,
          step: opts.step,
          value: opts.value,
          'aria-label': opts.label,
          style: S.slider,
          onChange: opts.onChange,
        }),
        h('span', { key: 'value', style: S.sliderValue }, String(opts.value)),
      ]);
    }

    function fieldBlock(label, control, hint) {
      const children = [h('span', { key: 'label', style: S.fieldLabel }, label)];
      if (hint) children.push(h('span', { key: 'hint', style: S.muted }, hint));
      children.push(h('div', { key: 'control' }, control));
      return h('div', { style: S.field }, children);
    }

    function statusPieces(run, s) {
      const pieces = [];
      if (!run) {
        pieces.push(h('span', { key: 'idle', style: S.statusKey }, s.idle));
        return pieces;
      }
      if (run.run_id) {
        pieces.push(
          h('span', { key: 'run' }, [
            h('span', { key: 'k', style: S.statusKey }, s.runLabel + ': '),
            h('span', { key: 'v', style: S.mono }, shortenId(run.run_id)),
          ]),
        );
      }
      if (run.status) {
        pieces.push(
          h('span', { key: 'status' }, [
            h('span', { key: 'k', style: S.statusKey }, s.statusLabel + ': '),
            h('span', { key: 'v' }, statusTextOf(run.status)),
          ]),
        );
      }
      pieces.push(
        h('span', { key: 'settled' }, [
          h('span', { key: 'k', style: S.statusKey }, s.settledLabel + ': '),
          h('span', { key: 'v' }, String(run.settled) + '/' + String(run.total)),
        ]),
      );
      if (run.failed > 0) {
        pieces.push(
          h('span', { key: 'failed' }, [
            h('span', { key: 'k', style: S.statusKey }, s.failedLabel + ': '),
            h('span', { key: 'v' }, String(run.failed)),
          ]),
        );
      }
      if (run.approx_tokens !== null && run.approx_tokens !== undefined) {
        const tokens = formatTokens(run.approx_tokens);
        if (tokens) {
          pieces.push(
            h('span', { key: 'tokens' }, [
              h('span', { key: 'k', style: S.statusKey }, s.tokensLabel + ': '),
              h('span', { key: 'v' }, tokens),
            ]),
          );
        }
      }
      return pieces;
    }

    function collapsedChip(run, s) {
      if (!run) return null;
      const parts = [];
      if (run.run_id) parts.push(shortenId(run.run_id));
      if (run.status) parts.push(statusTextOf(run.status));
      parts.push(String(run.settled) + '/' + String(run.total));
      return h('span', { key: 'chip', style: S.chip }, parts.join(' · '));
    }

    function renderDock(model) {
      const s = model.strings;
      const snap = model.snapshot;
      const connected = !!snap.connected;
      const busy = !!snap.busy;
      const error = asString(snap.error);
      const run = model.run;
      const canStart = connected && !busy;
      const canStop = connected && !busy;

      const dotColor = connected ? T.success : T.textTertiary;
      const titleRow = h('div', { key: 'title', style: S.titleRow }, [
        h('span', {
          key: 'dot',
          style: Object.assign({}, S.dot, { background: dotColor, opacity: connected ? 1 : 0.6 }),
          'aria-hidden': 'true',
        }),
        h('span', { key: 'name', style: S.title }, [glyph(T.brand), h('span', { key: 't' }, s.title)]),
        connected ? null : h('span', { key: 'conn', style: S.muted }, s.disconnected),
        model.collapsed ? collapsedChip(run, s) : null,
        busy ? h('span', { key: 'busy', style: S.muted }, s.busyLabel) : null,
        h(
          'button',
          {
            key: 'toggle',
            type: 'button',
            'aria-expanded': !model.collapsed,
            'aria-label': model.collapsed ? s.expand : s.collapse,
            title: model.collapsed ? s.expand : s.collapse,
            style: S.toggle,
            onClick: model.onToggle,
          },
          model.collapsed ? s.expand : s.collapse,
        ),
      ].filter(Boolean));

      const body = model.collapsed
        ? null
        : h('div', { key: 'body', style: S.body }, [
            sliderRow({
              key: 'workers',
              label: s.workersLabel,
              min: MIN_WORKERS,
              max: MAX_WORKERS,
              step: 1,
              value: model.workers,
              onChange: model.onWorkers,
            }),
            h('div', { key: 'expansion' }, [
              sliderRow({
                key: 'range',
                label: s.expansionLabel,
                min: MIN_EXPANSION,
                max: MAX_EXPANSION,
                step: 1,
                value: model.expansion,
                onChange: model.onExpansion,
              }),
              h('div', { key: 'caption', style: S.caption }, expansionCaptionOf(model.expansion)),
            ]),
            fieldBlock(
              s.objectiveLabel,
              h('textarea', {
                rows: 2,
                value: model.objective,
                placeholder: s.objectivePlaceholder,
                'aria-label': s.objectiveLabel,
                style: S.textarea,
                onChange: model.onObjective,
              }),
            ),
            fieldBlock(
              s.tasksLabel,
              h('textarea', {
                rows: 2,
                value: model.tasksText,
                placeholder: s.tasksPlaceholder,
                'aria-label': s.tasksLabel,
                style: S.textarea,
                onChange: model.onTasks,
              }),
              s.tasksHint,
            ),
            fieldBlock(
              s.verifyLabel,
              h('input', {
                type: 'text',
                value: model.verifyText,
                placeholder: s.verifyPlaceholder,
                'aria-label': s.verifyLabel,
                style: S.input,
                onChange: model.onVerify,
              }),
            ),
            h('div', { key: 'actions', style: S.actions }, [
              h(
                'button',
                {
                  key: 'start',
                  type: 'button',
                  style: withDisabled(S.buttonPrimary, !canStart),
                  disabled: !canStart,
                  onClick: model.onStart,
                },
                s.start,
              ),
              h(
                'button',
                {
                  key: 'stop',
                  type: 'button',
                  style: withDisabled(S.button, !canStop),
                  disabled: !canStop,
                  onClick: model.onStop,
                },
                s.stop,
              ),
              h(
                'button',
                {
                  key: 'refresh',
                  type: 'button',
                  style: withDisabled(S.button, busy),
                  disabled: busy,
                  onClick: model.onRefresh,
                },
                s.refresh,
              ),
            ]),
          ]);

      const statusLine = model.collapsed
        ? null
        : h('div', { key: 'status', style: S.status, 'aria-live': 'polite' }, statusPieces(run, s));

      const errorLine = error
        ? h('div', { key: 'error', style: S.error, role: 'status' }, s.errorPrefix + error)
        : null;

      return h(
        'div',
        { style: S.root, 'data-fanout-dock': '1', role: 'group', 'aria-label': s.title },
        [titleRow, body, statusLine, errorLine].filter(Boolean),
      );
    }

    /* ------------------------------------------------------------------ *
     * Component
     * ------------------------------------------------------------------ */

    /** The dock is normally mounted with `sessionId`; accept a branded object too. */
    function readSessionId(props) {
      if (!isObject(props)) return '';
      const raw = props.sessionId;
      if (typeof raw === 'string') return raw;
      if (isObject(raw) && typeof raw.id === 'string') return raw.id;
      return '';
    }

    function useDockModel(props) {
      const sessionId = readSessionId(props);
      const [snapshot, setSnapshot] = useState(function initialSnapshot() {
        return hub.get();
      });
      const [collapsed, setCollapsed] = useState(false);
      const [workers, setWorkers] = useState(DEFAULT_WORKERS);
      const [expansion, setExpansion] = useState(DEFAULT_EXPANSION);
      const [objective, setObjective] = useState('');
      const [tasksText, setTasksText] = useState('');
      const [verifyText, setVerifyText] = useState('');
      const hydrated = useRef(false);
      const touched = useRef(false);

      useEffect(function subscribeHub() {
        return hub.subscribe(function onStoreChange() {
          setSnapshot(hub.get());
        });
      }, []);

      const state = isObject(snapshot.state) ? snapshot.state : null;

      useEffect(
        function hydrateFromConfig() {
          if (hydrated.current || touched.current) return;
          const config = state && isObject(state.config) ? state.config : null;
          if (!config) return;
          hydrated.current = true;
          setWorkers(clamp(config.workers, MIN_WORKERS, MAX_WORKERS));
          setExpansion(clamp(config.expansion, MIN_EXPANSION, MAX_EXPANSION));
        },
        [state],
      );

      useEffect(
        function mirrorExpanded() {
          if (!activeRuntime) return;
          activeRuntime.store.set({ expanded: !collapsed });
        },
        [collapsed],
      );

      function saveConfig(nextWorkers, nextExpansion) {
        const rt = activeRuntime;
        if (!rt) return;
        rt.saveConfig({ workers: clamp(nextWorkers, MIN_WORKERS, MAX_WORKERS), expansion: clamp(nextExpansion, MIN_EXPANSION, MAX_EXPANSION) });
      }

      const onWorkers = function onWorkers(event) {
        const raw = Number(event && event.target ? event.target.value : workers);
        const next = clamp(Number.isFinite(raw) ? raw : workers, MIN_WORKERS, MAX_WORKERS);
        touched.current = true;
        setWorkers(next);
        saveConfig(next, expansion);
      };

      const onExpansion = function onExpansion(event) {
        const raw = Number(event && event.target ? event.target.value : expansion);
        const next = clamp(Number.isFinite(raw) ? raw : expansion, MIN_EXPANSION, MAX_EXPANSION);
        touched.current = true;
        setExpansion(next);
        saveConfig(workers, next);
      };

      const run = pickRun(state, snapshot.lastRunId);

      const onToggle = function onToggle() {
        setCollapsed(function flip(previous) {
          return !previous;
        });
      };

      const onStart = function onStart() {
        const rt = activeRuntime;
        if (!rt) return;
        const text = asString(objective).trim();
        if (!text) {
          rt.reportError(activeStrings.objectiveRequired);
          return;
        }
        const tasks = parseTasks(tasksText);
        const verify = parseVerify(verifyText);
        const payload = {
          objective: text,
          workers: clamp(workers, MIN_WORKERS, MAX_WORKERS),
          expansion: clamp(expansion, MIN_EXPANSION, MAX_EXPANSION),
        };
        if (tasks.length) payload.tasks = tasks;
        if (verify.length) payload.verify = verify;
        // Without this the Host cannot address the follow-up summary at the caller.
        if (sessionId) payload.session_id = sessionId;
        rt.start(payload)
          .then(function afterStart(result) {
            if (result && result.ok) setCollapsed(true);
          })
          .catch(function ignore() {
            /* runtime already recorded the failure */
          });
      };

      const onStop = function onStop() {
        const rt = activeRuntime;
        if (!rt) return;
        const runId = run && run.run_id ? run.run_id : '';
        rt.stop(runId).catch(function ignore() {
          /* runtime already recorded the failure */
        });
      };

      const onRefresh = function onRefresh() {
        const rt = activeRuntime;
        if (!rt) return;
        rt.refreshAll().catch(function ignore() {
          /* runtime already recorded the failure */
        });
      };

      return {
        snapshot: snapshot,
        collapsed: collapsed,
        workers: workers,
        expansion: expansion,
        objective: objective,
        tasksText: tasksText,
        verifyText: verifyText,
        run: run,
        strings: activeStrings,
        onToggle: onToggle,
        onWorkers: onWorkers,
        onExpansion: onExpansion,
        onObjective: function onObjective(event) {
          setObjective(event && event.target ? String(event.target.value) : '');
        },
        onTasks: function onTasks(event) {
          setTasksText(event && event.target ? String(event.target.value) : '');
        },
        onVerify: function onVerify(event) {
          setVerifyText(event && event.target ? String(event.target.value) : '');
        },
        onStart: onStart,
        onStop: onStop,
        onRefresh: onRefresh,
      };
    }

    function FanoutDock(props) {
      const model = useDockModel(props);
      try {
        return renderDock(model);
      } catch (err) {
        // A render fault must never take the surrounding input area down.
        return null;
      }
    }

    /* ------------------------------------------------------------------ *
     * apply
     * ------------------------------------------------------------------ */

    function apply(ctx) {
      activeStrings = resolveStrings(ctx);

      const bridge = createBridge();
      const store = createStore(createEmptySnapshot());

      function refreshState(silent) {
        return bridge.getState().then(function onState(result) {
          if (result.ok) {
            store.set({
              state: normalizeState(result.data),
              connected: true,
              error: silent ? store.get().error : null,
            });
            return { ok: true };
          }
          store.set({ connected: false });
          if (!silent) store.set({ error: result.error || 'state failed' });
          return { ok: false, error: result.error };
        });
      }

      function connect() {
        return bridge.health().then(function onHealth(result) {
          if (result.ok) {
            store.set({ token: result.token, connected: true });
            return { ok: true };
          }
          store.set({ connected: false });
          return { ok: false, error: result.error };
        });
      }

      const runtime = {
        store: store,
        bridge: bridge,
        strings: activeStrings,
        saveConfig: function saveConfig(config) {
          if (!isObject(config)) return;
          bridge.scheduleConfig({
            workers: clamp(config.workers, MIN_WORKERS, MAX_WORKERS),
            expansion: clamp(config.expansion, MIN_EXPANSION, MAX_EXPANSION),
          });
        },
        reportError: function reportError(message) {
          store.set({ error: asString(message) || 'error' });
        },
        refreshState: refreshState,
        refreshAll: function refreshAll() {
          store.set({ busy: true, error: null });
          return connect()
            .then(function afterConnect(result) {
              if (!result.ok) {
                store.set({ busy: false, error: activeStrings.disconnected });
                return { ok: false };
              }
              return refreshState(false).then(function afterState(stateResult) {
                store.set({ busy: false, error: stateResult.ok ? null : stateResult.error || 'state failed' });
                return stateResult;
              });
            })
            .catch(function onRefreshFailure() {
              store.set({ busy: false, error: activeStrings.disconnected });
              return { ok: false };
            });
        },
        start: function start(payload) {
          store.set({ busy: true, error: null });
          return bridge
            .start(payload)
            .then(function afterStart(result) {
              const data = isObject(result.data) ? result.data : null;
              if (result.ok && data && data.ok !== false && typeof data.run_id === 'string' && data.run_id) {
                store.set({ busy: false, error: null, lastRunId: data.run_id });
                return refreshState(true).then(function afterRefresh() {
                  return { ok: true, runId: data.run_id };
                });
              }
              const message = (data && typeof data.error === 'string' ? data.error : '') || result.error || 'start failed';
              store.set({ busy: false, error: message });
              return { ok: false, error: message };
            })
            .catch(function onStartFailure(err) {
              const message = (err && err.message) || 'start failed';
              store.set({ busy: false, error: message });
              return { ok: false, error: message };
            });
        },
        stop: function stop(runId) {
          store.set({ busy: true, error: null });
          return bridge
            .stop(asString(runId))
            .then(function afterStop(result) {
              store.set({ busy: false, error: result.ok ? null : result.error || 'stop failed' });
              if (!result.ok) return { ok: false, error: result.error };
              return refreshState(true).then(function afterRefresh() {
                return { ok: true };
              });
            })
            .catch(function onStopFailure(err) {
              const message = (err && err.message) || 'stop failed';
              store.set({ busy: false, error: message });
              return { ok: false, error: message };
            });
        },
        dispose: function dispose() {
          bridge.dispose();
        },
      };

      activeRuntime = runtime;

      // Timers live inside ctx.effect so disabling the plugin leaves nothing behind.
      try {
        ctx.effect(function startBridgeLoop() {
          let alive = true;

          const tick = function tick() {
            if (!alive) return;
            const snapshot = store.get();
            if (!snapshot.connected) {
              // The Host may start (or restart) after the panel mounted: keep trying.
              connect()
                .then(function afterConnect(result) {
                  if (result.ok) return refreshState(true);
                  return null;
                })
                .catch(function ignore() {
                  /* still disconnected; the next tick retries */
                });
              return;
            }
            // Idle + collapsed: no visible status to refresh, so stay quiet.
            if (!snapshot.expanded && !snapshot.lastRunId) return;
            refreshState(true).catch(function ignore() {
              /* poll failures only flip `connected` */
            });
          };

          connect()
            .then(function afterConnect(result) {
              if (!alive || !result.ok) return;
              store.set({ connected: true });
              return refreshState(true);
            })
            .catch(function ignoreConnect() {
              /* stays "not connected" until a later poll succeeds */
            });

          const interval = setInterval(tick, POLL_MS);

          return function stopBridgeLoop() {
            alive = false;
            if (interval) clearInterval(interval);
            runtime.dispose();
          };
        });
      } catch (err) {
        // No effect capability: still attempt a single refresh so the dock is usable.
        connect()
          .then(function afterConnect(result) {
            if (result.ok) return refreshState(true);
            return null;
          })
          .catch(function ignore() {});
      }

      try {
        ctx.slots.inject(SLOT_NAME, function injectDock() {
          return ctx.slots.register({ name: SLOT_NAME, id: REGISTRATION_ID, order: REGISTRATION_ORDER }, FanoutDock);
        });
      } catch (err) {
        try {
          console.warn('[dsh-fanout] dock registration failed:', String((err && err.message) || err));
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

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
    // A checkout writes the whole tree; the worktree service allows five minutes
    // per Git command, so the request budget matches rather than racing it.
    const WORKTREE_TIMEOUT_MS = 300000;

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
      armLabel: 'Fan-out',
      armHint: 'チェックすると、この指示を親セッションが分割実行します',
      armHelp:
        'このプロンプトを fan-out で実行します（fan-out が負ける指示は自動で単一セッション実行になります）',
      teamLabel: 'エージェント連携',
      teamHint:
        '共有タスクボードで複数のエージェントの分担と進捗を調整します。複雑なタスクでより良い結果が得られますが、その分トークンのコストも高くなります',
      teamOn: '有効',
      teamOff: '無効',
      teamUnavailable: 'この構成では利用できません',
      teamEmpty: '共有タスクはまだありません',
      teamTasksLabel: '共有タスク',
      worktreeLabel: 'ワークツリー',
      worktreeHint:
        'このセッションを専用のワークツリーへ移します。指定した基点から新しいブランチを作成するため、変更やコミットはプロジェクトディレクトリに影響しません',
      worktreeBasePlaceholder: '基点（ブランチ/タグ/コミット・空なら HEAD）',
      worktreeCreate: 'ワークツリーで続ける',
      worktreeBusy: '作成中…',
      worktreeUnavailable: 'この構成では利用できません',
      worktreeDone: '移動しました',
      modeLabel: '割り当て',
      modeAuto: '自動（親が決定）',
      modeManual: '手動',
      autoNote:
        '親セッションが分岐セッション数と思考拡張を自分で決めます（必要量＋余分）。狭い・連鎖的な指示は自動で単一セッションに切り替わります。',
      manualNote: '下の2つの値をそのまま使います。狭い・連鎖的な指示でも単一セッションへは切り替えません。',
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

      // --- sidebar progress board ---
      panelTitle: 'Fan-out 進捗',
      panelSubtitle: '分割したチームの進み具合',
      panelNavLabel: 'Fan-out',
      panelEmpty: 'まだ分割した実行はありません。',
      panelEmptyHint: 'コンポーザー下の Fan-out から目的を入れて開始すると、ここに進捗が出ます。',
      panelActiveLabel: 'いま実行中',
      panelRecentLabel: '直近の実行',
      panelRunningCount: '実行中',
      panelWorkersLabel: 'ワーカー',
      panelIntegratingLabel: '統合',
      panelElapsedLabel: '経過',
      panelStageWorkers: '分岐実行',
      panelStageIntegrating: '統合',
      panelStageDone: '完了',
      panelStageFailed: '失敗',
      panelStageStopped: '停止',
      panelWorkerRunning: '実行中',
      panelWorkerPending: '待機',
      panelWorkerSettled: '完了',
      panelWorkerFailed: '失敗',
      panelWorkerStopped: '停止',
      panelIntegratorIdle: '待機',
      panelIntegratorRunning: '実行中',
      panelIntegratorSettled: '完了',
      panelIntegratorFailed: '失敗',
      panelPercentLegend: 'ワーカー完了で85%、統合で残り15%',
      panelFinalReport: '統合レポート',
      panelTaskCount: '件',
      panelNoTasks: 'タスクなし',
      panelTruncated: '直近8件のみ表示',
      takeoverTitle: 'ファンアウト',
      takeoverHint:
        '入力窓はファンアウト用に切り替わっています。目的を書いてください。このセッションが単一の親として、進行中の実行に追加するか新規に立てるかを判断します。',
      takeoverRunning: '実行中',
      takeoverIdle: '実行なし',
      takeoverRoot: '親',
      takeoverDisarm: '入力に戻す',
      sessionMarkRoot: 'ファンアウトの親セッション',
      sessionMarkWorker: 'ファンアウトのワーカーセッション',
    };

    const STRINGS_EN = {
      title: 'Fan-out',
      expand: 'Expand',
      collapse: 'Collapse',
      armLabel: 'Fan-out',
      armHint: 'Checked: the parent session splits this prompt across workers',
      armHelp:
        'Run this prompt as a fan-out (requests that fan-out would lose fall back to a single session automatically)',
      modeLabel: 'Allocation',
      modeAuto: 'Auto (parent decides)',
      modeManual: 'Manual',
      autoNote:
        'The parent session decides the branch count and thought expansion itself — what the job needs, plus headroom. Narrow or chained requests fall back to a single session automatically.',
      manualNote: 'Use exactly the two dials below; no automatic single-session fallback.',
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

      // --- sidebar progress board ---
      panelTitle: 'Fan-out progress',
      panelSubtitle: 'How far the split team has got',
      panelNavLabel: 'Fan-out',
      panelEmpty: 'No fan-out run yet.',
      panelEmptyHint: 'Start one from the Fan-out bar under the composer and its progress appears here.',
      panelActiveLabel: 'Running now',
      panelRecentLabel: 'Recent runs',
      panelRunningCount: 'running',
      panelWorkersLabel: 'workers',
      panelIntegratingLabel: 'integrator',
      panelElapsedLabel: 'elapsed',
      panelStageWorkers: 'Workers',
      panelStageIntegrating: 'Integrate',
      panelStageDone: 'Done',
      panelStageFailed: 'Failed',
      panelStageStopped: 'Stopped',
      panelWorkerRunning: 'running',
      panelWorkerPending: 'queued',
      panelWorkerSettled: 'done',
      panelWorkerFailed: 'failed',
      panelWorkerStopped: 'stopped',
      panelIntegratorIdle: 'waiting',
      panelIntegratorRunning: 'running',
      panelIntegratorSettled: 'done',
      panelIntegratorFailed: 'failed',
      panelPercentLegend: 'workers = 85%, integration = the last 15%',
      panelFinalReport: 'Integrated report',
      panelTaskCount: 'tasks',
      panelNoTasks: 'no tasks',
      panelTruncated: 'newest 8 shown',
      takeoverTitle: 'Fan-out',
      takeoverHint:
        'The input is armed for fan-out. Describe the objective: this session stays the single parent and decides whether to extend a live run or start a new one.',
      takeoverRunning: 'run active',
      takeoverIdle: 'no run yet',
      takeoverRoot: 'parent',
      takeoverDisarm: 'Back to input',
      sessionMarkRoot: 'fan-out parent session',
      sessionMarkWorker: 'fan-out worker session',
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

      function getState(sessionId) {
        // The composer checkbox is per session, so the state fetch names it and
        // the Host answers with this session's arming.
        const suffix =
          typeof sessionId === 'string' && sessionId.length > 0
            ? '?session_id=' + encodeURIComponent(sessionId)
            : '';
        return request('/state' + suffix, undefined, REQUEST_TIMEOUT_MS).then(function onState(res) {
          if (res.ok && isObject(res.data)) return { ok: true, data: res.data };
          return { ok: false, error: res.error || 'state failed' };
        });
      }

      function postConfig(config) {
        return request('/config', { workers: config.workers, expansion: config.expansion }, REQUEST_TIMEOUT_MS);
      }

      /**
       * Arm or disarm fan-out for one session. The Host holds the flag, not this
       * component, so a reload of the page cannot lose an intent the user set.
       */
      function postArm(payload) {
        return request('/arm', payload, REQUEST_TIMEOUT_MS);
      }

      function postStart(payload) {
        return request('/start', payload, START_TIMEOUT_MS);
      }

      function postStop(runId) {
        const body = runId ? { run_id: runId } : {};
        return request('/stop', body, REQUEST_TIMEOUT_MS);
      }

      /**
       * Team mode and its board. The panel is their only surface, so a failed
       * read stays a failure: it never turns into a silent "off" the user could
       * mistake for the saved selection.
       */
      function getTeam(sessionId) {
        const suffix =
          typeof sessionId === 'string' && sessionId.length > 0
            ? '?session_id=' + encodeURIComponent(sessionId)
            : '';
        return request('/team' + suffix, undefined, REQUEST_TIMEOUT_MS).then(function onTeam(res) {
          const data = isObject(res.data) ? res.data : null;
          if (res.ok && data && data.ok !== false) return { ok: true, data: data };
          const message = (data && typeof data.error === 'string' ? data.error : '') || res.error || 'team failed';
          return { ok: false, error: message };
        });
      }

      function postTeam(sessionId, enabled) {
        return request('/team', { session_id: sessionId, enabled: !!enabled }, REQUEST_TIMEOUT_MS).then(
          function onTeamWrite(res) {
            const data = isObject(res.data) ? res.data : null;
            if (res.ok && data && data.ok !== false) return { ok: true, data: data };
            const message = (data && typeof data.error === 'string' ? data.error : '') || res.error || 'team failed';
            return { ok: false, error: message };
          },
        );
      }

      /**
       * Checkout creation is the one slow route: writing a large tree can take
       * minutes, so it gets its own budget instead of the shared request one.
       */
      function getWorktree() {
        return request('/worktree', undefined, REQUEST_TIMEOUT_MS).then(function onWorktree(res) {
          const data = isObject(res.data) ? res.data : null;
          if (res.ok && data && data.ok !== false) return { ok: true, data: data };
          return { ok: false, error: 'worktree status failed' };
        });
      }

      function postWorktree(sessionId, from) {
        return request(
          '/worktree',
          { session_id: sessionId, from: asString(from) },
          WORKTREE_TIMEOUT_MS,
        ).then(function onWorktreeCreate(res) {
          const data = isObject(res.data) ? res.data : null;
          if (res.ok && data && data.ok !== false) return { ok: true, data: data };
          const message = (data && typeof data.error === 'string' ? data.error : '') || res.error || 'worktree failed';
          return { ok: false, error: message };
        });
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
        arm: postArm,
        start: postStart,
        stop: postStop,
        getTeam: getTeam,
        setTeam: postTeam,
        getWorktree: getWorktree,
        createWorktree: postWorktree,
        dispose: dispose,
      };
    }

    /* ------------------------------------------------------------------ *
     * Response normalisation — every field is shape checked
     * ------------------------------------------------------------------ */

    /** One worker as the progress board shows it; unknown shapes become empty. */
    function normalizeWorker(raw) {
      const source = isObject(raw) ? raw : {};
      const tasks = Array.isArray(source.tasks) ? source.tasks : [];
      const detail = [];
      for (let i = 0; i < tasks.length; i += 1) {
        if (!isObject(tasks[i])) continue;
        detail.push({ id: asString(tasks[i].id), title: asString(tasks[i].title) });
      }
      return {
        index: asCount(source.index),
        state: asString(source.state),
        summary: asString(source.summary),
        tasks: detail,
      };
    }

    function normalizeRun(raw) {
      // The Host reports `estimate_tokens`; the tool-side name is `approx_tokens`.
      const tokens = Number.isFinite(Number(raw.estimate_tokens))
        ? Number(raw.estimate_tokens)
        : Number.isFinite(Number(raw.approx_tokens))
          ? Number(raw.approx_tokens)
          : null;
      const percent = Number(raw.percent);
      return {
        run_id: asString(raw.run_id),
        status: asString(raw.status),
        total: asCount(raw.total),
        settled: asCount(raw.settled),
        failed: asCount(raw.failed),
        workers: Number.isFinite(Number(raw.workers)) ? Number(raw.workers) : null,
        approx_tokens: tokens,
        updated_at: asString(raw.updated_at),
        // Progress board (Host ≥ 0.2.0). An older Host sends none of these, and
        // the board then derives the same numbers from total/settled/status —
        // so keep them undefined rather than inventing 0.
        percent: Number.isFinite(percent) ? percent : undefined,
        phase: asString(raw.phase),
        integrator_state: asString(raw.integrator_state),
        created_at: asString(raw.created_at),
        objective: asString(raw.objective),
        final_path: asString(raw.final_path),
        integrate: raw.integrate !== false,
        error: asString(raw.error),
        worker_details: Array.isArray(raw.worker_details) ? raw.worker_details.map(normalizeWorker) : [],
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
     * Styles — theme tokens only, each with a currentColor/transparent
     * fallback. The fallback is a safety net, NOT a licence to guess a token
     * name: two guessed names silently cost the old panel its input fill and
     * its error colour (see the note above `T`).
     * ------------------------------------------------------------------ */

    /**
     * Tokens verified against the live theme (client inspect: Theme.listTokens):
     * bg-base, bg-layer-1/2, border-l1/l2, brand-primary,
     * label-primary/secondary/caption/tertiary,
     * state-{success,error,warn,idle}-primary, and no font-size/radius aliases.
     *
     * Two previously used tokens do NOT exist in this theme:
     *   --dsw-alias-bg-sunken     -> inputs silently rendered transparent
     *   --dsw-alias-danger-primary -> errors silently rendered in currentColor
     * Both are replaced below by real tokens.
     */
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

    // No font-size / radius tokens exist in this theme, so sizes are literal px.
    const FS = { title: 13, body: 12, small: 11, tiny: 10.5 };

    const S = {
      // Team row: one switch owns the whole feature, so it stays a plain
      // checkbox with the state spelled out beside it rather than a toggle pill.
      teamRow: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '4px 0',
        borderTop: '1px solid ' + T.borderL1,
        marginTop: 2,
      },
      teamName: { fontSize: FS.body, color: T.labelPrimary, whiteSpace: 'nowrap' },
      teamState: { fontSize: FS.small, color: T.labelCaption, whiteSpace: 'nowrap' },
      teamList: { listStyle: 'none', margin: '2px 0 0', padding: 0, display: 'grid', gap: 2 },
      teamItem: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 },
      teamDot: { width: 6, height: 6, borderRadius: 3, flex: '0 0 auto', background: T.idle },
      teamSubject: {
        fontSize: FS.small,
        color: T.labelSecondary,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      teamOwner: { fontSize: FS.tiny, color: T.labelCaption, whiteSpace: 'nowrap', marginLeft: 'auto' },
      wtRow: {
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 0',
        borderTop: '1px solid ' + T.borderL1,
        marginTop: 2,
      },
      wtInput: {
        flex: 1,
        minWidth: 0,
        font: 'inherit',
        fontSize: FS.small,
        color: T.labelPrimary,
        background: T.bgBase,
        border: '1px solid ' + T.borderL1,
        borderRadius: 6,
        padding: '3px 7px',
      },
      wtNote: { fontSize: FS.small, color: T.success, wordBreak: 'break-all', marginTop: 2 },
      root: {
        fontFamily: 'inherit',
        fontSize: FS.body,
        color: T.labelPrimary,
        background: T.bgLayer1,
        border: '1px solid ' + T.borderL1,
        borderRadius: 10,
        padding: '9px 11px',
        margin: '4px 0',
        width: '100%',
        // Without a cap the form stretches to the full composer width and every
        // control drifts hundreds of pixels away from its own label.
        maxWidth: 860,
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        lineHeight: 1.5,
      },
      titleRow: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        flexWrap: 'wrap',
        minHeight: 22,
      },
      identity: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        minWidth: 0,
        flex: '0 1 auto',
      },
      dot: {
        width: 8,
        height: 8,
        borderRadius: '50%',
        flex: '0 0 auto',
        display: 'inline-block',
      },
      title: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        fontWeight: 600,
        fontSize: FS.title,
        letterSpacing: '0.01em',
        color: T.labelPrimary,
        whiteSpace: 'nowrap',
      },
      statusGroup: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        flexWrap: 'wrap',
        marginLeft: 'auto',
        fontSize: FS.small,
        color: T.labelSecondary,
        fontVariantNumeric: 'tabular-nums',
        lineHeight: 1.5,
      },
      statusDot: {
        width: 6,
        height: 6,
        borderRadius: '50%',
        flex: '0 0 auto',
        display: 'inline-block',
      },
      statusValue: {
        color: T.labelPrimary,
        fontWeight: 500,
      },
      sep: {
        color: T.labelCaption,
      },
      muted: {
        color: T.labelCaption,
        fontSize: FS.small,
      },
      toggle: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        marginLeft: 2,
        font: 'inherit',
        fontSize: FS.small,
        color: T.labelSecondary,
        background: 'transparent',
        border: '1px solid ' + T.borderL1,
        borderRadius: 6,
        padding: '2px 8px',
        cursor: 'pointer',
        lineHeight: 1.6,
        whiteSpace: 'nowrap',
      },
      chevron: {
        display: 'inline-block',
        width: 8,
        textAlign: 'center',
      },
      /* ---- Composer checkbox that morphs into the panel -------------------
         One element, two shapes: a compact checkbox row while disarmed, and the
         same row with the settings unfolded beneath it. The body is always
         mounted and its height animates through `grid-template-rows: 0fr → 1fr`,
         which morphs to the real content height instead of a guessed max-height. */
      armRow: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        minHeight: 24,
        cursor: 'pointer',
        userSelect: 'none',
        borderRadius: 8,
        padding: '2px 6px',
        margin: '-2px -6px',
        transition: 'background-color 180ms ease, box-shadow 180ms ease',
      },
      armRowOn: {
        background: T.bgLayer2,
        boxShadow: 'inset 0 0 0 1px ' + T.brandBorder,
      },
      checkbox: {
        width: 14,
        height: 14,
        margin: 0,
        accentColor: T.brand,
        cursor: 'pointer',
        flex: '0 0 auto',
      },
      armLabel: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        fontWeight: 600,
        fontSize: FS.title,
        letterSpacing: '0.01em',
        color: T.labelPrimary,
        whiteSpace: 'nowrap',
        transition: 'color 180ms ease',
      },
      armHint: {
        color: T.labelCaption,
        fontSize: FS.small,
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        transition: 'opacity 180ms ease',
      },
      morph: {
        display: 'grid',
        gridTemplateRows: '0fr',
        opacity: 0,
        visibility: 'hidden',
        transition:
          'grid-template-rows 260ms cubic-bezier(0.22, 0.61, 0.36, 1), opacity 180ms ease, visibility 0s linear 260ms',
      },
      morphOpen: {
        gridTemplateRows: '1fr',
        opacity: 1,
        visibility: 'visible',
        transition:
          'grid-template-rows 260ms cubic-bezier(0.22, 0.61, 0.36, 1), opacity 180ms ease, visibility 0s linear 0s',
      },
      morphInner: {
        overflow: 'hidden',
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      },
      modeRow: {
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        flexWrap: 'wrap',
      },
      modeBtn: {
        font: 'inherit',
        fontSize: FS.small,
        color: T.labelSecondary,
        background: 'transparent',
        border: '1px solid ' + T.borderL1,
        borderRadius: 999,
        padding: '3px 11px',
        cursor: 'pointer',
        lineHeight: 1.6,
        whiteSpace: 'nowrap',
      },
      modeBtnOn: {
        color: T.brandText,
        background: T.brandSoft,
        borderColor: T.brandBorder,
        fontWeight: 600,
      },
      note: {
        color: T.labelCaption,
        fontSize: FS.small,
        lineHeight: 1.55,
      },
      body: {
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      },
      /* Two sliders side by side: halves the vertical run and keeps each value
         badge next to its own label instead of at the far right of the panel. */
      params: {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
        gap: '8px 16px',
        background: T.bgLayer2,
        border: '1px solid ' + T.borderL1,
        borderRadius: 8,
        padding: '8px 10px',
      },
      param: {
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        minWidth: 0,
      },
      paramHead: {
        display: 'flex',
        alignItems: 'baseline',
        gap: 6,
        minWidth: 0,
      },
      paramLabel: {
        fontSize: FS.small,
        color: T.labelSecondary,
        whiteSpace: 'nowrap',
      },
      badge: {
        fontSize: FS.tiny,
        lineHeight: '15px',
        color: T.labelSecondary,
        background: T.bgLayer1,
        border: '1px solid ' + T.borderL2,
        borderRadius: 999,
        padding: '0 6px',
        whiteSpace: 'nowrap',
      },
      paramValue: {
        marginLeft: 'auto',
        fontSize: FS.title,
        fontWeight: 600,
        color: T.labelPrimary,
        fontVariantNumeric: 'tabular-nums',
        minWidth: '2ch',
        textAlign: 'right',
      },
      slider: {
        width: '100%',
        minWidth: 0,
        margin: 0,
        height: 18,
        accentColor: T.brand,
        cursor: 'pointer',
      },
      fields: {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
        gap: '8px 12px',
      },
      field: {
        display: 'flex',
        flexDirection: 'column',
        gap: 3,
        minWidth: 0,
      },
      fieldWide: {
        gridColumn: '1 / -1',
      },
      fieldHead: {
        display: 'flex',
        alignItems: 'baseline',
        gap: 6,
        flexWrap: 'wrap',
        minWidth: 0,
      },
      fieldLabel: {
        fontSize: FS.small,
        fontWeight: 500,
        color: T.labelPrimary,
      },
      hint: {
        fontSize: FS.tiny,
        fontWeight: 400,
        color: T.labelCaption,
      },
      control: {
        width: '100%',
        boxSizing: 'border-box',
        font: 'inherit',
        fontSize: FS.body,
        lineHeight: 1.45,
        color: T.labelPrimary,
        // Was `bg-sunken`, which does not exist here: the fields had no fill.
        background: T.bgBase,
        border: '1px solid ' + T.borderL1,
        borderRadius: 6,
        padding: '6px 8px',
      },
      textareaExtra: {
        resize: 'vertical',
        minHeight: 44,
      },
      actions: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        flexWrap: 'wrap',
      },
      button: {
        font: 'inherit',
        fontSize: FS.small,
        color: T.labelSecondary,
        background: 'transparent',
        border: '1px solid ' + T.borderL2,
        borderRadius: 6,
        padding: '4px 12px',
        cursor: 'pointer',
        lineHeight: 1.5,
        whiteSpace: 'nowrap',
      },
      buttonPrimary: {
        font: 'inherit',
        fontSize: FS.small,
        fontWeight: 600,
        color: T.brand,
        background: 'transparent',
        border: '1px solid ' + T.brand,
        borderRadius: 6,
        padding: '4px 14px',
        cursor: 'pointer',
        lineHeight: 1.5,
        whiteSpace: 'nowrap',
      },
      disabled: {
        opacity: 0.4,
        cursor: 'default',
      },
      error: {
        color: T.error,
        fontSize: FS.small,
        lineHeight: 1.5,
        padding: '6px 8px',
        background: T.bgLayer2,
        border: '1px solid ' + T.borderL1,
        borderLeft: '3px solid ' + T.error,
        borderRadius: 6,
        wordBreak: 'break-word',
      },
      mono: {
        fontFamily: T.mono,
        fontSize: FS.small,
        color: T.labelSecondary,
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
          width: 15,
          height: 15,
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

    /**
     * One slider block: label + optional meaning badge + value on the top line,
     * the track underneath. Keeping the value on the label line is what makes a
     * slider readable — at the far right of a wide panel it reads as stray digits.
     */
    function paramRow(opts) {
      const head = [h('span', { key: 'label', style: S.paramLabel }, opts.label)];
      if (opts.badge) head.push(h('span', { key: 'badge', style: S.badge }, opts.badge));
      head.push(h('span', { key: 'value', style: S.paramValue }, String(opts.value)));
      return h('div', { key: opts.key, style: S.param }, [
        h('div', { key: 'head', style: S.paramHead }, head),
        h('input', {
          key: 'range',
          type: 'range',
          min: opts.min,
          max: opts.max,
          step: opts.step,
          value: opts.value,
          'aria-label': opts.label,
          'aria-valuetext': opts.badge ? String(opts.value) + ' / ' + opts.badge : String(opts.value),
          style: S.slider,
          onChange: opts.onChange,
        }),
      ]);
    }

    /** Label line (label + optional hint), then the control. `wide` spans the grid. */
    function fieldBlock(label, hint, control, wide) {
      const head = [h('span', { key: 'label', style: S.fieldLabel }, label)];
      if (hint) head.push(h('span', { key: 'hint', style: S.hint }, hint));
      return h('div', { style: wide ? Object.assign({}, S.field, S.fieldWide) : S.field }, [
        h('div', { key: 'head', style: S.fieldHead }, head),
        control,
      ]);
    }

    /** Colour is a second signal only: the status word is always rendered too. */
    function statusToneOf(raw) {
      const value = asString(raw).toLowerCase();
      if (!value) return T.labelSecondary;
      if (value === 'integrating') return T.warn;
      if (value === 'completed' || value === 'complete' || value === 'done' || value === 'succeeded' || value === 'success') {
        return T.success;
      }
      if (value === 'failed' || value === 'error') return T.error;
      if (value === 'stopped' || value === 'cancelled' || value === 'canceled') return T.idle;
      if (value === 'pending' || value === 'queued' || value === 'waiting') return T.idle;
      return T.brand;
    }

    function pair(key, k, v, tone) {
      return h('span', { key: key, style: { display: 'inline-flex', gap: 3, color: tone || T.labelSecondary } }, [
        h('span', { key: 'k', style: S.muted }, k),
        h('span', { key: 'v', style: Object.assign({}, S.statusValue, tone ? { color: tone } : null) }, v),
      ]);
    }

    /** Compact status shown in the title row, so it stays visible while collapsed. */
    function statusGroupOf(run, s, connected, busy) {
      const out = [];
      if (!connected) out.push(h('span', { key: 'conn', style: S.muted }, s.disconnected));
      if (busy) out.push(h('span', { key: 'busy', style: S.muted }, s.busyLabel));
      if (!run) {
        if (connected && !busy) out.push(h('span', { key: 'idle', style: S.muted }, s.idle));
        return out;
      }
      out.push(
        h('span', { key: 'state', style: { display: 'inline-flex', alignItems: 'center', gap: 5 } }, [
          h('span', {
            key: 'dot',
            style: Object.assign({}, S.statusDot, { background: statusToneOf(run.status) }),
            'aria-hidden': 'true',
          }),
          h('span', { key: 'text', style: S.statusValue }, statusTextOf(run.status)),
        ]),
      );
      if (run.run_id) {
        out.push(h('span', { key: 'sep-run', style: S.sep, 'aria-hidden': 'true' }, '\u00b7'));
        out.push(
          h('span', { key: 'run', style: S.mono, title: s.runLabel + ': ' + run.run_id }, shortenId(run.run_id)),
        );
      }
      out.push(h('span', { key: 'sep-settled', style: S.sep, 'aria-hidden': 'true' }, '\u00b7'));
      out.push(pair('settled', s.settledLabel, String(run.settled) + '/' + String(run.total)));
      if (run.failed > 0) {
        out.push(h('span', { key: 'sep-failed', style: S.sep, 'aria-hidden': 'true' }, '\u00b7'));
        out.push(pair('failed', s.failedLabel, String(run.failed), T.error));
      }
      const tokens = run.approx_tokens === null || run.approx_tokens === undefined ? '' : formatTokens(run.approx_tokens);
      if (tokens) {
        out.push(h('span', { key: 'sep-tokens', style: S.sep, 'aria-hidden': 'true' }, '\u00b7'));
        out.push(pair('tokens', s.tokensLabel, tokens));
      }
      return out;
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
      const armed = model.armed === true;
      const auto = model.mode !== 'manual';
      const textareaStyle = Object.assign({}, S.control, S.textareaExtra);

      const armRow = h(
        'label',
        {
          key: 'arm',
          style: armed ? Object.assign({}, S.armRow, S.armRowOn) : S.armRow,
          title: s.armHelp,
        },
        [
          h('input', {
            key: 'box',
            type: 'checkbox',
            checked: armed,
            style: S.checkbox,
            'aria-label': s.armHelp,
            onChange: model.onArm,
          }),
          h('span', { key: 'name', style: S.armLabel }, [glyph(T.brand), h('span', { key: 't' }, s.armLabel)]),
          h('span', {
            key: 'dot',
            style: Object.assign({}, S.dot, {
              background: connected ? T.success : T.idle,
              opacity: connected ? 1 : 0.55,
            }),
            'aria-hidden': 'true',
          }),
          armed ? null : h('span', { key: 'hint', style: S.armHint }, s.armHint),
          h('div', { key: 'status', style: S.statusGroup, 'aria-live': 'polite' }, statusGroupOf(run, s, connected, busy)),
        ].filter(Boolean),
      );

      const modeRow = h('div', { key: 'mode', style: S.modeRow, role: 'group', 'aria-label': s.modeLabel }, [
        h(
          'button',
          {
            key: 'auto',
            type: 'button',
            'aria-pressed': auto,
            style: auto ? Object.assign({}, S.modeBtn, S.modeBtnOn) : S.modeBtn,
            onClick: model.onModeAuto,
          },
          s.modeAuto,
        ),
        h(
          'button',
          {
            key: 'manual',
            type: 'button',
            'aria-pressed': !auto,
            style: auto ? S.modeBtn : Object.assign({}, S.modeBtn, S.modeBtnOn),
            onClick: model.onModeManual,
          },
          s.modeManual,
        ),
      ]);

      // Team row + board. The read may fail (older Host, no agent for this
      // Session), and a failure is shown as "unavailable" rather than "off" so
      // the saved selection is never misreported.
      const teamState = isObject(model.team) ? model.team : null;
      const teamEnabled = !!(teamState && teamState.enabled === true);
      const teamTasks = teamState && Array.isArray(teamState.tasks) ? teamState.tasks.slice(0, 5) : [];

      const teamRow = h(
        'label',
        { key: 'team', style: S.teamRow, title: s.teamHint },
        [
          h('input', {
            key: 'box',
            type: 'checkbox',
            checked: teamEnabled,
            disabled: model.teamBusy === true || teamState === null,
            style: S.checkbox,
            'aria-label': s.teamHint,
            onChange: model.onTeamToggle,
          }),
          h('span', { key: 'name', style: S.teamName }, s.teamLabel),
          h(
            'span',
            { key: 'state', style: S.teamState },
            teamState === null ? s.teamUnavailable : teamEnabled ? s.teamOn : s.teamOff,
          ),
        ],
      );

      const teamBoard =
        teamEnabled && teamTasks.length > 0
          ? h(
              'ul',
              { key: 'teamboard', style: S.teamList, 'aria-label': s.teamTasksLabel },
              teamTasks.map(function oneTask(task, index) {
                const status = asString(task && task.status).toLowerCase();
                const color =
                  status === 'completed'
                    ? T.success
                    : status === 'in_progress'
                      ? T.brand
                      : task && task.ready === false
                        ? T.warn
                        : T.idle;
                return h(
                  'li',
                  { key: asString(task && task.id) || 'task-' + index, style: S.teamItem },
                  [
                    h('span', { key: 'dot', style: Object.assign({}, S.teamDot, { background: color }), 'aria-hidden': 'true' }),
                    h('span', { key: 'subject', style: S.teamSubject }, asString(task && task.subject)),
                    h('span', { key: 'owner', style: S.teamOwner }, asString(task && task.owner)),
                  ],
                );
              }),
            )
          : null;

      // Checkout row. The service decides whether creation is possible at all;
      // the panel disables its control instead of offering a dead button.
      const worktreeState = isObject(model.worktree) ? model.worktree : null;
      const worktreeAvailable = !!(worktreeState && worktreeState.available === true);
      const worktreeBusy = model.worktreeBusy === true;
      const worktreeOff = !worktreeAvailable || worktreeBusy;

      const worktreeRow = h(
        'div',
        { key: 'worktree', style: S.wtRow, title: s.worktreeHint },
        [
          h('span', { key: 'name', style: S.teamName }, s.worktreeLabel),
          h('input', {
            key: 'base',
            type: 'text',
            value: model.worktreeBase,
            placeholder: s.worktreeBasePlaceholder,
            'aria-label': s.worktreeBasePlaceholder,
            disabled: worktreeOff,
            style: withDisabled(S.wtInput, worktreeOff),
            onChange: model.onWorktreeBase,
          }),
          h(
            'button',
            {
              key: 'go',
              type: 'button',
              disabled: worktreeOff,
              style: withDisabled(S.button, worktreeOff),
              onClick: model.onWorktreeCreate,
            },
            worktreeBusy ? s.worktreeBusy : s.worktreeCreate,
          ),
          worktreeAvailable ? null : h('span', { key: 'na', style: S.teamState }, s.worktreeUnavailable),
        ].filter(Boolean),
      );

      const worktreeNote =
        model.worktreeNote && model.worktreeNote.text
          ? h('div', { key: 'wtnote', style: S.wtNote, role: 'status' }, model.worktreeNote.text)
          : null;

      const body = h(
        'div',
        { key: 'morph', style: armed ? Object.assign({}, S.morph, S.morphOpen) : S.morph },
        h('div', { key: 'inner', style: S.morphInner }, [
          modeRow,
          teamRow,
          teamBoard,
          worktreeRow,
          worktreeNote,
          h('div', { key: 'note', style: S.note }, auto ? s.autoNote : s.manualNote),
          auto ? null : h('div', { key: 'params', style: S.params }, [
              paramRow({
                key: 'workers',
                label: s.workersLabel,
                min: MIN_WORKERS,
                max: MAX_WORKERS,
                step: 1,
                value: model.workers,
                onChange: model.onWorkers,
              }),
              paramRow({
                key: 'expansion',
                label: s.expansionLabel,
                badge: expansionCaptionOf(model.expansion),
                min: MIN_EXPANSION,
                max: MAX_EXPANSION,
                step: 1,
                value: model.expansion,
                onChange: model.onExpansion,
              }),
            ]),
            h('div', { key: 'fields', style: S.fields }, [
              fieldBlock(
                s.objectiveLabel,
                '',
                h('textarea', {
                  rows: 2,
                  value: model.objective,
                  placeholder: s.objectivePlaceholder,
                  'aria-label': s.objectiveLabel,
                  style: textareaStyle,
                  onChange: model.onObjective,
                }),
              ),
              fieldBlock(
                s.tasksLabel,
                s.tasksHint,
                h('textarea', {
                  rows: 2,
                  value: model.tasksText,
                  placeholder: s.tasksPlaceholder,
                  'aria-label': s.tasksLabel,
                  style: textareaStyle,
                  onChange: model.onTasks,
                }),
              ),
              fieldBlock(
                s.verifyLabel,
                '',
                h('input', {
                  type: 'text',
                  value: model.verifyText,
                  placeholder: s.verifyPlaceholder,
                  'aria-label': s.verifyLabel,
                  style: S.control,
                  onChange: model.onVerify,
                }),
                true,
              ),
            ]),
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
        ]),
      );

      const errorLine = error
        ? h('div', { key: 'error', style: S.error, role: 'status' }, s.errorPrefix + error)
        : null;

      return h(
        'div',
        { style: S.root, 'data-fanout-dock': '1', role: 'group', 'aria-label': s.title },
        [armRow, body, errorLine].filter(Boolean),
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
      const [armed, setArmed] = useState(false);
      const [mode, setMode] = useState('auto');
      const [workers, setWorkers] = useState(DEFAULT_WORKERS);
      const [expansion, setExpansion] = useState(DEFAULT_EXPANSION);
      const [objective, setObjective] = useState('');
      const [tasksText, setTasksText] = useState('');
      const [verifyText, setVerifyText] = useState('');
      const hydrated = useRef(false);
      const touched = useRef(false);
      // Team mode is per Session and the Host owns it; the dock mirrors the
      // last successful read and never guesses the selection.
      const [team, setTeam] = useState(null);
      const [teamBusy, setTeamBusy] = useState(false);
      // Checkout control: available only when the Host mounts the worktree
      // service, and the base ref is free text because the service resolves any
      // local branch, tag, or commit.
      const [worktree, setWorktree] = useState(null);
      const [worktreeBase, setWorktreeBase] = useState('');
      const [worktreeBusy, setWorktreeBusy] = useState(false);
      const [worktreeNote, setWorktreeNote] = useState(null);

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
          activeRuntime.store.set({ expanded: armed });
        },
        [armed],
      );

      // Team state polls on its own cadence: it is independent of run status and
      // must keep working while the dock body stays collapsed.
      useEffect(
        function pollTeam() {
          let alive = true;
          const read = function read() {
            const rt = activeRuntime;
            if (!rt || typeof rt.loadTeam !== 'function' || !sessionId) return;
            rt.loadTeam(sessionId)
              .then(function afterRead(result) {
                if (!alive) return;
                setTeam(result && result.ok ? result.data : null);
              })
              .catch(function ignore() {
                /* a failed read leaves the last known state in place */
              });
          };
          read();
          const interval = setInterval(read, POLL_MS);
          return function stopPoll() {
            alive = false;
            if (interval) clearInterval(interval);
          };
        },
        [sessionId],
      );

      // Availability is a mount-time question: the service either exists in this
      // composition or it does not, so one read is enough.
      useEffect(function readWorktree() {
        let alive = true;
        const rt = activeRuntime;
        if (!rt || typeof rt.loadWorktree !== 'function') return undefined;
        rt.loadWorktree()
          .then(function after(result) {
            if (!alive) return;
            setWorktree(result && result.ok ? result.data : null);
          })
          .catch(function ignore() {
            /* the control stays unavailable until a later mount answers */
          });
        return function stopRead() {
          alive = false;
        };
      }, []);

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

      /**
       * One source of truth: the Host holds the arming, this component mirrors
       * it. A transport failure leaves the box where the user put it — the Host
       * will simply not treat the next run as armed.
       */
      const armHost = function armHost(nextArmed, nextMode) {
        const rt = activeRuntime;
        if (!rt || typeof rt.arm !== 'function') return;
        rt.arm({
          session_id: sessionId,
          armed: !!nextArmed,
          mode: nextMode === 'manual' ? 'manual' : 'auto',
          workers: clamp(workers, MIN_WORKERS, MAX_WORKERS),
          expansion: clamp(expansion, MIN_EXPANSION, MAX_EXPANSION),
        }).catch(function ignore() {
          /* the Host decides; never surface a persistence failure here */
        });
      };

      const onArm = function onArm(event) {
        const next = !!(event && event.target && event.target.checked);
        setArmed(next);
        armHost(next, mode);
      };

      const onModeAuto = function onModeAuto() {
        if (mode === 'auto') return;
        setMode('auto');
        if (armed) armHost(true, 'auto');
      };

      const onModeManual = function onModeManual() {
        if (mode === 'manual') return;
        setMode('manual');
        if (armed) armHost(true, 'manual');
      };

      /**
       * One switch, one owner: the Host saves the selection and answers with the
       * value it holds. A failure is surfaced, never mirrored as "off".
       */
      const onTeamToggle = function onTeamToggle(event) {
        const next = !!(event && event.target && event.target.checked);
        const rt = activeRuntime;
        if (!rt || typeof rt.setTeam !== 'function' || !sessionId) return;
        setTeamBusy(true);
        rt.setTeam(sessionId, next)
          .then(function after(result) {
            setTeamBusy(false);
            if (result && result.ok) {
              setTeam(function withEnabled(prev) {
                return Object.assign({}, prev || {}, { enabled: next });
              });
              return;
            }
            rt.reportError((result && result.error) || activeStrings.teamUnavailable);
          })
          .catch(function ignore() {
            setTeamBusy(false);
          });
      };

      const onWorktreeBase = function onWorktreeBase(event) {
        setWorktreeBase(event && event.target ? String(event.target.value) : '');
      };

      /**
       * Create the checkout and enter it. The row stays busy for the whole call:
       * a long checkout must not look like a dead button.
       */
      const onWorktreeCreate = function onWorktreeCreate() {
        const rt = activeRuntime;
        if (!rt || typeof rt.createWorktree !== 'function' || !sessionId) return;
        setWorktreeBusy(true);
        setWorktreeNote(null);
        rt.createWorktree(sessionId, worktreeBase)
          .then(function after(result) {
            setWorktreeBusy(false);
            if (result && result.ok) {
              const data = isObject(result.data) ? result.data : {};
              const where = asString(data.path);
              setWorktreeNote({
                tone: 'ok',
                text: activeStrings.worktreeDone + (asString(data.branch) ? ': ' + asString(data.branch) : '') + (where ? ' · ' + where : ''),
              });
              return;
            }
            rt.reportError((result && result.error) || activeStrings.worktreeUnavailable);
          })
          .catch(function ignore() {
            setWorktreeBusy(false);
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
            // A started run consumes the arming: the next prompt is a new intent.
            if (result && result.ok) {
              setArmed(false);
              armHost(false, mode);
            }
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
        armed: armed,
        mode: mode,
        workers: workers,
        expansion: expansion,
        objective: objective,
        tasksText: tasksText,
        verifyText: verifyText,
        run: run,
        team: team,
        teamBusy: teamBusy,
        onTeamToggle: onTeamToggle,
        worktree: worktree,
        worktreeBase: worktreeBase,
        worktreeBusy: worktreeBusy,
        worktreeNote: worktreeNote,
        onWorktreeBase: onWorktreeBase,
        onWorktreeCreate: onWorktreeCreate,
        strings: activeStrings,
        onArm: onArm,
        onModeAuto: onModeAuto,
        onModeManual: onModeManual,
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
     * Composer takeover + session mark
     *
     * While the fan-out box is checked the resident composer stops being where
     * the prompt is written: the fan-out surface morphs open inside the card
     * and the input underneath goes transparent. Three rules keep it safe:
     *   - the Host owns the arming (per session, one-shot); this file mirrors it
     *     and never invents its own copy of that state;
     *   - the panel is absolutely positioned ONLY when the slot host is
     *     positioned, so a host layout change can never let it float over the
     *     conversation — otherwise it stays in flow inside the card;
     *   - everything is theme tokens and `transition`, no global CSS, no
     *     `document.body` writes, and a render fault returns null.
     * ------------------------------------------------------------------ */

    const TAKEOVER_SLOT = 'conversation.input.overlay';
    const TAKEOVER_ID = 'fanout-takeover';
    const TAKEOVER_ORDER = 15;
    const SESSION_MARK_SLOT = 'sidebar.session.row.leading';
    const SESSION_MARK_ID = 'fanout-session-mark';
    const SESSION_MARK_ORDER = 15;

    const TS = {
      host: { display: 'block', position: 'relative' },
      veil: {
        position: 'relative',
        display: 'grid',
        gridTemplateRows: '0fr',
        opacity: 0,
        pointerEvents: 'none',
        overflow: 'hidden',
        background: T.bgLayer1,
        borderRadius: 10,
        transition:
          'grid-template-rows 260ms cubic-bezier(0.22, 0.61, 0.36, 1), opacity 200ms ease',
      },
      veilFloating: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 },
      veilOpen: { gridTemplateRows: '1fr', opacity: 1, pointerEvents: 'auto' },
      inner: {
        minHeight: 0,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        padding: '10px 12px',
      },
      titleRow: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 },
      title: { fontSize: FS.title, fontWeight: 650, color: T.labelPrimary, whiteSpace: 'nowrap' },
      chip: {
        fontFamily: T.mono,
        fontSize: FS.tiny,
        color: T.labelSecondary,
        border: '1px solid ' + T.borderL1,
        borderRadius: 6,
        padding: '1px 6px',
        whiteSpace: 'nowrap',
      },
      hint: { fontSize: FS.small, color: T.labelCaption, lineHeight: 1.5 },
      status: { fontSize: FS.small, color: T.labelSecondary, whiteSpace: 'nowrap' },
      actions: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 2 },
      action: {
        font: 'inherit',
        fontSize: FS.small,
        color: T.labelSecondary,
        background: 'transparent',
        border: '1px solid ' + T.borderL1,
        borderRadius: 6,
        padding: '2px 8px',
        cursor: 'pointer',
      },
      mark: {
        width: 14,
        height: 14,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: T.brand,
        flex: '0 0 auto',
      },
    };

    /** The arming the Host reports. `expanded` is the dock's own body, not this. */
    function armedOfSnapshot(snapshot) {
      const state = isObject(snapshot && snapshot.state) ? snapshot.state : null;
      const armed = isObject(state && state.armed) ? state.armed : null;
      return !!(armed && armed.armed === true);
    }

    /** Does any run in the snapshot own this session? `root` marks the caller. */
    function runOfSession(snapshot, sessionId) {
      const state = isObject(snapshot && snapshot.state) ? snapshot.state : null;
      const runs = Array.isArray(state && state.runs) ? state.runs : [];
      if (!sessionId) return null;
      for (const run of runs) {
        if (!isObject(run)) continue;
        const sessions = Array.isArray(run.sessions) ? run.sessions : [];
        if (sessions.indexOf(sessionId) >= 0) return { run: run, role: 'worker' };
        if (asString(run.caller_session_id) === sessionId) return { run: run, role: 'root' };
      }
      return null;
    }

    function modelLabelOf(snapshot) {
      const state = isObject(snapshot && snapshot.state) ? snapshot.state : null;
      const direct = asString(state && state.model_label);
      if (direct) return direct;
      const runs = Array.isArray(state && state.runs) ? state.runs : [];
      const live = runs.find((run) => isObject(run) && asString(run.model_label));
      return live ? asString(live.model_label) : '';
    }

    function FanoutTakeover(props) {
      const sessionId = readSessionId(props);
      const [snapshot, setSnapshot] = useState(function initialSnapshot() {
        return hub.get();
      });
      const floating = useRef(false);
      const hostRef = useRef(null);
      const [positioned, setPositioned] = useState(false);

      useEffect(function subscribeHub() {
        return hub.subscribe(function onStoreChange() {
          setSnapshot(hub.get());
        });
      }, []);

      // Only float over the card when the slot host is a positioning box.
      useEffect(function measureHost() {
        const node = hostRef.current;
        if (!node || typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') return;
        try {
          const parent = node.parentElement;
          if (!parent) return;
          const style = window.getComputedStyle(parent);
          const next = style.position !== 'static';
          if (next !== floating.current) {
            floating.current = next;
            setPositioned(next);
          }
        } catch (err) {
          /* an unmeasurable host keeps the in-flow fallback */
        }
      }, []);

      const hostArmed = armedOfSnapshot(snapshot);
      // One optimistic step so the panel closes the instant the user clicks,
      // then the Host's answer wins again on the next poll.
      const [override, setOverride] = useState(null);
      useEffect(function clearOverride() {
        setOverride(null);
      }, [hostArmed]);
      const armed = override === null ? hostArmed : override;
      const strings = activeStrings;
      const model = modelLabelOf(snapshot);
      const hit = runOfSession(snapshot, sessionId);
      const live = isObject(hit) ? hit.run : null;

      function disarm(event) {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        setOverride(false);
        const rt = activeRuntime;
        if (!rt || typeof rt.arm !== 'function') return;
        rt.arm({ session_id: sessionId, armed: false }).catch(function ignore() {});
      }

      const veilStyle = mergeStyle(TS.veil, mergeStyle(positioned ? TS.veilFloating : {}, armed ? TS.veilOpen : {}));
      return h(
        'div',
        { ref: hostRef, style: TS.host, 'aria-hidden': armed ? 'false' : 'true' },
        h(
          'div',
          { style: veilStyle },
          h(
            'div',
            { style: TS.inner },
            h(
              'div',
              { style: TS.titleRow },
              h('span', { style: TS.title }, asString(strings.takeoverTitle) || 'Fan-out'),
              model ? h('span', { style: TS.chip }, model) : null,
              live
                ? h(
                    'span',
                    { style: TS.status },
                    (asString(strings.takeoverRunning) || 'run active') +
                      (hit.role === 'root' ? ' · ' + (asString(strings.takeoverRoot) || 'parent') : ''),
                  )
                : h('span', { style: TS.status }, asString(strings.takeoverIdle) || 'idle'),
            ),
            h('div', { style: TS.hint }, asString(strings.takeoverHint) || ''),
            h(
              'div',
              { style: TS.actions },
              h(
                'button',
                { type: 'button', style: TS.action, onClick: disarm },
                asString(strings.takeoverDisarm) || 'Close',
              ),
            ),
          ),
        ),
      );
    }

    /** 16px leading mark: this session is part of a fan-out run. */
    function FanoutSessionMark(props) {
      const sessionId = readSessionId(props);
      const [snapshot, setSnapshot] = useState(function initialSnapshot() {
        return hub.get();
      });

      useEffect(function subscribeHub() {
        return hub.subscribe(function onStoreChange() {
          setSnapshot(hub.get());
        });
      }, []);

      try {
        if (!sessionId) return null;
        const hit = runOfSession(snapshot, sessionId);
        if (!isObject(hit)) return null;
        const label =
          hit.role === 'root'
            ? asString(activeStrings.sessionMarkRoot) || 'fan-out parent'
            : asString(activeStrings.sessionMarkWorker) || 'fan-out worker';
        return h(
          'span',
          { style: TS.mark, title: label, 'aria-label': label },
          h(
            'svg',
            { width: 12, height: 12, viewBox: '0 0 16 16', 'aria-hidden': 'true', focusable: 'false' },
            h('path', {
              d: 'M1.5 8h3l1.6-4 2.6 8 1.6-4h4.2',
              fill: 'none',
              stroke: 'currentColor',
              strokeWidth: 1.6,
              strokeLinecap: 'round',
              strokeLinejoin: 'round',
            }),
          ),
        );
      } catch (err) {
        return null;
      }
    }


    /* ------------------------------------------------------------------ *
     * Sidebar progress board
     *
     * Two registrations, one identity: `sidebar.panellist` renders the icon row
     * and `main` renders the page that row selects — the shell matches them by
     * the shared id/key, so both use PANEL_ID. The board answers "how far along
     * is the split team?" without a click: one bar per run, one chip per worker,
     * the integrator's state, and an elapsed clock.
     *
     * Every number comes from the Host (`/state` → engine.uiState(), which owns
     * progressOf/phaseOf). This file never re-derives a percentage, so the dock
     * and the board cannot disagree about the same run.
     * ------------------------------------------------------------------ */

    const PANEL_ID = 'fanout';
    const PANEL_ORDER = 30;
    const PANEL_POLL_MS = 2000;
    const PANEL_MAX_RUNS = 8;

    function mergeStyle(base, extra) {
      return Object.assign({}, base, extra || {});
    }

    function pad2(value) {
      return value < 10 ? '0' + value : String(value);
    }

    function formatElapsed(ms) {
      const seconds = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
      const s = seconds % 60;
      const m = Math.floor(seconds / 60) % 60;
      const hours = Math.floor(seconds / 3600);
      if (hours > 0) return hours + ':' + pad2(m) + ':' + pad2(s);
      return m + ':' + pad2(s);
    }

    function phaseColor(phase) {
      if (phase === 'done') return T.success;
      if (phase === 'failed') return T.error;
      if (phase === 'stopped') return T.idle;
      if (phase === 'integrating') return T.warn;
      return T.brand;
    }

    function phaseLabelOf(phase, s) {
      if (phase === 'done') return s.statusCompleted;
      if (phase === 'failed') return s.statusFailed;
      if (phase === 'stopped') return s.statusStopped;
      if (phase === 'integrating') return s.statusIntegrating;
      return s.statusRunning;
    }

    function workerStateView(state, s) {
      const value = asString(state).toLowerCase();
      if (value === 'running') return { label: s.panelWorkerRunning, color: T.brand };
      if (value === 'settled') return { label: s.panelWorkerSettled, color: T.success };
      if (value === 'failed') return { label: s.panelWorkerFailed, color: T.error };
      if (value === 'stopped') return { label: s.panelWorkerStopped, color: T.idle };
      return { label: s.panelWorkerPending, color: T.idle };
    }

    function integratorView(state, s) {
      const value = asString(state).toLowerCase();
      if (value === 'running') return { label: s.panelIntegratorRunning, color: T.warn };
      if (value === 'settled') return { label: s.panelIntegratorSettled, color: T.success };
      if (value === 'failed') return { label: s.panelIntegratorFailed, color: T.error };
      if (value === 'stopped') return { label: s.panelWorkerStopped, color: T.idle };
      return { label: s.panelIntegratorIdle, color: T.idle };
    }

    /* --- Host compatibility -------------------------------------------------
     * `engine.uiRun()` (Host ≥ 0.2.0) sends `percent`, `phase`, `workers`,
     * `created_at` and `integrator_state`. An older Host sends only
     * `total`/`settled`/`failed`/`status`/`updated_at`, and the Host half only
     * reloads when the Harness restarts — so the board must not depend on the
     * new fields. When a field is present the Host's value wins (single source
     * of truth); when it is missing these mirror lib/plan.js exactly.
     * ---------------------------------------------------------------------- */

    function integratorStateOf(run) {
      const fromHost = asString(run && run.integrator_state);
      if (fromHost) return fromHost;
      // An older Host has no `integrator_state`; the run status still tells us
      // whether integration is in progress or already done. Claiming "待機" for
      // an integrating run would contradict the status pill beside it.
      const status = asString(run && run.status);
      if (status === 'integrating') return 'running';
      if (status === 'completed') return 'settled';
      return '';
    }

    function progressOfRun(run) {
      const fromHost = run && run.percent;
      if (typeof fromHost === 'number' && Number.isFinite(fromHost)) {
        return Math.max(0, Math.min(100, Math.round(fromHost)));
      }
      const total = asCount(run && run.total);
      const settled = Math.min(total, asCount(run && run.settled));
      const workerShare = total === 0 ? 0 : Math.round((settled / total) * 85);
      const outcome = asString(run && run.status);
      const integrator = integratorStateOf(run);
      if (outcome === 'completed') return 100;
      if (outcome === 'failed' || outcome === 'stopped') return workerShare;
      if (integrator === 'settled') return 100;
      if (integrator === 'running' || integrator === 'failed') return Math.max(90, workerShare);
      return workerShare;
    }

    function phaseOfRun(run) {
      const fromHost = asString(run && run.phase);
      if (fromHost) return fromHost;
      const outcome = asString(run && run.status);
      const integrator = integratorStateOf(run);
      if (outcome === 'failed') return 'failed';
      if (outcome === 'stopped') return 'stopped';
      if (outcome === 'completed') return 'done';
      if (integrator === 'running') return 'integrating';
      if (integrator === 'settled') return 'done';
      return 'workers';
    }

    function workersOf(run) {
      return run && Array.isArray(run.worker_details) ? run.worker_details : [];
    }

    /**
     * Only `created_at` is a start time. An older Host sends just `updated_at`,
     * which moves with every settle — showing "elapsed" from it would be a
     * number that resets itself, so the clock is simply omitted instead.
     */
    function runStartMsOf(run) {
      const created = Date.parse(asString(run && run.created_at));
      return Number.isFinite(created) ? created : 0;
    }

    const PS = {
      page: {
        height: '100%',
        boxSizing: 'border-box',
        overflowY: 'auto',
        padding: '18px 20px 28px',
        background: T.bgBase,
        color: T.labelPrimary,
        fontFamily: 'inherit',
        fontSize: FS.body,
        lineHeight: 1.5,
      },
      inner: { maxWidth: 920, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 14 },
      header: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
      titleWrap: { display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0, flexWrap: 'wrap' },
      h1: { margin: 0, fontSize: 16, fontWeight: 650, letterSpacing: '0.01em' },
      sub: { fontSize: FS.small, color: T.labelCaption },
      headerRight: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 10,
        marginLeft: 'auto',
        fontSize: FS.small,
        color: T.labelSecondary,
      },
      conn: { display: 'inline-flex', alignItems: 'center', gap: 6 },
      dot: { width: 8, height: 8, borderRadius: '50%', display: 'inline-block', flex: '0 0 auto' },
      button: {
        font: 'inherit',
        fontSize: FS.small,
        color: T.labelPrimary,
        background: T.bgLayer1,
        border: '1px solid ' + T.borderL1,
        borderRadius: 7,
        padding: '3px 9px',
        cursor: 'pointer',
      },
      summary: {
        display: 'flex',
        gap: 16,
        flexWrap: 'wrap',
        padding: '8px 12px',
        background: T.bgLayer1,
        border: '1px solid ' + T.borderL1,
        borderRadius: 10,
        fontSize: FS.small,
        color: T.labelSecondary,
      },
      summaryCell: { display: 'inline-flex', alignItems: 'center', gap: 4 },
      strong: { color: T.labelPrimary, fontWeight: 600, fontVariantNumeric: 'tabular-nums' },
      section: { display: 'flex', flexDirection: 'column', gap: 10 },
      h2: {
        margin: 0,
        fontSize: FS.small,
        fontWeight: 600,
        color: T.labelCaption,
        letterSpacing: '0.06em',
      },
      card: {
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        padding: '11px 13px',
        background: T.bgLayer1,
        border: '1px solid ' + T.borderL1,
        borderRadius: 10,
      },
      cardActive: { borderColor: T.borderL2 },
      cardTop: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      runId: { fontFamily: T.mono, fontSize: FS.small, color: T.labelPrimary, fontWeight: 600 },
      pill: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: '1px 7px',
        borderRadius: 999,
        border: '1px solid ' + T.borderL1,
        fontSize: FS.tiny,
        color: T.labelSecondary,
      },
      pillDot: { width: 6, height: 6, borderRadius: '50%', display: 'inline-block', flex: '0 0 auto' },
      rightMeta: {
        marginLeft: 'auto',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 10,
        fontSize: FS.small,
        color: T.labelCaption,
        fontVariantNumeric: 'tabular-nums',
      },
      percent: { fontSize: 15, fontWeight: 650, color: T.labelPrimary, fontVariantNumeric: 'tabular-nums' },
      objective: {
        fontSize: FS.body,
        color: T.labelSecondary,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      barTrack: { height: 6, borderRadius: 999, background: T.bgLayer2, overflow: 'hidden' },
      barFill: { height: '100%', borderRadius: 999, transition: 'width 240ms ease' },
      metaRow: {
        display: 'flex',
        gap: 12,
        flexWrap: 'wrap',
        fontSize: FS.small,
        color: T.labelCaption,
        fontVariantNumeric: 'tabular-nums',
      },
      stageStrip: {
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        fontSize: FS.tiny,
        color: T.labelCaption,
        flexWrap: 'wrap',
      },
      stageCell: { padding: '1px 6px', borderRadius: 5, border: '1px solid transparent' },
      stageOn: { color: T.labelPrimary, background: T.bgLayer2 },
      stageOff: { color: T.labelCaption, opacity: 0.65 },
      stageSep: { color: T.labelCaption, opacity: 0.6 },
      chips: { display: 'flex', gap: 6, flexWrap: 'wrap' },
      chip: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: '1px 7px',
        borderRadius: 6,
        border: '1px solid ' + T.borderL1,
        background: T.bgLayer2,
        fontSize: FS.tiny,
        color: T.labelSecondary,
        maxWidth: '100%',
      },
      chipDot: { width: 6, height: 6, borderRadius: '50%', display: 'inline-block', flex: '0 0 auto' },
      chipName: { fontFamily: T.mono, color: T.labelPrimary, fontWeight: 600 },
      chipCount: { color: T.labelCaption },
      integratorRow: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        fontSize: FS.small,
        color: T.labelSecondary,
        flexWrap: 'wrap',
      },
      path: {
        fontFamily: T.mono,
        fontSize: FS.tiny,
        color: T.labelCaption,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        maxWidth: '100%',
      },
      muted: { fontSize: FS.small, color: T.labelCaption },
      empty: { display: 'flex', flexDirection: 'column', gap: 6, padding: '24px 0' },
      emptyTitle: { fontSize: FS.body, color: T.labelSecondary, fontWeight: 600 },
      footer: { marginTop: 2, fontSize: FS.tiny, color: T.labelCaption },
      error: { fontSize: FS.small, color: T.error },
    };

    function panelBar(percent, color) {
      const pct = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
      return h(
        'div',
        {
          style: PS.barTrack,
          role: 'progressbar',
          'aria-valuemin': 0,
          'aria-valuemax': 100,
          'aria-valuenow': pct,
        },
        h('div', { style: mergeStyle(PS.barFill, { width: pct + '%', background: color }) }),
      );
    }

    function renderStages(phase, s) {
      const order = ['workers', 'integrating', 'done'];
      const labels = [s.panelStageWorkers, s.panelStageIntegrating, s.panelStageDone];
      const reachedTo = phase === 'integrating' ? 1 : phase === 'done' ? 2 : 0;
      const dead = phase === 'failed' || phase === 'stopped';
      const children = [];
      for (let i = 0; i < labels.length; i += 1) {
        if (i > 0) {
          children.push(h('span', { key: 'sep' + i, style: PS.stageSep, 'aria-hidden': 'true' }, '›'));
        }
        const on = !dead && i <= reachedTo;
        children.push(
          h('span', { key: 'stage' + i, style: mergeStyle(PS.stageCell, on ? PS.stageOn : PS.stageOff) }, labels[i]),
        );
      }
      return h('div', { style: PS.stageStrip, 'data-order': order.join(',') }, children);
    }

    function renderWorkerChip(worker, s, fallbackIndex) {
      const view = workerStateView(worker.state, s);
      const tasks = Array.isArray(worker.tasks) ? worker.tasks : [];
      const count = tasks.length;
      const titles = count > 0
        ? tasks
            .map(function titleOf(task) {
              return asString(task && task.title);
            })
            .filter(Boolean)
            .join(' / ')
        : s.panelNoTasks;
      const index = Number.isFinite(Number(worker.index)) ? Number(worker.index) : fallbackIndex;
      const name = 'W' + (index + 1);
      return h(
        'span',
        {
          key: 'w' + String(index) + '-' + fallbackIndex,
          style: PS.chip,
          title: name + ' · ' + view.label + ' · ' + titles,
        },
        [
          h('span', { key: 'dot', style: mergeStyle(PS.chipDot, { background: view.color }), 'aria-hidden': 'true' }),
          h('span', { key: 'name', style: PS.chipName }, name),
          h('span', { key: 'state' }, view.label),
          count > 0 ? h('span', { key: 'count', style: PS.chipCount }, count + s.panelTaskCount) : null,
        ],
      );
    }

    function renderRunCard(run, s, now) {
      const phase = phaseOfRun(run);
      const color = phaseColor(phase);
      const total = asCount(run.total);
      const settled = asCount(run.settled);
      const failed = asCount(run.failed);
      const workers = workersOf(run);
      const startedAt = runStartMsOf(run);
      const elapsed = startedAt > 0 ? formatElapsed(now - startedAt) : '';
      const runId = asString(run.run_id);
      const shortId = shortenId(runId);
      const objective = asString(run.objective);
      const integrate = run.integrate !== false;
      const integrator = integratorView(integratorStateOf(run), s);
      const percent = progressOfRun(run);

      const top = h('div', { style: PS.cardTop }, [
        h('span', { key: 'id', style: PS.runId, title: runId }, shortId),
        h('span', { key: 'pill', style: PS.pill }, [
          h('span', { key: 'd', style: mergeStyle(PS.pillDot, { background: color }), 'aria-hidden': 'true' }),
          phaseLabelOf(phase, s),
        ]),
        h('span', { key: 'right', style: PS.rightMeta }, [
          h('span', { key: 'pct', style: PS.percent }, percent + '%'),
          elapsed ? h('span', { key: 'elapsed' }, s.panelElapsedLabel + ' ' + elapsed) : null,
        ]),
      ]);

      const meta = h('div', { style: PS.metaRow }, [
        h('span', { key: 'w' }, s.panelWorkersLabel + ' ' + settled + '/' + total),
        failed > 0 ? h('span', { key: 'f', style: { color: T.error } }, s.panelWorkerFailed + ' ' + failed) : null,
        asCount(run.estimate_tokens) > 0
          ? h('span', { key: 't' }, s.tokensLabel + ' ' + formatTokens(run.estimate_tokens))
          : null,
      ]);

      const integratorRow = integrate
        ? h('div', { style: PS.integratorRow }, [
            h('span', { key: 'dot', style: mergeStyle(PS.chipDot, { background: integrator.color }), 'aria-hidden': 'true' }),
            h('span', { key: 'label' }, s.panelIntegratingLabel + ': ' + integrator.label),
            asString(run.final_path)
              ? h('span', { key: 'path', style: PS.path, title: asString(run.final_path) }, s.panelFinalReport + ' — ' + asString(run.final_path))
              : null,
          ])
        : null;

      return h('article', { key: runId, style: mergeStyle(PS.card, phase === 'workers' || phase === 'integrating' ? PS.cardActive : null) }, [
        top,
        objective ? h('div', { key: 'obj', style: PS.objective, title: objective }, objective) : null,
        panelBar(percent, color),
        meta,
        renderStages(phase, s),
        workers.length > 0
          ? h('div', { key: 'chips', style: PS.chips }, workers.map(function chip(worker, index) {
              return renderWorkerChip(worker, s, index);
            }))
          : null,
        integratorRow,
        asString(run.error) ? h('div', { key: 'err', style: PS.error }, s.errorPrefix + asString(run.error)) : null,
      ]);
    }

    function renderPanel(model) {
      const s = model.strings;
      const runs = model.runs;
      const live = [];
      const past = [];
      for (let i = 0; i < runs.length; i += 1) {
        const phase = phaseOfRun(runs[i]);
        if (phase === 'workers' || phase === 'integrating') live.push(runs[i]);
        else past.push(runs[i]);
      }

      let workerTotal = 0;
      let workerSettled = 0;
      let integrating = 0;
      for (let i = 0; i < runs.length; i += 1) {
        workerTotal += asCount(runs[i].total);
        workerSettled += asCount(runs[i].settled);
        if (integratorStateOf(runs[i]) === 'running') integrating += 1;
      }

      const header = h('div', { style: PS.header }, [
        h('div', { key: 'titles', style: PS.titleWrap }, [
          h('h1', { key: 'h', style: PS.h1 }, s.panelTitle),
          h('span', { key: 'sub', style: PS.sub }, s.panelSubtitle),
        ]),
        h('div', { key: 'right', style: PS.headerRight }, [
          h('span', { key: 'conn', style: PS.conn }, [
            h(
              'span',
              {
                key: 'dot',
                style: mergeStyle(PS.dot, { background: model.connected ? T.success : T.idle }),
                'aria-hidden': 'true',
              },
            ),
            model.connected ? s.connected : s.disconnected,
          ]),
          h(
            'button',
            { key: 'refresh', type: 'button', style: PS.button, disabled: model.busy, onClick: model.onRefresh },
            s.refresh,
          ),
        ]),
      ]);

      const summary = runs.length === 0
        ? null
        : h('div', { style: PS.summary }, [
            h('span', { key: 'a', style: PS.summaryCell }, [
              s.panelRunningCount + ' ',
              h('strong', { key: 'n', style: PS.strong }, String(live.length)),
            ]),
            h('span', { key: 'b', style: PS.summaryCell }, [
              s.panelWorkersLabel + ' ',
              h('strong', { key: 'n', style: PS.strong }, workerSettled + '/' + workerTotal),
            ]),
            h('span', { key: 'c', style: PS.summaryCell }, [
              s.panelIntegratingLabel + ' ',
              h('strong', { key: 'n', style: PS.strong }, String(integrating)),
            ]),
          ]);

      const empty = h('div', { style: PS.empty }, [
        h('div', { key: 't', style: PS.emptyTitle }, s.panelEmpty),
        h('div', { key: 'h', style: PS.muted }, s.panelEmptyHint),
      ]);

      const sections = [];
      if (live.length > 0) {
        sections.push(
          h('section', { key: 'live', style: PS.section }, [h('h2', { key: 'h', style: PS.h2 }, s.panelActiveLabel)].concat(
            live.map(function liveCard(run) {
              return renderRunCard(run, s, model.now);
            }),
          )),
        );
      }
      if (past.length > 0) {
        sections.push(
          h('section', { key: 'past', style: PS.section }, [h('h2', { key: 'h', style: PS.h2 }, s.panelRecentLabel)].concat(
            past.map(function pastCard(run) {
              return renderRunCard(run, s, model.now);
            }),
          )),
        );
      }

      const footer = h('div', { style: PS.footer }, [
        h('span', { key: 'legend' }, s.panelPercentLegend),
        runs.length >= PANEL_MAX_RUNS ? h('span', { key: 'cap' }, ' · ' + s.panelTruncated) : null,
      ]);

      const errorLine = model.error
        ? h('div', { key: 'error', style: PS.error, role: 'status' }, s.errorPrefix + model.error)
        : null;

      const body = runs.length === 0 ? [empty] : sections;

      return h(
        'div',
        { style: PS.page, 'data-fanout-panel': '1' },
        h('div', { style: PS.inner }, [header, summary, errorLine].concat(body).concat([footer])),
      );
    }

    function usePanelModel() {
      const [snapshot, setSnapshot] = useState(function initialSnapshot() {
        return hub.get();
      });
      const [now, setNow] = useState(function initialNow() {
        return Date.now();
      });

      useEffect(function pollWhileMounted() {
        const read = function read() {
          setSnapshot(hub.get());
          setNow(Date.now());
        };
        read();
        const unsubscribe = hub.subscribe(read);
        // The board is a live monitor: poll on its own so a collapsed composer
        // dock (which stops polling once idle) cannot freeze these numbers.
        const interval = setInterval(function tick() {
          const runtime = activeRuntime;
          if (runtime && typeof runtime.refreshState === 'function') {
            runtime.refreshState(true).catch(function ignore() {
              /* a failed poll only flips `connected` */
            });
          }
          read();
        }, PANEL_POLL_MS);
        return function stopPoll() {
          if (interval) clearInterval(interval);
          if (typeof unsubscribe === 'function') unsubscribe();
        };
      }, []);

      const state = isObject(snapshot.state) ? snapshot.state : null;
      const runs = state && Array.isArray(state.runs) ? state.runs.slice(0, PANEL_MAX_RUNS) : [];

      return {
        runs: runs,
        connected: !!snapshot.connected,
        busy: !!snapshot.busy,
        error: asString(snapshot.error),
        now: now,
        strings: activeStrings,
        onRefresh: function onRefresh() {
          const runtime = activeRuntime;
          if (!runtime || typeof runtime.refreshAll !== 'function') return;
          runtime.refreshAll().catch(function ignore() {
            /* runtime already recorded the failure */
          });
        },
      };
    }

    function FanoutPanel() {
      const model = usePanelModel();
      try {
        return renderPanel(model);
      } catch (err) {
        // A render fault must never take the main column down.
        return null;
      }
    }

    /** The left sidebar row. Owner props: { size, active } (SidebarPanelIconOwnerProps). */
    function FanoutIcon(owner) {
      const props = isObject(owner) ? owner : {};
      const size = Math.max(10, Math.min(64, Math.round(Number(props.size) || 16)));
      const stroke = props.active === true ? T.brand : T.labelSecondary;
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          style: { display: 'block' },
          'aria-hidden': 'true',
          focusable: 'false',
        },
        [
          h('path', { key: 'trunk', d: 'M4 12h4', stroke: stroke, strokeWidth: 1.8, strokeLinecap: 'round' }),
          h('path', {
            key: 'fan',
            d: 'M8 12l5-5M8 12h5M8 12l5 5',
            stroke: stroke,
            strokeWidth: 1.8,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
          }),
          h('circle', { key: 'a', cx: 16.5, cy: 7, r: 2.1, stroke: stroke, strokeWidth: 1.8 }),
          h('circle', { key: 'b', cx: 16.5, cy: 12, r: 2.1, stroke: stroke, strokeWidth: 1.8 }),
          h('circle', { key: 'c', cx: 16.5, cy: 17, r: 2.1, stroke: stroke, strokeWidth: 1.8 }),
        ],
      );
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
        loadTeam: function loadTeam(sessionId) {
          return bridge.getTeam(asString(sessionId));
        },
        setTeam: function setTeam(sessionId, enabled) {
          return bridge.setTeam(asString(sessionId), enabled === true);
        },
        loadWorktree: function loadWorktree() {
          return bridge.getWorktree();
        },
        createWorktree: function createWorktree(sessionId, from) {
          return bridge.createWorktree(asString(sessionId), from);
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

      // The takeover and the sidebar mark share the dock's one polling loop: they
      // read the same `hub`, so there is no second source of truth and no second
      // timer. Each registration stands alone so one missing slot cannot cost
      // the others.
      try {
        ctx.slots.register(
          { name: TAKEOVER_SLOT, id: TAKEOVER_ID, order: TAKEOVER_ORDER },
          FanoutTakeover,
        );
      } catch (err) {
        try {
          console.warn('[dsh-fanout] composer takeover registration failed:', String((err && err.message) || err));
        } catch (ignored) {
          /* console may be unavailable */
        }
      }

      try {
        ctx.slots.register(
          { name: SESSION_MARK_SLOT, id: SESSION_MARK_ID, order: SESSION_MARK_ORDER },
          FanoutSessionMark,
        );
      } catch (err) {
        try {
          console.warn('[dsh-fanout] sidebar session mark registration failed:', String((err && err.message) || err));
        } catch (ignored) {
          /* console may be unavailable */
        }
      }

      // Left sidebar entry. `sidebar.panellist` renders the icon row; the shell
      // addresses the page by the same id, so `main` registers PANEL_ID as its
      // key. A missing `main` (non-conversation hosts) must not lose the row,
      // and a missing sidebar (older hosts) must not break the dock: register
      // each one on its own so either failure stays local.
      try {
        ctx.slots.register(
          {
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: PANEL_ORDER,
            label: function sidebarRowLabel() {
              return activeStrings.panelNavLabel;
            },
          },
          FanoutIcon,
        );
      } catch (err) {
        try {
          console.warn('[dsh-fanout] sidebar row registration failed:', String((err && err.message) || err));
        } catch (ignored) {
          /* console may be unavailable */
        }
      }

      try {
        ctx.slots.register({ name: 'main', key: PANEL_ID }, FanoutPanel);
      } catch (err) {
        try {
          console.warn('[dsh-fanout] progress panel registration failed:', String((err && err.message) || err));
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

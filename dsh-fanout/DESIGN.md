# dsh-fanout — design contract (single source of truth for this build)

Status: implementation contract. Read this before writing any file.
Plugin directory: `C:\Users\user\Desktop\ローカル実験\dsh-plugins\dsh-fanout`
(unique directory; other sessions may edit sibling plugin dirs — never touch those.)

## What the plugin is for

One session delegates a batch of large, **asymmetric** jobs. The plugin then, without
further human input:

1. **fans out**: creates N ordinary Harness sessions (visible in the sidebar),
2. **auto-assigns**: weight-balanced packing of the task list into those N sessions,
3. **keeps context minimal**: each worker gets a tiny brief (objective + its own task +
   the result-file contract). The parent transcript is never copied to workers, and
   workers' full transcripts are never copied back — only short result digests,
4. **auto-integrates**: when workers settle, creates one final session that merges the
   results, runs the project's e2e verification and build commands, and writes
   `final.md` with commands + exit codes as evidence,
5. reports back into the delegating session with a short follow-up message.

Second capability: an **expansion gate** that counteracts premature narrowing
(“thinking more made me quietly drop options”). The model calls `divergence_check`;
the plugin spawns fresh probe sessions that never see the model's proposal, so the
option space is re-derived without anchoring, then forces an explicit
adopt / reject / defer classification that is recorded on disk.

Third capability: **two sliders in the Web UI** (branch sessions, thought expansion)
so token spend is dialed, not guessed.

## Verified platform facts (measured in this installation, do not re-derive)

Services are resolved with `ctx.get(name)` (optional) — check for `undefined`.

### sessionController (Host)
- `create({ workspaceId?, cwd?, sessionId?, agentPreset? }) -> Promise<{ sessionId, agentPreset? }>`
  Creates one ordinary session (does not start an agent).
- `prompt({ requestId, sessionId, mode: 'queue'|'steer', content: [{type:'text',text}], clientTimeZone? }, signal) -> Promise<{accepted:true}>`
  Admits a prompt; resumes a cold session.
- `list({}, signal) -> Promise<{items: SessionSummary[]}>` where
  `SessionSummary = { sessionId, running, blank, cwd?, updatedAt, origin?, parentSessionId?, ... }`
- `inspect(sessionId, signal?) -> Promise<{ meta: SessionHeader, events: SessionEvent[] }>`
  `SessionEvent = { type, seq, time, data }`; `turn/end` data is `{turn, reason:{kind}}`;
  assistant text lives in `assistant/message` data.message.content[] blocks of `type:'text'`.
- `cancel({ sessionId }) -> { accepted: true }` cancels the active turn only.

### Events (global listeners via `ctx.on(name, fn, { global: true })`)
- `api-session/status` — `(sessionId: SessionId, running: boolean)`. Primary settle signal.
- `session/event` — `(session, event)`; `turn/end` carries the reason kind.
- `api-session/added` — `(summary)` when a session becomes visible.
- `agent/disposed` — `({agent})`.

### Agents
- `ctx.get('agents').get(sessionId)` -> live Agent or undefined.
- `agent.followup(message)` wakes a live agent with a new user message.
- `createUserMessage` shape: `{ id: randomUUID(), role: 'user', content:[{type:'text',text}], source:{kind:'fanout', form:'...'} }`

### Tools
- `ctx.tools.register({ name, description, parameters, output:{schema, render}, timeoutMs, execute(args, exec) {...}, presentCall(args) })`
  `exec.agent` is the live calling agent; `exec.callId`, `exec.signal`.

### Prompt
- `ctx.get('systemPrompt').section({ name, order, text })` (plugin section, order 2550 for this plugin).

### Files
- Plain Node `node:fs/promises`, `node:path`, `node:http`, `node:crypto` are available.
- State root: `~/.dsh/storages/fanout/` (override with config `storeDir`).
  Layout: `config.json`, `runs/<runId>/run.json`, `runs/<runId>/results/<taskId>.md`,
  `runs/<runId>/final.md`, `divergence/<id>.json`.
- Workspace-relative result directory used inside workers: `.dsh-fanout/runs/<runId>/`.

### UI bridge
The bundle's client half is plain JS loaded by `window.__ModuleLoader__.load({ id, factory(require) })`
(see `dsh-browser-agent/client/client.js` for a working example in this same profile).
Cross-half RPC for bundles is **not** available through `host.call` (that builtin is for
dynamic packages), so this bundle exposes a JSON API through two carriers that share one
handler (`createBridgeHandler` in `lib/bridge.js`):
1. the existing Web server under the `/fanout-api` prefix (same origin; no CORS/CSP risk),
2. a loopback-only listener on `127.0.0.1:<bridgePort>` (default `51337`) as fallback.
The client tries `/fanout-api/health` first, then `http://127.0.0.1:<port>/health`.
**Auth:** every route except `GET /health` requires `x-fanout-token`; health returns the
token only over loopback. Bodies are capped at 1 MB and CORS is reflected only for
loopback origins. This is a local-only control surface, same trust model as the browser
plugin in this workspace.

## File ownership (do not edit outside your scope)

| Path | Owner |
|---|---|
| `index.js`, `lib/*.js` | Lead |
| `client.js`, `locale/en.json`, `locale/ja.json`, `icon.svg` | ui-builder |
| `package.json`, `cordis.patch.yml`, `README.md` | Lead |
| `test/*.mjs`, `test/README.md` | verifier |

## Host module layout (Lead)

- `index.js` — `apply(ctx, config)`: resolve config, create engine, register tools,
  prompt section, event listeners, bridge, disposer.
- `lib/plan.js` — pure: `normalizeTasks`, `packTasks(tasks, workers)` (weight-balanced
  LPT bin packing), `estimateBudget({tasks, workers, expansion})`.
- `lib/prompts.js` — pure: `renderWorkerBrief(...)`, `renderIntegratorBrief(...)`,
  `DIVERGENCE_AXES`, `divergenceAxes(n)`, `renderProbeBrief(...)`, `renderCallerDigest(...)`,
  `renderStatusLine(...)`.
- `lib/store.js` — run directories, config persistence, atomic JSON writes.
- `lib/bridge.js` — localhost HTTP routes: `GET /health`, `GET /state`, `POST /config`,
  `POST /start`, `POST /stop`.
- `lib/engine.js` — `FanoutEngine`: `start(request, caller)`, `status(runId?)`, `stop(runId?)`,
  `divergence(request)`, internal monitor, settle handling, integration.

## Tool contracts (model-facing)

### `fanout_start`
```
{ objective: string,                       // one paragraph, the shared goal
  tasks: [{ title, brief, weight?, scope?: string[] }],  // asymmetric jobs
  workers?: number,                        // 1..8, default = min(tasks.length, cfg.maxWorkers)
  expansion?: number,                      // 0..100, from the UI slider; default cfg.defaultExpansion
  verify?: string[],                       // commands the integrator must run, e.g. ["pnpm test","pnpm build"]
  cwd?: string,                            // working directory for workers; default caller cwd
  integrate?: boolean,                     // default true
  timeoutMinutes?: number }                // per-worker budget, default cfg.workerTimeoutMinutes
-> { run_id, status, workers:[{session_id, task_ids, weight}], integrator_session_id,
     estimate:{workers, expansion, approx_tokens}, store_dir }
```

### `fanout_status`
```
{ run_id?: string } -> { runs: [...], run?: {...} }   // newest first; compact
```

### `fanout_stop`
```
{ run_id?: string, reason?: string } -> { run_id, status:'stopped', cancelled:[...] }
```

### `divergence_check`
```
{ objective: string, proposal: string, constraints?: string[],
  intensity?: 1..5,                        // default derived from cfg.defaultExpansion
  decisions?: [{ option_id, decision:'adopt'|'reject'|'defer', reason }] }
-> phase 'report': { divergence_id, axes:[...], options:[{option_id, axis, text}],
                     probes:{spawned, settled, failed}, required:true,
                     message:'Classify every option, then call again with decisions.' }
-> phase 'classified': { divergence_id, accepted:true, recorded:[...] }
```
The report phase never proceeds silently: the gate is closed until decisions arrive.
Probe sessions are fresh (they only get the objective + one axis question), so they
cannot inherit the caller's narrowed framing.

## Panel contract (ui-builder)

Slot: `conversation.input.dock`, registration `{ name:'conversation.input.dock', id:'fanout-dock', order: 15 }`.
Component props available (standard props): `sessionId`, `useSession`, `inputActions`,
`useRemoteAccess`, `useResource`, `useAccess` — use only props actually passed; read
defensively (`props.sessionId` may be undefined).

UI: a compact, collapsible bar that matches the host theme (only `--dsw-alias-*` tokens,
no literal colors except artwork). Layout (rework 2026-11-17, see "Verified platform facts →
Theme tokens"):
- header row: connection dot, tree glyph, title `Fan-out`, then the **compact status group**
  (state dot + state word, run id, settled/total, failed count, est. tokens; `aria-live="polite"`),
  then the collapse toggle. The status lives here so it stays readable while collapsed.
- body, `max-width: 860px` so controls never stretch across a wide composer:
  - params strip (one sunken card, responsive 2-column grid): **分岐セッション数** 1..8
    (default 4) and **思考拡張** 0..100 (default 40). Each row is label (+ meaning badge
    `オフ / 浅く1軸 / 3軸 / 5軸 / 8軸+分類ゲート`) and value on the top line, track below;
  - fields grid (responsive 2 columns): objective textarea and tasks textarea side by side,
    verify input spanning the full width;
  - actions: 開始 (brand outline, primary) / 停止 / 更新.
- error line: bordered callout with a `state-error-primary` accent (was invisible before,
  because `--dsw-alias-danger-primary` does not exist in this theme).

### Theme tokens (verified against client inspect `Theme.listTokens`)
Exists: `bg-base`, `bg-layer-1`, `bg-layer-2`, `border-l1`, `border-l2`, `brand-primary`,
`label-primary/secondary/caption/tertiary`, `state-{success,error,warn,idle}-primary`.
**Does not exist:** `bg-sunken` (inputs had no fill), `danger-primary` (errors rendered in
`currentColor`), and any `font-size*` / `radius*` / `font-family*` alias (those fall back to
literal px in `client.js`). Do not reintroduce the two missing tokens.
Refresh by polling `GET /state` every 2s while mounted (clear the interval on unmount via
`ctx.effect`); all fetches go through `fetch('http://127.0.0.1:<port>/…', { headers: { 'x-fanout-token': token } })`,
token obtained from `GET /health` on mount. On failure, show a muted “未接続” line, never throw.
No DOM writes outside the component; no `document.body`; no host package imports.

Bridge responses the panel relies on:
- `GET /health` -> `{ ok, token, version }`
- `GET /state`  -> `{ ok, config:{workers, expansion}, runs:[{run_id,status,total,settled,failed,updated_at}], active_run_id? }`
- `POST /config` `{workers, expansion}` -> `{ ok, config }`
- `POST /start`  `{objective, tasks?:[{title,brief,weight?}], workers, expansion, verify?:string[], session_id?}` -> `{ ok, run_id }` or `{ ok, planning:true }` or `{ ok:false, error }`
  (`session_id` is the panel's current session so the run can notify it when finished.
  With no `tasks` and a `session_id`, the Host asks that session's model to decompose the
  objective and call `fanout_start` with tasks, so the sliders are not silently reduced to
  one worker.)
- `POST /stop`   `{run_id?}` -> `{ ok }`

`GET /state` gained per-run progress fields in 0.2.0 (`engine.uiRun()`):
`percent`, `phase` (`workers|integrating|done|failed|stopped`), `integrator_state`,
`created_at`, `objective`, `final_path`, `integrate`, `error`, and
`worker_details:[{index, state, weight, session_id, summary, tasks:[{id,title,weight}]}]`.
The numeric `workers` key stays reserved for the slider count, which is why the
per-worker array is `worker_details` and not `workers`.

### Sidebar progress board (0.2.0)

Two registrations with one identity — the shell matches a `sidebar.panellist` row to the
`main` panel by the same id, so both use `fanout`:

- `sidebar.panellist`, `{ id:'fanout', order:30, label: () => activeStrings.panelNavLabel }`
  renders `FanoutIcon`; owner props are `{ size, active }` (`SidebarPanelIconOwnerProps`).
  The icon is an inline SVG fan-out glyph: stroke `brand-primary` while selected,
  `label-secondary` otherwise. No artwork file, no imports.
- `main`, `{ key:'fanout' }` renders `FanoutPanel` — a page, not a dialog.

Each registration sits in its own `try`/`catch`: a host without `sidebar.panellist` must not
lose the `main` panel, and a host without `main` must not lose the row or the composer dock.

Progress numbers have exactly one owner: `lib/plan.js` `progressOf`/`phaseOf`, consumed by
`engine.uiRun()`. The client only renders them, with one documented exception: an old Host
that predates these fields. Then `client.js` derives the identical numbers from
`total`/`settled`/`status` (`progressOfRun`/`phaseOfRun`/`integratorStateOf`), and simply
omits what it cannot know (no worker chips, no elapsed clock — `updated_at` is not a start
time). Fields present from the Host always win.

Board layout: header (title, connection dot, 更新), one summary strip (running count,
settled/total workers, integrating count), then a section per live run and one for recent
runs. Each run card: shortened id, status pill, percent, elapsed, objective (1 line),
`role="progressbar"` bar with `aria-valuenow`, worker count row, stage strip
(`分岐実行 › 統合 › 完了`), one chip per worker (`W1 実行中 3件`, task titles in the `title`
attribute), then the integrator line and `final.md` path. The board polls `GET /state` on
its own 2s interval — the dock stops polling when collapsed, and the board must not freeze.

## Acceptance (whole plugin)

1. `node --check` passes on every JS file.
2. Bundle installs (`plugin_manager install_bundle`) and the row activates; tools appear
   in `cordis_inspect_query` Tool.listTools.
3. Web UI shows the dock with both sliders; changing a slider and pressing 開始 with a
   short objective starts a real run: N worker sessions appear and run, then one
   integrator session appears and completes, and the caller receives a follow-up summary.
4. `divergence_check` spawns fresh probe sessions and returns options; a second call with
   `decisions` closes the gate and writes `divergence/<id>.json`.
5. Stopping a run cancels outstanding workers and leaves durable state consistent.
6. Context discipline: worker prompts contain no parent transcript; integrator prompt
   contains only bounded result digests (≤1200 chars each, ≤8 results).

## Verification status (2026-11-16, this build)

| Check | Result |
|---|---|
| `node --check` on index.js, lib/*.js, client.js | pass |
| `node test/run-all.mjs` (54 checks) | pass |
| Panel rework (2026-11-17): real `renderDock` rendered headlessly at 1000px and 380px for 6 states (running / idle / collapsed / failed / offline / narrow); before vs after measured in the browser | pass. Root 1000×360 → 860×281, slider track 834 → 399 (two per row), fields gained a real fill (`rgba(0,0,0,0)` → `bg-base`), no horizontal overflow at 380px. Colours were supplied by representative dark-theme values in the harness, so this verifies geometry, hierarchy and state coverage — **not** the live theme's rendered pixels. |
| Engine state machine with fake `sessionController` (packing, settle, auto-integration, divergence gate, stop) | pass |
| Real `apply()` against a fake Cordis context: 4 tools, prompt section, global listeners, `/fanout-api` mount, loopback `/health`, tool→engine→auto-integration→completion, divergence probe, disposer closes the bridge | pass |
| Bundle package validation + install (pnpm, dependency saved) | pass |
| Live activation (bundle selection + HMR apply) | **blocked by the environment**: every `plugin_manager` mutation in this long-running Host fails with `operation-error: HMR transactions cannot be nested` (a pre-existing stuck HMR transaction; a concurrent session hit the same error independently). `list_bundles` shows `dsh-fanout: installed, enabled:false`. The bundle is therefore installed but not selected/loaded, so tools and the dock cannot appear until the Host restarts (or the stuck transaction clears) and the bundle is enabled. |

After a restart, activate with one of:
- Plugins page → Bundles → `dsh-fanout` → On, or
- `plugin_manager` `set_bundle` `{ target: "dsh-fanout", enabled: true }`.

## Config (`cordis.patch.yml` -> config)

| key | default | meaning |
|---|---|---|
| `enabled` | true | master switch |
| `maxWorkers` | 8 | hard cap for branch sessions |
| `defaultWorkers` | 4 | default branch count |
| `defaultExpansion` | 40 | default expansion slider value (0–100) |
| `maxExpansion` | 100 | hard cap |
| `workerTimeoutMinutes` | 25 | per-worker budget |
| `runTimeoutMinutes` | 120 | whole-run budget |
| `integrate` | true | default for the integration session |
| `archiveWorkers` | false | archive worker sessions after integration |
| `bridgePort` | 51337 | localhost control bridge port |
| `storeDir` | `~/.dsh/storages/fanout` | durable state root |
| `injectPrompt` | true | add the prompt section |
| `resultDigestChars` | 1200 | per-result cap in the integrator brief |
| `notifyCaller` | true | follow-up message into the delegating session |

## Constraints

- Windows host, Node from the DSH app. Use POSIX-style relative paths in state and
  workspace result files; use `path.resolve` for filesystem access.
- Never write into `~/.dsh/profiles/desktop` by hand; installation goes through
  `plugin_manager`.
- No new session event types. Plugin state lives in files, never in the session log.
- All user-visible strings in the UI go through the locale service; `locale/en.json`
  and `locale/ja.json` must both exist with `meta.title` / `meta.description`.

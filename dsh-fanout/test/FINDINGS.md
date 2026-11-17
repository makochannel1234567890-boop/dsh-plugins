# FINDINGS — independent verifier notes for dsh-fanout

Written from `test/` only; no file outside `test/` was modified. Method: read
`lib/plan.js`, `lib/prompts.js`, `lib/store.js`, `lib/bridge.js`, `lib/engine.js`,
`index.js`, `package.json`, `DESIGN.md`, then run `node test/run-all.mjs` with the
Harness Node (v24.18.0). Line numbers are from the files as read on
2026-11-16 ~23:28 JST; the Lead edited `lib/bridge.js` (23:22:59),
`lib/prompts.js` (23:24:31) and `lib/plan.js` (23:27:08) during the verification
window, so F1/F3/F4 below are recorded as verified-then-fixed historical findings.

Suite status at the time of writing: **54 of 54 checks pass** (`plan.test.mjs` 19,
`prompts.test.mjs` 18, `bridge.test.mjs` 17). All five findings below were observed during
this window and fixed by the Lead; F1/F3/F4/F5 now have passing regression checks, and F2
was verified with the repro below (store persistence is still outside the three required
files, so it has no in-suite assertion). If a check ever turns red it names its finding;
fix the library, never the assertion.

Severity key: blocker / high / medium / low.

---

## F1 — `POST /config` turned a legal `0` into the previous default (medium) — FIXED

- File: `lib/bridge.js:115` and `:119` (pre-fix numbering)
- Expected: the expansion slider's legal value `0` (panel contract: `0=オフ`) is stored as `0`;
  a requested `workers: 0` clamps to `1`.
- Actual (before fix): `Math.floor(Number(body.expansion) || config.defaultExpansion)` treated
  `0` as "missing", so `{workers: 2, expansion: 0}` persisted the previous/default expansion
  (`25` in the test, `40` by default). Same pattern for workers.
- Observed: `POST /config {"workers":2,"expansion":0}` → `{"config":{"workers":2,"expansion":25}}`
  and `store.saveConfig` received `25`. Check: `bridge.test.mjs` →
  "POST /config persists expansion 0 (slider \"off\")" failed with `25 !== 0`.
- Fix seen at 23:22:59: `rawWorkers`/`rawExpansion` + `Number.isFinite(...)` fallback
  (`lib/bridge.js:113-123`). The check now passes and stays as a regression test.
- Impact while open: the Web panel could never persist "思考拡張 = オフ".

## F2 — Store write failures are swallowed, so callers report success (medium) — FIXED

- File: `lib/store.js:51-53` (pre-fix numbering: `enqueue` did
  `this.queue = this.queue.then(task).catch(() => {})` and returned that already-caught chain).
- Expected: `saveConfig` / `saveRun` / `saveBridge` reject (or expose the failure) when the
  atomic write fails, so the bridge can answer `{ok:false}` instead of pretending to persist.
- Actual: every error is discarded inside `enqueue`; the returned promise resolves anyway.
  `bridge.js:124` awaits `saveConfig` and replies `{ok:true}`, and a stale `.tmp` file is
  left behind, while `config.json` still holds the old value (or is unreadable).
- Verified repro (run from the plugin root; creates/removes a temp dir):

  ```js
  import { promises as fsp } from 'node:fs'
  import path from 'node:path'
  import { FanoutStore } from './lib/store.js'

  const dir = path.join(process.cwd(), '.tmp-f2')
  await fsp.rm(dir, { recursive: true, force: true })
  await fsp.mkdir(path.join(dir, 'config.json'), { recursive: true }) // dir where the file belongs
  const store = new FanoutStore(dir)
  let rejected = false
  try { await store.saveConfig({ workers: 1 }) } catch { rejected = true }
  console.log('rejected:', rejected) // actual: false   expected: true
  console.log('config.json is dir:', (await fsp.stat(path.join(dir, 'config.json'))).isDirectory())
  console.log('tmp left:', await fsp.stat(path.join(dir, 'config.json.tmp')).then(() => true, () => false))
  await fsp.rm(dir, { recursive: true, force: true })
  ```

  Observed: `rejected: false`, `config.json is dir: true`, `tmp left: true`.
- Fix seen at 23:27:46: `lib/store.js:57-61` returns the per-write promise and only the serial
  chain swallows (`this.queue = run.catch(() => {})`), so callers see the failure while one
  bad write cannot block later ones. Re-ran the same repro: `rejected: true` (`EPERM`), and a
  following `saveConfig` after removing the blocking directory succeeds.
- Note: the three required test files still do not exercise `FanoutStore` (see README "Not
  covered"), so F2 has no in-suite assertion; the repro above is the verification evidence.

## F3 — `intensityPlan` read one past the end of its lookup table (low-medium) — FIXED

- File: `lib/plan.js:114` (pre-fix numbering, inside `intensityPlan` at line 112).
- Expected: the five levels 1–5 map onto five entries (i.e. index `level - 1`), so intensity 5
  is the widest plan and each level widens monotonically. `index.js` documents intensity 1–5
  as 1/2/3/5/8 orthogonal axes, so the maximum must not be the narrowest.
- Actual: `[0, 15, 45, 75, 100][level]` was off by one; level 5 read index 5 → `undefined`
  → `expansionPlan(undefined)` → the default slider 40 → 3 axes. Observed axes for 1..5:
  `1, 3, 5, 8, 3` (level 5 was narrower than level 4).
- Repro from the plugin root (pre-fix output):

  ```powershell
  node --input-type=module -e "import {intensityPlan} from './lib/plan.js'; console.log([1,2,3,4,5].map(i=>intensityPlan(i).axes))"
  # actual:   [ 1, 3, 5, 8, 3 ]
  # expected: strictly widening to 8
  ```

- Check exposing it: `plan.test.mjs` → "intensityPlan: intensity 1..5 widens monotonically to
  the widest plan".
- Fix seen at 23:27:08: `lib/plan.js:118-124` maps the level onto `[15,30,50,75,100]` and
  takes `axes` from `[1,2,3,5,8]` (`classify` follows the slider tier). Observed axes are now
  `1,2,3,5,8`; the check passes and remains as a regression guard. (Intentional consequence:
  `intensityPlan(2).label` still says `浅く1軸` while `axes` is 2; the new code comment says
  the non-axis fields keep the slider's thresholds, and the test does not assert labels.)

## F4 — Caller digest never printed "(not produced)" for an empty final path (low) — FIXED

- File: `lib/prompts.js:204` (pre-fix numbering).
- Expected: `renderCallerDigest` marks a missing final report, as its own fallback text says.
- Actual (before fix): `run.finalPath ?? '(not produced)'` keeps `''`, because `??` only
  replaces null/undefined. `FanoutEngine.start` initializes `finalPath: ''` and
  `maybeIntegrate` keeps `''` when `integrate:false`, so the fallback was unreachable for a
  real run; the digest ended with `Final report: ` and nothing after the colon.
- Observed: `prompts.test.mjs` → "renderCallerDigest: missing final report is marked" failed.
- Fix seen at 23:24:31: `lib/prompts.js:204-207` checks `typeof === 'string' && length > 0`.
  The check now passes and stays as a regression test.

## F5 — `divergenceAxes` returned zero axes for non-finite input (low) — FIXED

- File: `lib/prompts.js:57-58` (pre-fix numbering).
- Expected: clamp like the other helpers (e.g. 1 axis) or reject the input; a probe plan must
  never be silently empty.
- Actual: `Math.max(1, Math.floor(NaN))` was `NaN`, so `DIVERGENCE_AXES.slice(0, NaN)` was `[]`;
  `divergenceAxes()` and `divergenceAxes(NaN)` both returned an empty array.
- Repro: `node --input-type=module -e "import {divergenceAxes} from './lib/prompts.js'; console.log(divergenceAxes(NaN).length)"`
  → `0` before the fix (expected and now observed: `1`).
- Fix seen at 23:27:56: `lib/prompts.js:57-61` coerces with `Number()` and clamps non-finite
  input to one lens. `prompts.test.mjs` now asserts `divergenceAxes(NaN)` and
  `divergenceAxes(undefined)` both return exactly one axis.
- Impact: low — `engine.js` slices `DIVERGENCE_AXES` itself and never calls this helper.

---

## Observations (not classified as bugs; owner decision needed)

- **O1 — `parseOptionLines` lives in `lib/engine.js:63`, not `lib/prompts.js`.** The task brief
  expected it under prompts; `prompts.test.mjs` imports it from prompts first and falls back to
  engine, and fails loudly if neither exports it. No runtime issue; tests do not pin a location.
- **O2 — DESIGN's prompt-module export list is stale.** `DESIGN.md:102` names
  `renderProbeQuestion` and `summarizeEventText`; `prompts.js` actually exports
  `renderProbeBrief`, `renderCallerDigest`, `renderStatusLine`, `DIVERGENCE_AXES`,
  `divergenceAxes`. Nothing imports the missing names, so this is documentation drift.
- **O3 — expansion label differs from the DESIGN caption.** `expansionPlan(61..85).label` is
  `5軸+分類ゲート` (classify: true) while `DESIGN.md:161` captions 61–85 as `5軸`. The `classify`
  flag matches `engine`'s `required = axisCount >= 5`, so the label is arguably the accurate one;
  update DESIGN or the label, not the tests (they assert level/axes/classify, not this label).
- **O4 — `packTasks(null, n)` throws `TypeError`** (`tasks.length`); `packTasks([], n)` is safe
  and tested. Every in-repo caller passes an array, so this is an input-contract note, not a bug.

## Out of scope (not verified by this suite)

Live session orchestration (session create/prompt/settle/cancel, watchdog timers), caller
follow-ups, `FanoutStore` atomicity/restart recovery, divergence probe sessions end to end,
`client.js`/dock rendering, locale strings, browser CORS/CSP, plugin installation and Cordis
activation. See `test/README.md`.

---

## Lead addendum (2026-11-16 23:44 JST, after the verifier finished)

No test file was changed after the verifier's final run; the suite is 54/54 as reported.

- **O2 — CLOSED.** `DESIGN.md:102` now lists the shipped exports (`DIVERGENCE_AXES`,
  `divergenceAxes`, `renderProbeBrief`, `renderCallerDigest`, `renderStatusLine`).
- **O3 — CLOSED.** `DESIGN.md:162` captions 61–85 as `5軸+分類ゲート`, matching the shipped
  label and the engine's `required` rule.
- **O1 — ACCEPTED.** `parseOptionLines` stays in `lib/engine.js`; the tests already accept
  either home, and moving it after verification would be churn without a behaviour change.
- **Checks outside this suite** (Lead): `node --check` on every JS file; an offline engine
  state-machine run (packing, settle, auto-integration, divergence gate, stop); and a real
  `apply()` run against a fake Cordis context — 4 tools registered, prompt section, global
  `api-session/status` + `session/event` listeners, `/fanout-api` mount on the Web server,
  loopback `/health`, panel-start planning path, tool→engine→auto-integration→completion,
  one divergence probe, and the disposer closing the bridge. All passed.
- **Live activation is still blocked** by the Host's stuck HMR transaction
  (`HMR transactions cannot be nested`); the bundle is installed with `enabled:false`.
  See `DESIGN.md` → "Verification status" for the activation step after a restart.

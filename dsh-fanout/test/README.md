# dsh-fanout verifier suite

Dependency-free ESM tests for the `dsh-fanout` plugin. Plain Node, `node:assert/strict`,
no framework and no `node:test` (the Harness Node does not reliably expose a test runner).

## Run

From the plugin root:

```powershell
node test/run-all.mjs
```

Or from this directory:

```powershell
node run-all.mjs
```

A single file works too (`node test/plan.test.mjs`). Pass/fail is the process exit code;
each file prints one `ok  <suite> · <check>` line per check and a final count line.

- Node: verified on the Harness v24.18.0 (ESM, top-level await).
- Network: none, except `bridge.test.mjs`, which binds `127.0.0.1:51999`. If that port is
  busy, pick another: `$env:FANOUT_TEST_PORT = 52001; node test/run-all.mjs`.
- The bridge is always stopped in a `finally` block; a 30 s watchdog exits non-zero if a
  dangling server ever keeps the process alive.

## Covered

- `plan.test.mjs` — `normalizeTasks` (blank drops, `t1..tN` ids, weight 0.25–8, brief
  truncation + `maxBrief` clamp, `MAX_TASKS`/24), `packTasks` LPT (`[5,2,1]→5/3`,
  `[4,3,2,1]→5/5`, one id per task, worker-count clamp, empty input), `expansionPlan`
  boundaries 0/1/30/31/60/61/85/86/100, `intensityPlan`, `estimateBudget` (formula,
  positive, non-decreasing), `makeRunId` (`<prefix>-<14 digits>-<4 chars>`, filesystem-
  safe), `packingCovers`, `truncate`.
- `prompts.test.mjs` — `renderWorkerBrief` (objective, only its own task titles, result
  path `.dsh-fanout/runs/<id>/results/worker-N.md`, isolation text, <12k chars for a
  realistic run, 1800-char objective cap), `renderIntegratorBrief` (every digest,
  `resultDigestChars` truncation, verify commands, final path, explicit missing-digest
  marker), `renderProbeBrief` (a distinctive secret in `proposal` never appears while the
  objective does), `parseOptionLines` (only `OPTION:` lines, preamble ignored, max 4,
  200-char cap), `renderCallerDigest` (bounded with 50k-char inputs), `divergenceAxes`.
- `bridge.test.mjs` — fake engine/store against the real `startBridge`: `/health` token,
  401 without/with a wrong `x-fanout-token`, `/state` shape, `/fanout-api` prefix routes,
  OPTIONS preflight, `/start` 400 without objective + forwarded options, `/config`
  clamping (`maxWorkers`, `maxExpansion`) and persistence through the store, 0-value
  persistence, `/stop`, 404, malformed-JSON handling, POST auth.

## Known failures = findings

At the time of writing every check passes (54/54: plan 19, prompts 18, bridge 17). When a
check fails it names the finding (`F#`), and `FINDINGS.md` carries file:line, expected vs
actual, and a minimal repro — fix the library, never assert the buggy value. All five bugs
found during verification were fixed by the Lead and verified here: F1 `/config` zero, F2
store write errors swallowed (manual repro — `FanoutStore` is outside these three files),
F3 `intensityPlan` off-by-one, F4 empty final path, F5 `divergenceAxes` non-finite input.
The checks remain as regression guards.

## Not covered

- **Live session orchestration**: `engine.js` creating/prompting real sessions, settle
  events, cancellation, watchdog timers, caller follow-ups. Needs the running Harness.
- **UI rendering**: `client.js`, the dock, sliders, locale strings, real CORS/CSP in a
  browser.
- Plugin installation / Cordis activation (`plugin_manager`, `cordis_inspect_query`).
- Real persistence atomicity and restart recovery of `FanoutStore`; the bridge test uses
  a fake store.
- Divergence probe sessions end to end (only the pure brief builders and the option-line
  parser are tested).

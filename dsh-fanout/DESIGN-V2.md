# dsh-fanout v2 — the kernel contract (supersedes the v1 engine contract)

Status: implemented, tested (all 13 test files green) and **live**. The profile loads this
directory through a junction (`~/.dsh/profiles/desktop/node_modules/dsh-fanout` → this folder),
the Host reloaded on 2026-11-19, and the running tool set already carries the v2 kernel plus the
queue layer (`fanout_enqueue`, `queue` on `fanout_status`).
v1 behaviour is retained only as an adoption path (`migrateV1`); `index.js` now mounts
`lib/kernel.js`.

## Goal

Make one `fanout_start` call a **supervised task graph**, not a one-shot batch:
dependencies, contracts, independent review, repair rounds, retries and recovery are
enforced by code. The bar is "at least everything a captain-driven Agent Team does,
plus what a team cannot do cheaply": bounded context per session, a cost dial, and
automatic integration with evidence.

The Web dock is untouched: the Host emits the exact UI contract the dock already reads
(`lib/plan.js → progressOf/phaseOf`, `worker_details`), so no visual redesign was made.

## Capability matrix

| Capability | Agent Team (captain-driven) | fanout v1 | fanout v2 |
|---|---|---|---|
| Work shaping | task board + DAG | flat list, weight packing | **DAG** (`dependsOn`, cycle detection, readiness waves) |
| Quality contract | objective + acceptance + verify + scopes (quality kinds) | none | **same fields**, validated before spawn; missing verify rejects the run |
| Independent review | review task with `verdict=pass` | none | **fresh reviewer node** per completed task, `VERDICT/ACCEPT/FINDING` parsed |
| Repair loop | failed review → repair + next review | none | **automatic** repair node closing named findings, next round, escalation at `maxReviewRounds` |
| Evidence | commands run recorded | integrator asked to run them | **final report parsed**: sections + command/exit-code table required, one corrective retry |
| Ownership / attempts | attempt_id capability, stale rejected | none | **attempt token in every result**; stale or contract-violating answers are retried then failed |
| Retry / takeover | reassign, retry, captain takeover | stop only | `fanout_control retry|takeover` (cancels and re-attempts) |
| Steering | send_message | none | `fanout_control steer` (mode `steer` into the live session) |
| Editing pending work | edit_plan for never-started tasks | none | `fanout_control edit` (pending, zero attempts only; re-validates the DAG) |
| Approval | staged plan + explicit approve | starts immediately | `approval:"required"` stages; nothing spawns until `fanout_approve` |
| Pause / resume | halt + resume with reason | stop = cancel | `fanout_control pause|resume` (running sessions finish; scheduling halts) |
| Durable recovery | durable members | in-memory drivers lost | **adopts in-flight runs from `run.json`** (v2 and legacy v1), re-tracks sessions, resumes scheduling |
| Cost control | token budget per member | two sliders (rough) | two sliders + `estimateBudget` carried on the run |
| Context discipline | each member keeps a full thread | brief + 1200-char digest | same, **plus** per-task digests and bounded review input |
| Arming | none | none | **composer checkbox** (`POST /arm`); one-shot, per session, owned by the Host so a page reload cannot lose it |
| Fit gate (does it pay?) | none | none | **narrow / chain / small graphs refused** into a single session (`single_session: true` + reasons + guidance) |
| Budget decision | captain picks from the board | two sliders, cheap defaults | **parent session decides**; the Host enforces a generous floor (widest layer + 1, depth-scaled expansion + headroom) |
| Integration | captain coordinates | one integrator | one integrator, **report validated**, `finalPath` points at the file that exists |

## Run model (`run.json`, `v: 2`)

```
run:   id, status (staged|running|paused|integrating|completed|failed|stopped|escalated)
       phase (staged|workers|integrating|done), objective, cwd, tasks[], sessions[],
       maxConcurrent, maxReviewRounds, maxAttempts, reviewEnabled, gates{staged,paused,escalated,reason},
       integrator{sessionId,state,attempt,summary,problems}, estimate, deadlineAt, workerTimeoutMs,
       resultDigestChars, runDir, finalPath, error, warnings[]
task:  id, kind (work|requirements|implementation|verification|review|repair|integration),
       title, brief, weight, deps[], scope[],
       experts[] (Agency slugs the parent summoned for this job; review/repair inherit them),
       contract{objective, acceptance[], verify[], inScope[], outOfScope[]},
       state (pending|running|completed|failed|cancelled), attempt, attemptId, sessionId,
       finding/summary/digest/resultPath/error, acceptanceResults[], findings[], closed[],
       round, sourceTaskId, sourceFindingIds[], auto
```

`review` / `repair` nodes are spliced in while the run is live; the integrator only runs when
no node is pending or running and no node failed. A failing verdict at the round limit moves
the run to `escalated` (nothing is silently accepted, and `resume`/`retry` is available).

## Line protocols (enforced by `lib/gates.js`)

Worker result file (`.dsh-fanout/runs/<runId>/results/<attemptId>.md`):

```
<!-- fanout-result task=t1 attempt=t1-a1-abcd -->
## Summary / ## What changed / ## Verification / ## Acceptance / ## Changed paths /
## Closed findings / ## Open issues
- ACCEPT: <criterion verbatim> | passed|failed | <evidence>
- CLOSED: <finding id>
```

Reviewer answer: `VERDICT: pass|needs_revision|reject`, one `ACCEPT` per criterion,
`FINDING: <id> | <severity> | <problem> | <requiredFix> | <file> | <line>`.
A `pass` carrying a finding, or `needs_revision` with no finding, is invalid.

Integrator `final.md`: `## Outcome`, `## Conflicts and how they were resolved`,
`## Verification` (a real table row with command + exit code), `## Remaining gaps`,
`## Files of record`.

## Tools

| tool | purpose |
|---|---|
| `fanout_start` | objective + task graph (`dependsOn`, `kind`, `acceptance`, `verify`, scopes), `workers`, `expansion`, `verify`, `review`, `approval`, `maxReviewRounds` |
| `fanout_approve` | start a staged plan |
| `fanout_control` | `pause` / `resume` / `retry` / `steer` / `edit` / `takeover` / `stop` |
| `fanout_status` | task graph, attempts, verdicts, findings, gates, integrator, final path; reads `run.json` when the run is not live |
| `fanout_stop` | cancel the live sessions, keep the evidence |
| `divergence_check` | unchanged expansion gate (fresh probes, classification required) |

All v1 arguments keep working: a task without `kind` is `work`, review is skipped only when
`review:false`, and a v1 `run.json` is migrated into a single-wave graph.

## Recovery

`kernel.init()` lists `runs/*/run.json`, hydrates every non-terminal run (v2, or v1 →
`w1..wN` work nodes), re-creates the tracked-session table, asks `sessionController.list`
which sessions are still running, settles the ones that already finished, and resumes
scheduling. This is what makes a plugin reload or Host restart survivable: the workers are
ordinary sessions, so their ids are enough to re-attach.

## Context budget and filing (v2.1)

Every session starts with `SESSION_RULES` (byte-identical across runs) and the run facts
block (byte-identical across one run's sessions), then only its role slice. The stable prefix
is what lets a provider prefix cache hit; `manifest.json` records `prefix.sha256`, so a
contract change is visible as a cache miss by design.

- `lib/context.js` owns the budget: objective head (600 chars by default; the full text is
  always filed in `objective.md`), structured result digests (summary / changed / verified /
  open / findings — never a raw text slice), the manifest builder and the prefix hash.
- The integrator receives a manifest table (one row per task) plus the verification set, not
  one bounded digest per task.
- Every brief is filed as `prompts/<attempt>.md` before the session is prompted; every
  result and the final report are indexed with path + bytes + sha256.
- A second active run with the same objective in the same workspace is refused
  (`allowDuplicate: true` overrides). The observed failure mode was four duplicate wait-runs
  of one objective, each paying for its own reviewer and integrator sessions.
- A retried attempt/review is told what the previous one violated (`task.error`), so the
  common "missing marker / missing VERDICT" retry is not repeated blindly.

Measured with fixed fixtures (`node -e`, 2026-11-17), before → after:

| fixture | task brief | review brief | integrator | run total |
|---|---|---|---|---|
| 6 tasks, 1 criterion, 1,200-char brief | 3,906 → 4,370 | 3,946 → 3,402 | 9,474 → 3,374 | 56,586 → 50,006 |
| 24 tasks, 12 × 300-char criteria | 10,541 → 8,999 | 8,776 → 7,231 | 33,289 → 4,395 | 496,897 → 394,170 |

The task brief is slightly larger on a small fixture because the fixed prefix is paid once per
session; the mirror side is that the 1,547-char prefix is identical for every session of the
run, so only the unique tail is a cache miss, and the integrator no longer receives the
digest blast at all.

## Composer arming and the fit gate (v2.2)

The composer checkbox is a **one-shot intent**, not a mode. The Host holds it, the next
`fanout_start` from that session consumes it, and it expires after an hour — so a stale draft
cannot arm a later turn, and a worker session never inherits it.

```
POST /arm   {session_id, armed, mode: "auto"|"manual", workers?, expansion?}
GET  /state?session_id=<id>   ->   {..., armed: {armed, mode, workers?, expansion?, at?}}
```

`armed` is answered for the named session. A request without one gets
`{armed: false, mode: "auto"}`, so the dock renders "off" instead of guessing.

### The fit rule

Only the armed path enforces it; a direct `fanout_start` behaves exactly as before (backward
compatible, and the existing suites keep their 1-task fixtures). `lib/arm.js` levelises the DAG
by longest path and `graphFit(tasks)` refuses the graph when any of these hold:

| Condition | Why fan-out loses |
|---|---|
| `count < 3` | nothing runs in parallel; the reviewer round buys nothing |
| `width <= 1` with `count >= 2` | a pure chain — no layer ever runs two jobs side by side |
| `briefChars < 600` | the per-session fixed cost exceeds the work itself |

The refusal is a normal tool result, not a throw:

```
{ ok: false, single_session: true, downgraded: true,
  reasons: [...], metrics: {count, width, depth, parallelism, briefChars},
  tasks: [...], guidance: "run it in this session yourself ... force:true only if asked" }
```

### The budget

`decideBudget` sets the two dials on the same path. It is deliberately generous, because the
failure it replaces was the dials being *skipped* or left at a cheap default — which silently
removed the capability the user armed by checking the box.

```
workers   = min(maxWorkers,   widest layer + 1)          # never leave a freed slot idle
expansion = min(maxExpansion, 60 + 8 * (depth - 1) + 15) # depth-scaled, plus headroom
```

A larger caller value is honoured; a smaller one is clamped up. `mode: "manual"` uses the user's
dials verbatim, and the fit gate still applies (a manual user insisting on a chain passes
`force: true`). The decision rides on the run as `budget{workers, expansion, source, note}` and
`startResult` surfaces `budget`, `workers_concurrency` and `expansion` — so a caller sees what the
Host chose, not what it asked for.

### Who decides, and why

A prompt does not describe how the work will decompose; the Host cannot read the objective's
intent. **The parent session is the only party holding both the request and the graph it just
built**, so it decides — and the prompt section asks for one line stating the chosen numbers
before `fanout_start`. `objectiveFit` (bullets / length) exists only as a pre-turn *hint* for
the panel and is never the gate: a text heuristic cannot be trusted with a runtime decision.

## Config additions

| key | default | meaning |
|---|---|---|
| `review` | `true` | enable the independent review + repair loop |
| `maxReviewRounds` | `3` | review→repair rounds before escalation |
| `maxAttempts` | `2` | attempts per node before a contract violation becomes a failure |
| `approvalDefault` | `automatic` | set `required` to stage every model-initiated plan |
| `objectiveHeadChars` | `600` | how much of the objective every brief inlines (the full text is in `objective.md`) |
| `taskBriefChars` | `2000` | cap on one task's own instructions in its brief |
| `resultDigestChars` | `1200` | cap on the stored raw result slice (structured digests are used for prompts) |

## Files

- `lib/kernel.js` — state machine, scheduling, gates, recovery, controls, divergence.
- `lib/graph.js` — pure DAG rules (normalisation, readiness, review/repair splicing).
- `lib/arm.js` — pure fit rule (`graphFit`, `levelize`) and the automatic budget (`decideBudget`,
  `objectiveFit`). No Host dependencies, so both the refusal and the composer panel read the
  same verdict.
- `lib/gates.js` — pure parsers/validators for result, review, final report.
- `lib/context.js` — context budget, stable prefix, structured digests, manifest/filing rules.
- `lib/prompts2.js` — bounded briefs and the caller digest.
- `index.js` — tool registration, prompt section, listeners, bridge.
- `lib/engine.js` (v1) — retained: `lib/plan.js` UI helpers and the dock's existing tests
  still import parts of it; `index.js` no longer mounts it. Retirement trigger: delete once
  no test imports it.

## Verification (this build)

```
node --check index.js lib/*.js test/*.mjs      # pass
node test/run-all.mjs                          # 13 files, all pass
```

| suite | proves |
|---|---|
| `arm.test.mjs` | longest-path levelisation (`width`/`depth`), the three refusals, the auto budget (widest layer + margin, depth-scaled expansion), the caps, manual mode, and the objective hint |
| `ui-panel.test.mjs` (dock case) | the injected `conversation.input.dock` factory registers one checkbox, the settings body is always mounted as a collapsed `0fr` grid row with `visibility: hidden`, and the closed state still explains the single-session fallback |

| suite | proves |
|---|---|
| `context.test.mjs` | objective head bound, byte-identical shared prefix, structured digest (no raw slice), integrator manifest table, manifest sha256 indexing |
| `graph.test.mjs` | DAG normalisation, cycle/dep rejection, quality-contract rejection, readiness, review/repair deps |
| `gates.test.mjs` | marker/stale detection, acceptance coverage, repair closure, verdict rules, final-report evidence |
| `kernel.test.mjs` | fan-out + settle, dependency gating, stale retry, review→repair→escalate, integration rejection+retry+completion, controls, staged approval, restart recovery, v1 migration, **filing + manifest, duplicate-run refusal** |
| `apply.test.mjs` | real `apply()` on a fake Cordis context: 6 tools, prompt section, listeners, `127.0.0.1` bridge with token auth, tool→run→status→pause→stop |
| v1 suites | `plan` / `prompts` / `bridge` behaviour is unchanged |

Live activation is a separate step: the Host keeps the code it loaded at startup, so a
reload (or `plugin_manager` apply) is required for this kernel to become the running one.

## Live evidence (same machine, 2026-11-17 ~19:12 JST)

| check | observed |
|---|---|
| `plugin_manager set_bundle {target:"dsh-fanout"}` with this build on disk | `application: "applied"`; the loopback bridge token and `startedAt` rotated (`d81b…` → `d1fd…`), so the new instance is the live one |
| new prompt section / tools | the running session sees the v2 section and `fanout_approve` / `fanout_control` |
| **adoption of an in-flight v1 run** | `run-20261117090955-etni` was `integrating` when the reload happened; after it, `fanout_status` reports the migrated graph `w1..w5` all `completed`, the integrator session tracked (`session-8ca08b30…`, state `running`), and `gates` present — recovery re-attached the live sessions instead of dropping them |
| dock contract | `GET /state` returns `percent`, `phase`, `integrator_state`, `workers` and `worker_details[5]` for that adopted run (progress board renders the same dock, no redesign) |
| `fanout_status` over the live bridge | returns the task graph, totals, gates and estimate as JSON (an earlier `undefined` in an adopted run made the tool output non-lossless; fixed by computing `totals` and emitting `null`/`''` instead of `undefined`) |
| **adopted run finished by v2** | `run-20261117090955-etni` settled its integrator 2 min after the first reload; v2 parsed the report, set `status: completed`, `phase: done`, and `finalPath` to the workspace `final.md` that actually exists (9348 bytes). A second reload then read the run from disk (`source: "disk"`), so the completion is durable |
| dock after reload | `GET /state` lists the 5 most recent finished runs (`completed`, `percent: 100`, `final_path` set) plus `worker_details`, so the progress board is not empty after a restart |
| final report persistence | if the integrator leaves the report only in its session, the kernel now writes it to `<store>/runs/<id>/final.md` before reporting the path (the previous v1 behaviour could report a path with no file) |
| **fresh quality-gated run with real models** | `run-20261117103428-tjmy` in `.fanout-smoke`: 1 implementation task (`greet.js` + `test.js`) → automatic review node → `VERDICT: pass` → automatic integrator → `final.md` (3,223 bytes, all sections + a real command/exit-code table) → **completed** with `finalPath` pointing at the existing file. No repair round was needed |
| real-model protocol finding | the reviewer answered `VERDICT: pass` / `findings: 0` **without** per-criterion `ACCEPT:` lines, twice. The original rule rejected both attempts and failed the run. Fixed: a `pass` is now valid with zero findings; missing criterion coverage becomes a **warning** on the review task (`strictReviewAcceptance: true` restores the old rejection). `needs_revision`/`reject` still require at least one finding, and the worker still has to answer every criterion |
| late notification (found right after that run) | the failure digest from 19:39 arrived **after** the retry had completed the run at 19:44, and said "the orchestration is finished" for a state that was already stale. Fixed: the caller digest now carries `As of: <ISO> (status at send time: …)` and a failed run says it is **retryable** (`fanout_control retry`) instead of claiming completion. `prompts2.test.mjs` pins both wordings |

Not yet exercised live: a **fresh** quality-gated run (implementation → review → repair →
integration) against a real model. The kernel path is covered by `kernel.test.mjs` with a
fake controller; the remaining risk is a real worker not following the ACCEPT/FINDING
protocol exactly (default `work` tasks only require the marker + summary, so casual fan-out
is unaffected).

## Live evidence for v2.2 (same machine, 2026-11-19 00:12 JST)

| check | observed |
|---|---|
| `GET /fanout-api/health` on the live Web carrier | `ok: true`, port `51337` — the same-origin route is mounted on the running Host |
| `GET /fanout-api/state` | carries the new `armed` key: `{"armed":false,"mode":"auto"}` for a request that names no session |
| `POST /fanout-api/arm` round-trip | arm on → `{"ok":true,"session_id":"probe-sess","armed":true,"mode":"auto"}`; `GET /state?session_id=probe-sess` → `{"armed":true,"mode":"auto","at":…}`; arm off → `{"ok":true,"armed":false}`. The probe session was disarmed afterwards |
| client slot | `conversation.input.dock` occupants include `fanout-dock` (order 15, `active: true`), so the rebuilt dock is the registered component |
| full suite | `node test/run-all.mjs` → `ok all 13 test files` |

The dock test earned its place immediately: the first version of the rewrite still returned
`[titleRow, …]` while the variable had been renamed, `FanoutDock` swallowed the resulting
`ReferenceError` and rendered `null`. Without a render test that ships as "the dock silently
disappeared", not as a failing assertion.

**Not verified**: the visual morphing in a real page. The GUI needs its authenticated URL plus a
reload, so the animation is reviewed in code and covered by the offline dock test (structure,
collapsed state, handler wiring) — not by a screenshot.

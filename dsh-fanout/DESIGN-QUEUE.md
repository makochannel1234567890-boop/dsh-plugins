# The fan-out queue — one workspace, one task list

Status: implemented, covered by `test/queue.test.mjs` + `test/apply.test.mjs`, and **live**: the
profile loads this directory through a junction, the Host reloaded on 2026-11-19, so the running
plugin registers `fanout_enqueue` and injects its prompt section. Verified against the live tool,
not only offline: `fanout_enqueue({create:false})` resolves this workspace and refuses because
there is no live queue, and `fanout_status` carries `queue`.

## The failure this answers

Two symptoms were observed at once, on this machine:

1. **Two runs, one directory.** A parent that got more work started a *second* `fanout_start` in
   the same workspace. The two runs schedule independently, so their workers were told to edit the
   same files. The loser's file version was invalidated and its turn was cancelled
   (`FS_STALE_VERSION`, `FS_AMBIGUOUS_EDIT`), and a build broke under a half-written sibling edit.
   The same pattern showed up in the run history as repeated wait-runs of one objective.
2. **A session per follow-up.** Every "one more thing" spawned a fresh session, so the workspace
   accumulated sessions that each held a piece of the same file.

Splitting the *orchestration* across sessions made both worse: each parent believed it owned the
work and opened its own run.

## The decision

Orchestration stays in **one parent session** and work goes into **one append-only queue per
workspace**:

- `fanout_enqueue` appends to the live run for the workspace (creating it if there is none).
  `fanout_start` remains the "open a queue" call; nothing else should open a second one.
- A task declares the paths it writes (`scope` / `contract.inScope`). The scheduler admits a
  ready task only when its claims are disjoint from every running task's claims.
- The parent does not write the code. It shapes the work, appends, steers sessions it already
  knows, and re-plans. `fanout_control steer` accepts a bare `session_id` for exactly this.
- A task may name an existing session (`session_id`) instead of spawning a new one.

## The contract

```
write claim   = one workspace path prefix, normalised (separators folded, `.`/`..` resolved,
                case folded — folding can only serialise more, never less)
claim overlap = equal, or one is a `/`-bounded prefix of the other
              src/render ⊃ src/render/terrain.ts ;  src/foo ⊄ src/foobar
admission     = readyTask starts only if no running task holds an overlapping claim;
                otherwise it stays `pending` and is reported in `run.scopeWaits`
```

`queue` rides along on `fanout_status`, so the parent sees *who holds the path* instead of
guessing why nothing starts:

```
queue: { total, running[], pending[], ready[], groups{}, unclaimed[],
         scope_blocked: [{ id, blocked_by[], path }], hint }
```

`run.scopeWaits` in `run.json` records what the last `schedule()` decided, for a post-mortem.
It is deliberately not exposed through `fanout_status`: it goes stale the moment a task settles,
while `queue` is recomputed live on every read.

## Files

| file | role |
|---|---|
| `lib/queue.js` | pure rules: claims, overlap, `admit`, `appendTasks`, `queueView`, `findQueueRun` |
| `lib/queue-tools.js` | `fanout_enqueue` + its prompt section (self-contained registration) |
| `lib/kernel.js` | `schedule()` admits by claim; `appendTasks()`; `steer` by `session_id`; `spawnSession({sessionId})` adoption; `status()` carries the queue |
| `index.js` | two lines: import + `registerQueueTools(...)` |

Keeping the rules in `lib/queue.js` is what makes them testable without a Host, and is why this
layer could be added while the run lifecycle in `kernel.js` was being edited by another session.

## What each piece proves

- `test/queue.test.mjs` — claim normalisation, prefix-bounded overlap (not a bare string prefix),
  a second claimant deferred with the holder named, disjoint claims starting together, the
  concurrency limit reported separately from a scope wait, undeclared work staying parallel by
  default, append id allocation + dependency on already-live tasks, atomic rejection (bad contract
  or cycle leaves the queue untouched), the task cap, the queue view, and queue selection
  (newest live run for that directory only).
- `test/apply.test.mjs` — the tool is registered; `fanout_enqueue` appends to the paused live run
  **without spawning a session**; a dependency that does not exist is rejected and the queue is
  unchanged.

## Deliberate limits

- **Undeclared scopes are not serialised by default.** Refusing to schedule undeclared work would
  serialise every casual fan-out, and the old behaviour has to keep working. The queue view
  reports such tasks in `unclaimed` so the parent fixes the brief instead. A run may opt into
  full serialisation with `scopeSerialization: true`.
- **Claims are path prefixes, not globs.** `src/*.ts` is not expanded; declare the directory.
- **Adoption is one attempt.** After the prompted task succeeds, `adoptSessionId` is cleared so a
  retry does not reuse a session that has moved on. A session fan-out already tracks is refused.
- **The queue is per directory, not per objective.** Two genuinely independent projects are
  isolated by their `cwd`; two batches of one project belong in the same queue, which is the
  point.

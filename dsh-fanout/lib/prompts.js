/**
 * Prompt builders for dsh-fanout.
 *
 * Every builder enforces a hard size bound: the point of the plugin is that a
 * worker session never receives the parent transcript and the integrator never
 * receives full worker transcripts — only bounded digests.
 *
 * @module dsh-fanout/lib/prompts
 */

import { truncate } from './plan.js'

/** Eight orthogonal lenses. Each probe sees exactly one, so it cannot converge. */
export const DIVERGENCE_AXES = Object.freeze([
  {
    id: 'invert',
    label: '制約の反転',
    ask: 'If the binding constraint named below were reversed (removed, or made mandatory instead of forbidden), which approaches become possible that were impossible before?',
  },
  {
    id: 'redefine',
    label: '目的の再定義',
    ask: 'What is the real job to be done here? Name 2–4 approaches that serve that deeper job while ignoring the stated framing of the request.',
  },
  {
    id: 'failure',
    label: '失敗先行',
    ask: 'Assume the obvious solution was shipped and failed badly six months later. What exactly failed, and which approaches would have avoided that failure mode?',
  },
  {
    id: 'zoom',
    label: 'ズーム（10倍 / 0.1倍）',
    ask: 'What approach works if the problem were ten times larger (scale, users, data), and what approach works if it were ten times smaller? Name both.',
  },
  {
    id: 'stakeholder',
    label: '利害関係者の交代',
    ask: 'Who else pays for or benefits from this? Name 2–4 approaches that optimise for a stakeholder the requester did not mention.',
  },
  {
    id: 'reuse',
    label: '既存解の流用',
    ask: 'What existing tool, library, pattern, or process already solves 80% of this? Name concrete reuse / composition approaches instead of new construction.',
  },
  {
    id: 'subtract',
    label: '削除テスト',
    ask: 'Which part of the assumed solution could be deleted entirely with no loss? Name approaches that remove work rather than add it.',
  },
  {
    id: 'asymmetry',
    label: '非対称な機会',
    ask: 'What small, cheap move would unlock disproportionate value here — and what large expensive move would still be worthless afterwards? Name both.',
  },
])

export function divergenceAxes(intensity) {
  const raw = Number(intensity)
  const requested = Number.isFinite(raw) ? Math.floor(raw) : 1
  const count = Math.min(DIVERGENCE_AXES.length, Math.max(1, requested))
  return DIVERGENCE_AXES.slice(0, count)
}

function bulletList(lines) {
  return lines.length === 0 ? '（なし）' : lines.map((line) => `- ${line}`).join('\n')
}

function taskBlock(task, index) {
  const scope = task.scope.length > 0 ? `\n  Scope hints: ${task.scope.join(', ')}` : ''
  return `${index + 1}. [${task.id}] ${task.title} (weight ${task.weight})${scope}\n   ${task.brief}`
}

/**
 * The worker brief. Small by construction: objective, this worker's tasks, the
 * result-file contract, and the interface rules shared by every worker.
 */
export function renderWorkerBrief(run, bucket) {
  const tasks = bucket.taskIds
    .map((id) => run.tasks.find((task) => task.id === id))
    .filter((task) => task !== undefined)
  const resultPath = `.dsh-fanout/runs/${run.id}/results/worker-${bucket.index + 1}.md`
  const resultAbsolute = run.cwd ? `${run.cwd.replace(/[\\/]+$/, '')}/${resultPath}` : resultPath
  return `<fanout_worker run="${run.id}" worker="${bucket.index + 1}">
Shared objective: ${truncate(run.objective, 1800)}

Your assignment (${tasks.length} task${tasks.length === 1 ? '' : 's'}):
${tasks.map(taskBlock).join('\n')}

Isolation rules (they keep the whole run cheap and safe):
- You do NOT have the parent conversation. Do not try to reconstruct it.
- Other workers handle other slices of the same objective in parallel. Stay inside your assignment; do not edit files another worker's task names unless yours requires it.
- Read the workspace before changing it, and verify instead of assuming.

Deliverable — write this file before you answer:
${resultAbsolute}
(or the same relative path ${resultPath} if you prefer relative paths)

Use exactly these sections:
# Worker ${bucket.index + 1} — result
## Summary
(≤200 characters, human-readable)
## What changed
(files, with one line each)
## Verification
(commands you actually ran + observed result)
## Open issues
(anything the integrator must resolve, or "none")

Then reply in this session with the same summary (≤200 characters) plus any blocker.
</fanout_worker>`
}

/**
 * The integrator brief. It receives only bounded result digests, the run's
 * verification commands, and the final-report contract.
 */
export function renderIntegratorBrief(run) {
  const limit = run.resultDigestChars ?? 1200
  const sections = []
  for (const worker of run.workers) {
    const digest = truncate(worker.digest ?? '', limit)
    const state = worker.state ?? 'unknown'
    sections.push(
      `### Worker ${worker.index + 1} — ${state}\nTasks: ${worker.taskIds.join(', ')} · session: ${worker.sessionId}\n${digest.length > 0 ? digest : '(no digest — treat this worker as missing and say so explicitly)'}`,
    )
  }
  const verify = Array.isArray(run.verify) && run.verify.length > 0
    ? run.verify.map((command, index) => `${index + 1}. ${command}`).join('\n')
    : '1. Discover the project\u2019s own check commands (package.json scripts, task files) and run the full e2e/build set.'
  const finalPath = `.dsh-fanout/runs/${run.id}/final.md`
  const finalAbsolute = run.cwd
    ? `${run.cwd.replace(/[\\/]+$/, '')}/${finalPath}`
    : finalPath
  return `<fanout_integrate run="${run.id}">
Objective: ${truncate(run.objective, 1800)}

Worker results (bounded digests; the full files are under .dsh-fanout/runs/${run.id}/results/):
${sections.join('\n\n')}

Your job, in order:
1. Read the worker result files and the actual workspace state. The digests above are hints; verify before trusting.
2. Reconcile the slices: name conflicts, duplicated work, and anything a worker claimed but did not implement.
3. Run the verification set and record the exact command and exit code for each:
${verify}
4. Fix only integration-level breakage (merge conflicts, missing wiring, failing build). Do not redo a worker's task wholesale.
5. Write ${finalAbsolute} (or ${finalPath}) with exactly these sections:
# Fan-out final report
## Outcome
## Conflicts and how they were resolved
## Verification
| command | exit code | evidence |
## Remaining gaps
## Files of record
6. Reply in this session with a ≤12-line summary: outcome, verification status, and gaps.

Do not claim a command passed unless you ran it in this session after the last change.
</fanout_integrate>`
}

/**
 * One fresh-context probe. It receives the objective and one axis only — never
 * the caller's proposal — which is what stops the probe from inheriting the
 * caller's narrowed framing.
 */
export function renderProbeBrief(divergence, axis) {
  const constraints = Array.isArray(divergence.constraints) && divergence.constraints.length > 0
    ? bulletList(divergence.constraints.map((item) => truncate(item, 300)))
    : '（制約の明示なし）'
  const resultPath = `.dsh-fanout/divergence/${divergence.id}/${axis.id}.md`
  return `<divergence_probe id="${divergence.id}" axis="${axis.id}">
Problem (verbatim from the requester):
${truncate(divergence.objective, 2400)}

Stated constraints:
${constraints}

Your lens — ${axis.label}:
${axis.ask}

Rules:
- Produce 2–4 GENUINELY different candidate approaches for this problem, seen through your lens only.
- Do not assume any existing plan, proposal, or architecture: none was given to you.
- One line per option, starting with "OPTION:" followed by the approach in ≤160 characters. No preamble, no restating the problem.
- Prefer options that are materially different from each other, not variations of one idea.
- If your lens yields nothing useful, write exactly "OPTION: none — <one-line reason>".

Write those lines to ${resultPath}, then reply with the same OPTION lines only.
</divergence_probe>`
}

/** A short, bounded follow-up for the delegating session. */
export function renderCallerDigest(run) {
  const lines = [
    `<fanout_result run="${run.id}" status="${run.status}">`,
    `Objective: ${truncate(run.objective, 400)}`,
    `Workers: ${run.workers.filter((worker) => worker.state === 'settled').length}/${run.workers.length} settled`,
  ]
  for (const worker of run.workers) {
    lines.push(
      `- worker ${worker.index + 1} [${worker.state}] ${truncate(worker.summary ?? worker.digest ?? '', 220)}`,
    )
  }
  if (run.integrator?.summary) {
    lines.push(`Integrator: ${truncate(run.integrator.summary, 600)}`)
  }
  const finalPath = typeof run.finalPath === 'string' && run.finalPath.length > 0
    ? run.finalPath
    : '(not produced)'
  lines.push(`Final report: ${finalPath}`)
  lines.push(`Run state: ${run.runDir ?? '(unknown)'}`)
  lines.push(
    'The orchestration is finished. Report this outcome to the user; do not restart the workers.',
  )
  lines.push('</fanout_result>')
  return lines.join('\n')
}

/** Compact one-line status used by tools and the UI bridge. */
export function renderStatusLine(run) {
  const settled = run.workers.filter((worker) => worker.state !== 'running').length
  return `${run.id} · ${run.status} · workers ${settled}/${run.workers.length} · ${new Date(run.updatedAt).toISOString()}`
}

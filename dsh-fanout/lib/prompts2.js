/**
 * Prompt builders for the dsh-fanout v2 kernel.
 *
 * Every brief is bounded on purpose and starts with the same shared prefix
 * (`lib/context.js`): first the run-independent rules, then the per-run facts.
 * A brief only appends the role block and the task slice, so the expensive
 * shared part is stable enough to hit a prefix cache and a later stage never
 * receives a transcript.
 *
 * The line protocol described here is enforced by lib/gates.js.
 *
 * @module dsh-fanout/lib/prompts2
 */

import {
  compactResult,
  finalRelative,
  manifestRelative,
  manifestTaskRows,
  objectiveRelative,
  objectiveHead,
  promptRelative,
  renderRunFacts,
  resultRelative,
  runDirRelative,
  SESSION_RULES,
  workspacePath,
} from './context.js'
import { stateSummary } from './graph.js'
import { clampInt, truncate } from './plan.js'

function bullets(lines, empty = '（なし）') {
  return lines.length === 0 ? empty : lines.map((line) => `- ${line}`).join('\n')
}

function bulletLines(text, max = 8) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*]\s+/, '').trim())
    .filter((line) => line.length > 0)
    .slice(0, max)
}

function taskBriefChars(run) {
  return clampInt(run.taskBriefChars, 2000, 400, 4000)
}

/** Every brief starts with exactly these bytes for the run. */
export function briefPrefix(run) {
  return `${SESSION_RULES}\n\n${renderRunFacts(run)}`
}

export { resultRelative, finalRelative, promptRelative, objectiveRelative, manifestRelative }

/** The brief for one task attempt. */
export function renderTaskBrief(run, task, attemptId) {
  const relative = resultRelative(run, task, attemptId)
  const absolute = workspacePath(run, relative)
  const contract = task.contract ?? {}
  const acceptance = contract.acceptance ?? []
  const verify = contract.verify ?? []
  const quality = ['requirements', 'implementation', 'verification', 'repair', 'integration'].includes(task.kind)
  const repairBlock = task.kind === 'repair'
    ? `\nFindings this attempt must close (one CLOSED line each):\n${bullets((task.sourceFindingIds ?? []).map((id) => id), '（なし）')}\n`
    : ''
  const scopeBlock = (contract.inScope ?? []).length > 0
    ? `\nFiles you may change (stay inside; name anything else under Open issues):\n${bullets(contract.inScope)}\n`
    : ''
  const outBlock = (contract.outOfScope ?? []).length > 0
    ? `\nFiles you must not change:\n${bullets(contract.outOfScope)}\n`
    : ''
  const expertBlock = Array.isArray(task.experts) && task.experts.length > 0
    ? `\nExpert lenses this job was shaped with (summoned by the parent session; keep their bar — evidence over claims, and the criteria they demanded):\n${bullets(task.experts)}\n`
    : ''
  const retryHint = Number(task.attempt ?? 1) > 1 && typeof task.error === 'string' && task.error.length > 0
    ? `\nPrevious attempt was rejected — fix this first:\n${truncate(task.error, 300)}\n`
    : ''
  return `${briefPrefix(run)}

<fanout_task task="${task.id}" kind="${task.kind}" attempt="${attemptId}">
Task: ${task.title}${task.brief.length > 0 ? `\n${truncate(task.brief, taskBriefChars(run))}` : ''}
${expertBlock}${retryHint}

Contract:
- objective: ${truncate(contract.objective ?? task.title, 600)}
- acceptance criteria (answer every one with an ACCEPT line):
${bullets(acceptance)}
- verification commands that must appear in your evidence:
${bullets(verify)}
${scopeBlock}${outBlock}
Write this result file before you answer:
${absolute}
(or ${relative})

Use exactly this shape (a missing marker or ACCEPT line fails the task):
<!-- fanout-result task=${task.id} attempt=${attemptId} -->
# Task ${task.id} — result
## Summary — one line, ≤200 characters
## What changed — one "- <path>: <one line>" per file
## Verification — one "- \`<command>\` → <observed result / exit code>" per command
## Acceptance — one "- ACCEPT: <criterion verbatim> | passed | <evidence>" per criterion
${repairBlock}## Changed paths — "- <path>" per changed file
## Closed findings — one "- CLOSED: <finding id>" per finding (repair rounds)
## Open issues — "- <anything the integrator must resolve>" or "- none"

Rules:
- Copy each acceptance criterion verbatim; use "failed" only when it is genuinely not met (that opens a repair round).
- Then reply in this session with the Summary line plus any blocker.
${quality ? '- This task is reviewed by a fresh reviewer before the run can finish.\n' : ''}</fanout_task>`
}

/**
 * Reviewer brief: fresh context, the contract, and a bounded structured digest
 * of the result. The reviewer reads the real files; the digest is only a map.
 */
export function renderReviewBrief(run, source, reviewTask, digest, verifyObserved) {
  const contract = source.contract ?? {}
  const acceptance = contract.acceptance ?? []
  const relative = `.dsh-fanout/runs/${run.id}/results/${reviewTask.id}-${reviewTask.attempt}.md`
  const absolute = workspacePath(run, relative)
  const sourceRelative = source.attemptId ? resultRelative(run, source, source.attemptId) : ''
  const compact = compactResult(source, 600) || truncate(digest, 600) || '(no result summary recorded)'
  const retryHint = Number(reviewTask.attempt ?? 1) > 1 && typeof reviewTask.error === 'string' && reviewTask.error.length > 0
    ? `\nPrevious review attempt was rejected — fix this first:\n${truncate(reviewTask.error, 240)}\n`
    : ''
  return `${briefPrefix(run)}

<fanout_review review="${reviewTask.id}" source="${source.id}" round="${reviewTask.round}">
You are the independent reviewer for one task. You did not write this work.
Task under review: ${source.title} (kind ${source.kind})
Contract objective: ${truncate(contract.objective ?? source.title, 600)}
${retryHint}

Acceptance criteria (judge every one):
${bullets(acceptance)}

Verification commands the contract requires:
${bullets(contract.verify ?? [])}

Bounded result summary (read the real files yourself; full result: ${sourceRelative || relative}):
${compact}

${source.kind === 'repair' ? `Findings this repair claimed closed:\n${bullets(source.sourceFindingIds ?? [], '（なし）')}` : 'Repair-round findings claimed closed: （修復ラウンドではない）'}

How to review:
1. Read the changed files and the full result under ${runDirRelative(run)}/results/. Verify claims against the workspace; do not trust the summary.
2. Run at least one contract verification command when it is safe and local; record what you saw.
3. Do not modify the implementation. You produce a judgement, not a patch.

Write the same answer to ${absolute} (or ${relative}):
VERDICT: pass | needs_revision | reject
ACCEPT: <criterion verbatim> | passed | <evidence you observed>
FINDING: F1 | <blocker|high|medium|low> | <what is wrong> | <the minimum fix> | <file> | <line>

Rules:
- pass only when every criterion is genuinely met and no FINDING exists.
- needs_revision / reject must list at least one FINDING (a repair round is dispatched from those ids).
- Judge the current workspace state, not the worker's claims.
Then reply in this session with the VERDICT line and the finding count only.
</fanout_review>`
}

/** Integrator brief: the manifest index, not a pile of digests. */
export function renderIntegratorBrief(run) {
  const rows = manifestTaskRows(run)
  const table = [
    '| task | kind | state | summary | result |',
    '| --- | --- | --- | --- | --- |',
    ...rows.map((row) => {
      const cell = (value, max) => truncate(String(value ?? '').replace(/\|/g, '/').replace(/\s+/g, ' '), max)
      return `| ${cell(row.id, 40)} | ${cell(row.kind, 20)} | ${cell(row.state, 20)} | ${cell(row.summary, 120) || '—'} | ${cell(row.result, 120) || '—'} |`
    }),
  ].join('\n')
  const verify = Array.isArray(run.verify) && run.verify.length > 0
    ? run.verify.map((command, index) => `${index + 1}. ${command}`).join('\n')
    : '1. Discover the project\u2019s own check commands (package.json scripts, task files) and run the full e2e/build set.'
  const relative = finalRelative(run)
  const absolute = workspacePath(run, relative)
  const manifest = manifestRelative(run)
  return `${briefPrefix(run)}

<fanout_integrate manifest="${manifest}">
You are the integrator for this fan-out run. You receive an index, not transcripts.
Task index (full manifest: ${manifest}; hashes and sizes: ${runDirRelative(run)}/manifest.json):
${table}

Your job, in order:
1. Read ${manifest} (or manifest.json) and then only the result files you need. Verify claims against the workspace.
2. Reconcile the slices: name conflicts, duplicated work, and anything claimed but not implemented.
3. Run the verification set and record the exact command and exit code for each:
${verify}
4. Fix only integration-level breakage (merge conflicts, missing wiring, failing build). Do not redo a task wholesale.
5. Write ${absolute} (or ${relative}) with EXACTLY these sections — the engine parses them and fails the run when they are missing:

# Fan-out final report
## Outcome
(two or more sentences: what is actually true now)
## Conflicts and how they were resolved
## Verification
| command | exit code | evidence |
| --- | --- | --- |
|<command> | <0> | <what you observed>|
## Remaining gaps
## Files of record

6. Reply in this session with a ≤12-line summary: outcome, verification status, and gaps.

Do not claim a command passed unless you ran it in this session after the last change.
</fanout_integrate>`
}

/** A corrective retry after the final report failed validation. */
export function renderIntegratorRepair(run, problems) {
  return `<fanout_integrate_fix run="${run.id}">
The previous final report was rejected by the contract checker:
${problems.map((problem) => `- ${problem}`).join('\n')}

Rewrite ${finalRelative(run)} (or ${workspacePath(run, finalRelative(run))}) with the required sections, and make ## Verification a real command/exit-code table produced by commands you actually ran in this session. Do not re-run the whole integration; only repair the report and any check that genuinely fails.
</fanout_integrate_fix>`
}

/** Human/model facing summary of a staged plan (approval phase). */
export function renderStagedPlan(run) {
  const lines = [`<fanout_plan run="${run.id}" status="staged">`, `Objective: ${truncate(run.objective, 400)}`, 'Tasks:']
  for (const task of run.tasks) {
    const deps = (task.deps ?? []).length > 0 ? ` deps=${task.deps.join(',')}` : ''
    const contract = task.contract ?? {}
    lines.push(
      `- ${task.id} [${task.kind}] w=${task.weight}${deps} — ${task.title} (acceptance ${contract.acceptance?.length ?? 0}, verify ${contract.verify?.length ?? 0})`,
    )
  }
  lines.push(`Workers (max concurrent): ${run.maxConcurrent}`)
  lines.push(`Review: ${run.reviewEnabled ? 'on (fresh reviewer → repair loop)' : 'off'}`)
  lines.push('')
  lines.push('Call fanout_approve with this run_id (or ask the human) to start it. Nothing has been spawned yet.')
  lines.push('</fanout_plan>')
  return lines.join('\n')
}

/** The bounded follow-up delivered into the delegating session. */
export function renderCallerDigest(run) {
  const lines = [
    `<fanout_result run="${run.id}" status="${run.status}">`,
    `Objective: ${truncate(run.objective, 300)}`,
  ]
  for (const task of run.tasks) {
    const mark = task.state === 'completed' ? 'ok' : task.state
    lines.push(
      `- ${task.id} [${mark}] ${truncate(task.summary || task.digest || '', 180)}`,
    )
  }
  const findings = run.tasks.flatMap((task) => task.findings ?? [])
  if (findings.length > 0) lines.push(`Open findings: ${findings.map((item) => item.id).join(', ')}`)
  if (run.integrator?.summary) lines.push(`Integrator: ${truncate(run.integrator.summary, 500)}`)
  const finalPath = typeof run.finalPath === 'string' && run.finalPath.length > 0 ? run.finalPath : '(not produced)'
  lines.push(`Final report: ${finalPath}`)
  lines.push(`Run state: ${run.runDir ?? '(unknown)'}`)
  if (typeof run.manifestPath === 'string' && run.manifestPath.length > 0) {
    lines.push(`Manifest: ${run.manifestPath}`)
  }
  // Late deliveries happen (the caller may be mid-turn), so the digest carries
  // its own timestamp and never claims "finished" for a run that can be retried.
  lines.push(`As of: ${new Date(run.updatedAt ?? Date.now()).toISOString()} (status at send time: ${run.status})`)
  const footer = run.status === 'failed'
    ? 'The run stopped with failed work; this state is retryable. Check the task errors above, then use fanout_control retry (run_id + task_id) to resume it. Do not restart the workers yourself.'
    : run.status === 'escalated'
      ? 'The review loop hit its round limit. Inspect the findings in run.json and use fanout_control retry/resume after a decision.'
      : 'The orchestration is finished. Report this outcome to the user; do not restart the workers.'
  lines.push(footer)
  lines.push('</fanout_result>')
  return lines.join('\n')
}

/** Compact per-task state for fanout_status. */
export function renderStatusSummary(run) {
  const totals = run.totals ?? stateSummary(run.tasks ?? [])
  return {
    run_id: run.id,
    status: run.status,
    phase: run.phase ?? 'workers',
    objective: truncate(run.objective, 240),
    totals,
    tasks: run.tasks.map((task) => ({
      id: task.id,
      kind: task.kind,
      state: task.state,
      deps: task.deps,
      attempt: task.attempt,
      round: task.round,
      auto: task.auto === true,
      verdict: task.reviewVerdict || '',
      findings: (task.findings ?? []).map((item) => ({ id: item.id, severity: item.severity, problem: item.problem })),
      closed: task.closed ?? [],
      summary: truncate(task.summary ?? '', 240),
      error: task.error || '',
    })),
    gates: run.gates ?? { staged: false, paused: false, escalated: false, reason: '' },
    integrator: run.integrator ?? null,
    final_path: run.finalPath,
    run_dir: run.runDir,
    manifest_path: run.manifestPath ?? '',
    estimate: run.estimate ?? null,
    error: run.error || '',
  }
}

export { bulletLines, objectiveHead }

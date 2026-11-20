/**
 * Context budget, stable-prefix and filing helpers for dsh-fanout v2.
 *
 * A fan-out run spawns many sessions from one objective. Every token that is
 * repeated in each brief is paid for once per session, so this module keeps the
 * three things that made the old briefs expensive under control:
 *
 *   1. **One stable prefix.** `SESSION_RULES` is byte-identical for every role
 *      and every run; the run facts block is byte-identical for every session
 *      of one run. Prefix caching can then hit on the shared part instead of
 *      missing on byte one (the old briefs put a different tag line first).
 *   2. **Bounded, structured digests.** A result is summarised from its parsed
 *      fields (summary / changed paths / verification / open issues) instead of
 *      pasting the first N characters of the raw answer.
 *   3. **A manifest.** Everything a later stage would otherwise receive is
 *      filed on disk and indexed with path + bytes + sha256, so a session can
 *      read exactly the files it needs and prove it read the current bytes.
 *
 * Pure module (node:crypto only) so the budget rules are unit-testable.
 *
 * @module dsh-fanout/lib/context
 */

import { createHash } from 'node:crypto'

import { clampInt, truncate } from './plan.js'

/**
 * Prompt-contract version. Bumping it invalidates the cached prefix on purpose:
 * the manifest records the version and hash the run was built with.
 */
export const CONTRACT_VERSION = '2.1'

/** Shared by worker, reviewer and integrator briefs. Never contains run data. */
export const SESSION_RULES = `<fanout_rules version="${CONTRACT_VERSION}">
One bounded session of a fan-out run. You do not have the parent conversation and must not try to reconstruct it.
- Read before you change; verify instead of assuming. Other sessions run other slices in parallel — stay inside your assignment.
- Every claim in your answer must be something you observed in this session; never claim a command passed unless you ran it.
- Prefer the files named below over guessing. If an input is missing, say so under Open issues.
- The output format at the END is parsed literally: a missing marker or line fails the task and costs a retry.
- Keep it small: the next stage reads your summary; detail belongs in the result file.
</fanout_rules>`

/** Absolute default for how much of the objective a session sees inline. */
export const DEFAULT_OBJECTIVE_HEAD_CHARS = 600

export function runDirRelative(run) {
  return `.dsh-fanout/runs/${run.id}`
}

export function objectiveRelative(run) {
  return `${runDirRelative(run)}/objective.md`
}

export function manifestRelative(run) {
  return `${runDirRelative(run)}/manifest.md`
}

export function manifestJsonRelative(run) {
  return `${runDirRelative(run)}/manifest.json`
}

export function promptRelative(run, task, attemptId) {
  return `${runDirRelative(run)}/prompts/${attemptId}.md`
}

export function finalRelative(run) {
  return `${runDirRelative(run)}/final.md`
}

export function resultRelative(run, task, attemptId) {
  return `${runDirRelative(run)}/results/${attemptId}.md`
}

export function workspacePath(run, relative) {
  const cwd = String(run.cwd ?? '').replace(/[\\/]+$/, '')
  return cwd.length === 0 ? relative : `${cwd}/${relative}`
}

export function sha256(value) {
  return createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex')
}

/** Collapse to one line for table cells and one-line digests. */
export function oneLine(value, max = 200) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return truncate(text, max)
}

function firstParagraph(value) {
  const text = String(value ?? '').replace(/\r\n/g, '\n').trim()
  const end = text.search(/\n\s*\n/)
  return end === -1 ? text : text.slice(0, end).trim()
}

/**
 * The inlined objective. The full text is always filed in `objective.md`; this
 * is the head that every session gets so a task never starts blind.
 *
 * Deterministic: same objective + cap → same bytes.
 */
export function objectiveHead(value, max = DEFAULT_OBJECTIVE_HEAD_CHARS) {
  const limit = clampInt(max, DEFAULT_OBJECTIVE_HEAD_CHARS, 120, 2000)
  const text = firstParagraph(value)
  if (text.length <= limit) return text
  const slice = text.slice(0, limit)
  const cut = Math.max(slice.lastIndexOf('\n'), slice.lastIndexOf('。'), slice.lastIndexOf('. '))
  const keep = cut >= Math.floor(limit * 0.5) ? slice.slice(0, cut + 1) : slice
  return `${keep.trimEnd()}…`
}

function shortPath(value, max = 100) {
  const text = String(value ?? '').replace(/\\/g, '/').trim()
  return truncate(text, max)
}

/**
 * A bounded summary built from the fields the engine parsed out of a result,
 * not from a raw text slice. Returns '' when nothing is known yet.
 */
export function compactResult(task, max = 600) {
  const source = task !== null && typeof task === 'object' ? task : {}
  const lines = []
  const summary = oneLine(source.summary, 200)
  if (summary.length > 0) lines.push(`summary: ${summary}`)

  const acceptance = Array.isArray(source.acceptanceResults) ? source.acceptanceResults : []
  if (acceptance.length > 0) {
    const passed = acceptance.filter((item) => item?.status === 'passed').length
    lines.push(`acceptance: ${passed}/${acceptance.length} passed`)
  }

  const changed = (Array.isArray(source.changedPaths) ? source.changedPaths : []).filter(
    (item) => typeof item === 'string' && item.trim().length > 0,
  )
  if (changed.length > 0) {
    const shown = changed.slice(0, 8).map((item) => shortPath(item))
    lines.push(`changed: ${shown.join(', ')}${changed.length > shown.length ? ` (+${changed.length - shown.length} more)` : ''}`)
  }

  const verification = (Array.isArray(source.verification) ? source.verification : [])
    .filter((item) => typeof item === 'string' && item.trim().length > 0)
    .slice(0, 5)
  if (verification.length > 0) {
    lines.push(`verified: ${truncate(verification.map((item) => oneLine(item, 120)).join(' · '), 260)}`)
  }

  const open = oneLine(source.openIssues, 240)
  if (open.length > 0 && !/^none$/i.test(open)) lines.push(`open: ${open}`)

  const findings = (Array.isArray(source.findings) ? source.findings : [])
    .map((finding) => finding?.id)
    .filter((id) => typeof id === 'string' && id.length > 0)
  if (findings.length > 0) lines.push(`findings: ${findings.join(', ')}`)

  if (lines.length === 0) return ''
  return truncate(lines.join('\n'), clampInt(max, 600, 120, 2000))
}

/**
 * The per-run facts block. Byte-identical for every session of the same run,
 * which is what lets the provider's prefix cache hit after the rules block.
 */
export function renderRunFacts(run, options = {}) {
  const objectiveChars = clampInt(
    options.objectiveChars ?? run.objectiveHeadChars,
    DEFAULT_OBJECTIVE_HEAD_CHARS,
    120,
    2000,
  )
  const lines = [`<fanout_run id="${run.id}">`]
  const cwd = String(run.cwd ?? '').replace(/[\\/]+$/, '')
  if (cwd.length > 0) lines.push(`Workspace: ${cwd}`)
  lines.push(`Objective head (full text: ${objectiveRelative(run)}):`)
  lines.push(objectiveHead(run.objective, objectiveChars))
  lines.push(
    `Files of record: ${runDirRelative(run)}/{objective.md, manifest.md, manifest.json, results/, prompts/}`,
  )
  lines.push('</fanout_run>')
  return lines.join('\n')
}

/** Exactly the shared prefix every session of this run starts with. */
export function cachePrefix(run, options = {}) {
  return `${SESSION_RULES}\n\n${renderRunFacts(run, options)}`
}

/** sha256 of the shared prefix: a different hash means a cache miss by design. */
export function cachePrefixHash(run, options = {}) {
  return sha256(cachePrefix(run, options))
}

function manifestCell(value, max = 120) {
  return oneLine(String(value ?? '').replace(/\|/g, '/'), max)
}

/** One row per task — the compact index a later stage reads instead of digests. */
export function manifestTaskRows(run) {
  return (Array.isArray(run.tasks) ? run.tasks : []).map((task) => ({
    id: String(task.id ?? ''),
    kind: String(task.kind ?? 'work'),
    state: String(task.state ?? 'pending'),
    attempt: Math.max(0, Math.trunc(Number(task.attempt ?? 0))),
    deps: Array.isArray(task.deps) ? task.deps.map(String) : [],
    summary: oneLine(task.summary ?? '', 200),
    verdict: String(task.reviewVerdict ?? ''),
    findings: (Array.isArray(task.findings) ? task.findings : []).map((finding) => String(finding?.id ?? '')).filter(Boolean),
    result: task.resultPath ? shortPath(task.resultPath, 160) : '',
  }))
}

/**
 * Build the run manifest. `artifacts` are already-filed files:
 * `{ role, path, task?, attempt?, bytes, sha256 }`.
 */
export function buildManifest(run, artifacts = [], options = {}) {
  const objectiveChars = clampInt(
    options.objectiveChars ?? run.objectiveHeadChars,
    DEFAULT_OBJECTIVE_HEAD_CHARS,
    120,
    2000,
  )
  const prefix = cachePrefix(run, { objectiveChars })
  const entries = artifacts
    .filter((item) => item !== null && typeof item === 'object' && typeof item.path === 'string')
    .map((item) => ({
      role: String(item.role ?? 'artifact'),
      path: shortPath(item.path, 240),
      task: typeof item.task === 'string' ? item.task : '',
      attempt: typeof item.attempt === 'string' ? item.attempt : '',
      bytes: Math.max(0, Math.trunc(Number(item.bytes ?? 0))),
      sha256: String(item.sha256 ?? ''),
    }))
    .sort((a, b) => (a.role === b.role ? a.path.localeCompare(b.path) : a.role.localeCompare(b.role)))
  return {
    schema: 1,
    run_id: String(run.id ?? ''),
    status: String(run.status ?? ''),
    phase: String(run.phase ?? ''),
    cwd: String(run.cwd ?? ''),
    contract: CONTRACT_VERSION,
    prefix: {
      chars: prefix.length,
      sha256: sha256(prefix),
      note: 'Every session of this run starts with these exact bytes; a change here is a cache miss by design.',
    },
    objective: {
      path: objectiveRelative(run),
      chars: String(run.objective ?? '').length,
      head_chars: objectiveChars,
    },
    tasks: manifestTaskRows(run),
    artifacts: entries,
  }
}

/** Markdown view of the manifest: the table a prompt can afford to inline. */
export function renderManifestMarkdown(manifest) {
  const rows = Array.isArray(manifest?.tasks) ? manifest.tasks : []
  const lines = [
    `# Fan-out manifest — ${manifest?.run_id ?? '(unknown)'}`,
    `status: ${manifest?.status ?? ''} · contract: ${manifest?.contract ?? ''} · prefix sha256: ${String(manifest?.prefix?.sha256 ?? '').slice(0, 16)}…`,
    `objective: ${manifest?.objective?.path ?? ''} (${manifest?.objective?.chars ?? 0} chars; head inlined in each brief)`,
    '',
    '| task | kind | state | summary | result |',
    '| --- | --- | --- | --- | --- |',
  ]
  for (const row of rows) {
    lines.push(
      `| ${manifestCell(row.id, 40)} | ${manifestCell(row.kind, 20)} | ${manifestCell(row.state, 20)} | ${manifestCell(row.summary, 120) || '—'} | ${manifestCell(row.result, 120) || '—'} |`,
    )
  }
  const artifacts = Array.isArray(manifest?.artifacts) ? manifest.artifacts : []
  lines.push('', `Artifacts: ${artifacts.length} (path + bytes + sha256 in manifest.json)`)
  return `${lines.join('\n')}\n`
}

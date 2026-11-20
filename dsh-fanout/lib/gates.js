/**
 * Result / review / final-report contracts for dsh-fanout v2.
 *
 * Workers, reviewers and the integrator all answer in a fixed line protocol.
 * Parsing and validation live here, isolated from the engine, so a contract
 * violation is decided by a pure function rather than by trusting prose.
 *
 * @module dsh-fanout/lib/gates
 */

const SEVERITIES = ['low', 'medium', 'high', 'blocker']

function splitLines(text) {
  return String(text ?? '').replace(/\r\n/g, '\n').split('\n')
}

function cleanLine(line) {
  return String(line ?? '')
    .replace(/^[-*]\s+/, '')
    .replace(/`/g, '')
    .trim()
}

function sectionBlocks(lines) {
  const blocks = new Map()
  let current = ''
  for (const line of lines) {
    const heading = /^#{2,3}\s+(.+?)\s*$/.exec(line)
    if (heading !== null) {
      current = heading[1].trim().toLowerCase()
      if (!blocks.has(current)) blocks.set(current, [])
      continue
    }
    if (current.length === 0) continue
    blocks.get(current).push(line)
  }
  return blocks
}

function blockText(blocks, names) {
  for (const name of names) {
    const lines = blocks.get(name.toLowerCase())
    if (lines !== undefined) {
      const text = lines.map((line) => line.trim()).filter((line) => line.length > 0).join('\n')
      if (text.length > 0) return text
    }
  }
  return ''
}

/** `<!-- fanout-result task=t1 attempt=t1-a1 -->` */
export function parseAttemptMarker(text) {
  const match = /<!--\s*fanout-result\s+task=([^\s>]+)\s+attempt=([^\s>]+)\s*-->/.exec(String(text ?? ''))
  if (match === null) return { taskId: '', attemptId: '' }
  return { taskId: match[1], attemptId: match[2] }
}

/** Parse a worker result file (fixed sections + ACCEPT/CLOSED lines). */
export function parseResult(text) {
  const raw = String(text ?? '')
  const lines = splitLines(raw)
  const blocks = sectionBlocks(lines)
  const acceptance = []
  const closed = []
  for (const line of lines) {
    const accept = /^\s*(?:[-*]\s*)?ACCEPT\s*:\s*(.+?)\s*\|\s*(passed|failed)\s*\|\s*(.*)$/i.exec(line)
    if (accept !== null) {
      acceptance.push({
        criterion: accept[1].trim(),
        status: accept[2].toLowerCase() === 'passed' ? 'passed' : 'failed',
        evidence: accept[3].trim(),
      })
      continue
    }
    const close = /^\s*(?:[-*]\s*)?CLOSED\s*:\s*([A-Za-z0-9_.-]+)\s*$/i.exec(line)
    if (close !== null) closed.push(close[1])
  }
  const changedPaths = (blocks.get('changed paths') ?? [])
    .map(cleanLine)
    .filter((line) => line.length > 0 && !/^none$/i.test(line))
  const verification = (blocks.get('verification') ?? [])
    .map(cleanLine)
    .filter((line) => line.length > 0)
  return {
    text: raw,
    marker: parseAttemptMarker(raw),
    summary: blockText(blocks, ['summary']).split('\n')[0] ?? '',
    whatChanged: blockText(blocks, ['what changed']),
    verification,
    acceptance,
    changedPaths,
    closed,
    openIssues: blockText(blocks, ['open issues']),
    sections: [...blocks.keys()],
  }
}

/**
 * Decide whether a worker result satisfies its task contract.
 *
 * `stale` means the attempt id in the file does not match the attempt the engine
 * is waiting for: an answer from a revoked attempt must never be accepted.
 */
export function validateResult(parsed, options = {}) {
  const taskId = String(options.taskId ?? '')
  const attemptId = String(options.attemptId ?? '')
  const acceptance = Array.isArray(options.acceptance) ? options.acceptance : []
  const kind = String(options.kind ?? 'work')
  const sourceFindingIds = Array.isArray(options.sourceFindingIds) ? options.sourceFindingIds : []
  const problems = []
  let stale = false

  if (parsed.marker.taskId.length === 0 || parsed.marker.attemptId.length === 0) {
    problems.push('missing "<!-- fanout-result task=… attempt=… -->" marker')
  } else {
    if (parsed.marker.taskId !== taskId) problems.push(`result marker names task ${parsed.marker.taskId}, expected ${taskId}`)
    if (parsed.marker.attemptId !== attemptId) {
      stale = true
      problems.push(`result belongs to attempt ${parsed.marker.attemptId}, current attempt is ${attemptId}`)
    }
  }
  if (parsed.summary.length === 0) problems.push('## Summary is empty')

  const quality = ['requirements', 'implementation', 'verification', 'repair', 'integration'].includes(kind)
  if (quality) {
    if (parsed.verification.length === 0 && kind !== 'requirements') {
      problems.push('## Verification is empty (commands you ran + observed result are required)')
    }
    const decided = new Map(parsed.acceptance.map((item) => [item.criterion.toLowerCase(), item]))
    for (const criterion of acceptance) {
      const hit = decided.get(String(criterion).toLowerCase())
      if (hit === undefined) problems.push(`acceptance criterion not answered: ${criterion}`)
      else if (hit.status !== 'passed' && kind !== 'repair') problems.push(`acceptance criterion failed: ${criterion}`)
    }
  }
  if (kind === 'repair') {
    for (const findingId of sourceFindingIds) {
      if (!parsed.closed.includes(findingId)) problems.push(`finding ${findingId} was not closed (add "CLOSED: ${findingId}")`)
    }
  }
  return { ok: problems.length === 0, stale, problems }
}

/**
 * Parse a reviewer answer.
 *
 *   VERDICT: pass | needs_revision | reject
 *   ACCEPT: <criterion> | passed|failed | <evidence>
 *   FINDING: F1 | high | problem | required fix | file | line
 */
export function parseReview(text) {
  const raw = String(text ?? '')
  const lines = splitLines(raw)
  let verdict = ''
  const findings = []
  const acceptance = []
  for (const line of lines) {
    const verdictMatch = /^\s*VERDICT\s*:\s*(pass|needs_revision|reject)\b/i.exec(line)
    if (verdictMatch !== null) {
      verdict = verdictMatch[1].toLowerCase()
      continue
    }
    const accept = /^\s*(?:[-*]\s*)?ACCEPT\s*:\s*(.+?)\s*\|\s*(passed|failed)\s*\|\s*(.*)$/i.exec(line)
    if (accept !== null) {
      acceptance.push({
        criterion: accept[1].trim(),
        status: accept[2].toLowerCase() === 'passed' ? 'passed' : 'failed',
        evidence: accept[3].trim(),
      })
      continue
    }
    const finding = /^\s*(?:[-*]\s*)?FINDING\s*:\s*(.+)$/i.exec(line)
    if (finding !== null) {
      const parts = finding[1].split('|').map((part) => part.trim())
      const [id, severity, problem, requiredFix, file, lineNo] = parts
      if (id && problem && requiredFix) {
        findings.push({
          id,
          severity: SEVERITIES.includes(String(severity ?? '').toLowerCase()) ? String(severity).toLowerCase() : 'medium',
          problem,
          requiredFix,
          file: file && file.length > 0 ? file : undefined,
          line: Number.isFinite(Number(lineNo)) && lineNo !== undefined ? Number(lineNo) : undefined,
          resolved: false,
        })
      }
    }
  }
  return { verdict, findings, acceptance, text: raw }
}

/** A pass is only valid when nothing failed; criterion coverage is a warning unless strict. */
export function validateReview(review, options = {}) {
  const acceptance = Array.isArray(options.acceptance) ? options.acceptance : []
  const strict = options.strictAcceptance === true
  const problems = []
  const warnings = []
  if (review.verdict.length === 0) problems.push('missing "VERDICT: pass|needs_revision|reject"')
  if (review.verdict === 'pass') {
    if (review.findings.length > 0) problems.push('verdict is pass but findings are listed')
    const decided = new Map(review.acceptance.map((item) => [item.criterion.toLowerCase(), item]))
    for (const criterion of acceptance) {
      const hit = decided.get(String(criterion).toLowerCase())
      if (hit === undefined) {
        const message = `acceptance criterion not judged: ${criterion}`
        if (strict) problems.push(message)
        else warnings.push(message)
      } else if (hit.status !== 'passed') {
        // A failed criterion under a pass verdict is always a contradiction.
        problems.push(`criterion judged failed: ${criterion}`)
      }
    }
  } else if (review.verdict.length > 0) {
    if (review.findings.length === 0) problems.push(`${review.verdict} requires at least one FINDING line`)
  }
  return { ok: problems.length === 0, problems, warnings }
}

const FINAL_SECTIONS = [
  'outcome',
  'conflicts and how they were resolved',
  'verification',
  'remaining gaps',
  'files of record',
]

/** The integrator's final.md must carry real evidence, not prose promises. */
export function validateFinal(text, options = {}) {
  const raw = String(text ?? '')
  const lines = splitLines(raw)
  const blocks = sectionBlocks(lines)
  const problems = []
  const required = Array.isArray(options.sections) && options.sections.length > 0 ? options.sections : FINAL_SECTIONS
  for (const name of required) {
    if (!blocks.has(name) && !/^#\s+fan-out final report/im.test(raw)) {
      problems.push(`missing section "## ${name}"`)
    } else if (!blocks.has(name)) {
      problems.push(`missing section "## ${name}"`)
    }
  }
  const verification = blocks.get('verification') ?? []
  const rows = verification.filter((line) => line.includes('|') && !/^\s*\|?\s*:?-{2,}/.test(line))
  const dataRows = rows.filter((line) => !/\|\s*command\s*\|/i.test(line))
  if (dataRows.length === 0) problems.push('## Verification has no command/exit-code table rows')
  const outcome = blockText(blocks, ['outcome'])
  if (outcome.length < 20) problems.push('## Outcome is missing or too short to judge')
  return { ok: problems.length === 0, problems, sections: [...blocks.keys()] }
}

export function findingsBySeverity(findings) {
  const order = { blocker: 0, high: 1, medium: 2, low: 3 }
  return [...(findings ?? [])].sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9))
}

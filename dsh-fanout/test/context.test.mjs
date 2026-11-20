/**
 * context.test.mjs — the context budget, the stable prefix and the manifest.
 *
 * These are cost contracts, not cosmetics: a brief that silently grows back to
 * the old shape doubles the bill of every run, and a prefix that changes per
 * session throws away the prompt cache the run was designed around.
 */

import assert from 'node:assert/strict'

import {
  buildManifest,
  cachePrefix,
  cachePrefixHash,
  compactResult,
  objectiveHead,
  renderManifestMarkdown,
  renderRunFacts,
  SESSION_RULES,
} from '../lib/context.js'
import { renderIntegratorBrief, renderReviewBrief, renderTaskBrief } from '../lib/prompts2.js'

let checks = 0
function check(name, fn) {
  fn()
  checks += 1
  console.log(`ok  context · ${name}`)
}

const objective = `${'The shared objective is a long paragraph with constraints. '.repeat(30)}END-OF-OBJECTIVE`

const run = {
  id: 'run-ctx-1',
  cwd: 'C:/tmp/ws',
  objective,
  verify: ['npm test', 'node build.mjs'],
  resultDigestChars: 1200,
  objectiveHeadChars: 600,
  taskBriefChars: 2000,
  tasks: [],
}

function makeTask(index, overrides = {}) {
  return {
    id: `t${index}`,
    kind: 'implementation',
    title: `task ${index}`,
    brief: `do slice ${index}`,
    weight: 1,
    deps: [],
    attempt: 1,
    attemptId: `t${index}-a1-abcd`,
    state: 'completed',
    summary: `slice ${index} is done`,
    digest: 'Z'.repeat(1200),
    changedPaths: [`src/${index}.js`, `tests/${index}.test.js`],
    verification: ['`node --test` → exit 0'],
    openIssues: 'none',
    acceptanceResults: [{ criterion: 'works', status: 'passed', evidence: 'observed' }],
    findings: [],
    contract: {
      objective: `slice ${index} works`,
      acceptance: [`slice ${index} exports a function`],
      verify: ['node --test'],
      inScope: [`src/${index}.js`],
      outOfScope: [],
    },
    ...overrides,
  }
}

for (let index = 1; index <= 12; index += 1) run.tasks.push(makeTask(index))

check('the objective head is bounded, deterministic and marks truncation', () => {
  const head = objectiveHead(objective, 600)
  assert.ok(head.length <= 600, `head is ${head.length} chars`)
  assert.ok(head.endsWith('…'))
  assert.equal(head, objectiveHead(objective, 600))
  assert.ok(!head.includes('END-OF-OBJECTIVE'), 'the tail is only in objective.md')
})

check('a short objective is kept verbatim', () => {
  assert.equal(objectiveHead('short objective', 600), 'short objective')
})

check('the rules block is run-independent (it can cache across runs)', () => {
  assert.ok(!SESSION_RULES.includes('run-ctx-1'))
  assert.ok(!/\d{4}-\d{2}-\d{2}/.test(SESSION_RULES), 'no timestamps in the cached prefix')
})

check('run status never changes the prefix hash (status is not cached context)', () => {
  const hash = cachePrefixHash(run)
  assert.equal(hash, cachePrefixHash({ ...run, status: 'completed' }))
  assert.equal(hash.length, 64)
})

check('every task brief of a run starts with the identical prefix bytes', () => {
  const first = renderTaskBrief(run, run.tasks[0], run.tasks[0].attemptId)
  const second = renderTaskBrief(run, run.tasks[5], run.tasks[5].attemptId)
  assert.ok(first.startsWith(cachePrefix(run)))
  assert.ok(second.startsWith(cachePrefix(run)))
  const shared = first.slice(0, cachePrefix(run).length)
  assert.equal(shared, second.slice(0, cachePrefix(run).length))
  assert.ok(cachePrefix(run).length > SESSION_RULES.length, 'rules + run facts are both shared')
})

check('the run facts block carries the full objective path, not the full text', () => {
  const facts = renderRunFacts(run)
  assert.ok(facts.includes('Objective head (full text: .dsh-fanout/runs/run-ctx-1/objective.md)'))
  assert.ok(facts.includes('manifest.md'))
  assert.ok(!facts.includes('- npm test'), 'run verify commands belong to the integrator brief, not every session')
  assert.ok(facts.length < 1200, `facts are ${facts.length} chars`)
})

check('a result digest is structured, bounded and never a raw answer slice', () => {
  const digest = compactResult(run.tasks[0], 600)
  assert.ok(digest.length <= 600, `digest is ${digest.length} chars`)
  assert.ok(digest.includes('summary: slice 1 is done'))
  assert.ok(digest.includes('acceptance: 1/1 passed'))
  assert.ok(digest.includes('changed: src/1.js, tests/1.test.js'))
  assert.ok(digest.includes('verified:'))
  assert.ok(!digest.includes('ZZZ'), 'raw answer text must not leak into the digest')
})

check('the task brief is materially smaller than the old worst case', () => {
  const worst = {
    ...run.tasks[0],
    brief: 'y'.repeat(4000),
    contract: { ...run.tasks[0].contract, acceptance: Array.from({ length: 12 }, () => 'a'.repeat(300)) },
  }
  const brief = renderTaskBrief(run, worst, 't1-a1-abcd')
  // The unavoidable floor is the contract itself (12 × 300-char criteria);
  // everything around it is bounded. The old shape reached 10.5k on the same input.
  assert.ok(brief.length < 9200, `bounded task brief is ${brief.length} chars`)
  assert.ok(brief.includes('<!-- fanout-result task=t1 attempt=t1-a1-abcd -->'))
})

check('the review brief uses the structured digest, not the raw text', () => {
  const reviewTask = { id: 'review-t1-r1', attempt: 1, round: 1 }
  const brief = renderReviewBrief(run, run.tasks[0], reviewTask, 'Z'.repeat(1200))
  assert.ok(brief.length < 3600, `review brief is ${brief.length} chars`)
  assert.ok(brief.includes('summary: slice 1 is done'))
  assert.ok(!brief.includes('Z'.repeat(300)), 'the raw digest slice must not reach the reviewer')
  assert.ok(brief.startsWith(cachePrefix(run)), 'reviewers share the same cached prefix')
})

check('the integrator receives a manifest table, not every digest', () => {
  const brief = renderIntegratorBrief(run)
  assert.ok(brief.length < 7000, `integrator brief is ${brief.length} chars`)
  assert.ok(brief.includes('.dsh-fanout/runs/run-ctx-1/manifest.md'))
  assert.ok(brief.includes('| task | kind | state | summary | result |'))
  assert.ok(brief.includes('slice 1 is done'))
  assert.ok(!brief.includes('Z'.repeat(300)), 'no raw digest slices')
})

check('the manifest indexes artifacts with bytes and sha256', () => {
  const artifacts = [
    { role: 'result', path: '.dsh-fanout/runs/run-ctx-1/results/t1-a1-abcd.md', task: 't1', attempt: 't1-a1-abcd', bytes: 120, sha256: 'b'.repeat(64) },
    { role: 'objective', path: '.dsh-fanout/runs/run-ctx-1/objective.md', bytes: 40, sha256: 'a'.repeat(64) },
    { role: 'prompt', path: '.dsh-fanout/runs/run-ctx-1/prompts/t1-a1-abcd.md', task: 't1', attempt: 't1-a1-abcd', bytes: 900, sha256: 'c'.repeat(64) },
  ]
  const manifest = buildManifest(run, artifacts)
  assert.equal(manifest.run_id, run.id)
  assert.equal(manifest.prefix.sha256, cachePrefixHash(run))
  assert.equal(manifest.artifacts.length, 3)
  assert.deepEqual(
    manifest.artifacts.map((item) => item.role),
    ['objective', 'prompt', 'result'],
    'artifacts are ordered deterministically',
  )
  assert.ok(manifest.artifacts.every((item) => item.sha256.length === 64))
  assert.equal(manifest.tasks.length, 12)
  assert.equal(manifest.tasks[0].state, 'completed')
})

check('the markdown manifest stays a table and escapes cell separators', () => {
  const manifest = buildManifest(run, [], {})
  manifest.tasks[0].summary = 'has | a pipe'
  const markdown = renderManifestMarkdown(manifest)
  assert.ok(markdown.includes('| t1 | implementation | completed | has / a pipe |'))
  assert.ok(!markdown.includes('ZZZ'))
})

console.log(`ok  context.test.mjs (${checks} checks)`)

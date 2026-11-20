/**
 * arm.test.mjs — the fan-out fit rule and the automatic budget.
 *
 * These are the two decisions that make the composer checkbox safe: a request
 * that fan-out loses is sent back to a single session, and a request that fan-out
 * wins gets a budget derived from the graph plus headroom instead of a cheap
 * configured default.
 */
import assert from 'node:assert/strict'

import {
  AUTO_MARGIN_EXPANSION,
  AUTO_MARGIN_WORKERS,
  decideBudget,
  graphFit,
  levelize,
  objectiveFit,
} from '../lib/arm.js'

function task(id, deps = [], brief = 'x'.repeat(400)) {
  return { id, title: id, brief, deps }
}

// --- levelize ---------------------------------------------------------------

{
  const flat = [task('t1'), task('t2'), task('t3')]
  const lv = levelize(flat)
  assert.equal(lv.width, 3, 'three independent tasks are one layer of three')
  assert.equal(lv.depth, 1, 'three independent tasks have depth 1')
  assert.equal(lv.count, 3)
}

{
  const chain = [task('t1'), task('t2', ['t1']), task('t3', ['t2'])]
  const lv = levelize(chain)
  assert.equal(lv.width, 1, 'a chain never has two tasks in one layer')
  assert.equal(lv.depth, 3, 'a three-step chain has depth 3')
}

{
  const mixed = [task('t1'), task('t2'), task('t3', ['t1', 't2']), task('t4', ['t3'])]
  const lv = levelize(mixed)
  assert.equal(lv.width, 2, 't1 and t2 share the widest layer')
  assert.equal(lv.depth, 3, 't1 -> t3 -> t4 is the longest path')
}

// --- graphFit: the conditions where fan-out measurably loses -----------------

{
  const one = graphFit([task('t1')])
  assert.equal(one.verdict, 'single')
  assert.ok(one.reasons.some((reason) => reason.includes('at least')), 'a single job is refused')
}

{
  const empty = graphFit([])
  assert.equal(empty.verdict, 'single', 'an empty graph is never a fan-out')
}

{
  const chain = graphFit([task('t1'), task('t2', ['t1']), task('t3', ['t2'])])
  assert.equal(chain.verdict, 'single', 'a pure chain is refused')
  assert.ok(chain.reasons.some((reason) => reason.includes('chain')), 'the chain reason is stated')
}

{
  const tiny = graphFit([task('t1', [], 'ab'), task('t2', [], 'cd'), task('t3', [], 'ef')])
  assert.equal(tiny.verdict, 'single', 'three minuscule jobs are refused')
  assert.ok(tiny.reasons.some((reason) => reason.includes('characters')), 'the size reason is stated')
}

{
  const wide = graphFit([task('t1'), task('t2'), task('t3'), task('t4')])
  assert.equal(wide.verdict, 'fanout', 'four independent substantial jobs fan out')
  assert.deepEqual(wide.reasons, [])
  assert.equal(wide.metrics.width, 4)
}

{
  const layered = graphFit([task('t1'), task('t2'), task('t3', ['t1']), task('t4', ['t2'])])
  assert.equal(layered.verdict, 'fanout', 'a wide graph with dependencies still fans out')
  assert.equal(layered.metrics.width, 2)
  assert.equal(layered.metrics.depth, 2)
}

// --- decideBudget: generous by construction ---------------------------------

{
  const wide = [task('t1'), task('t2'), task('t3'), task('t4'), task('t5')]
  const budget = decideBudget({ tasks: wide, maxWorkers: 16, maxExpansion: 100 })
  assert.equal(budget.source, 'auto')
  assert.equal(
    budget.workers,
    Math.min(16, 5 + AUTO_MARGIN_WORKERS),
    'auto asks for the widest layer plus a spare slot',
  )
  assert.ok(budget.expansion >= 60 + AUTO_MARGIN_EXPANSION, 'the expansion floor carries headroom')
  assert.equal(budget.expansion, 60 + AUTO_MARGIN_EXPANSION, 'depth 1 stays at the floor plus headroom')
}

{
  const deep = [task('t1'), task('t2', ['t1']), task('t3', ['t2']), task('t4', ['t3'])]
  const shallow = decideBudget({ tasks: [task('t1'), task('t2')], maxWorkers: 16, maxExpansion: 100 })
  const tall = decideBudget({ tasks: deep, maxWorkers: 16, maxExpansion: 100 })
  assert.ok(tall.expansion > shallow.expansion, 'a deeper graph asks for more expansion')
}

{
  const capped = decideBudget({
    tasks: [task('t1'), task('t2'), task('t3'), task('t4'), task('t5')],
    maxWorkers: 3,
    maxExpansion: 40,
  })
  assert.equal(capped.workers, 3, 'the configured maximum still wins')
  assert.equal(capped.expansion, 40, 'expansion is capped too')
}

{
  const manual = decideBudget({ tasks: [], mode: 'manual', workers: 2, expansion: 10, maxWorkers: 16 })
  assert.equal(manual.source, 'manual')
  assert.equal(manual.workers, 2, 'manual honours the users dial')
  assert.equal(manual.expansion, 10)
}

{
  const manualOutOfRange = decideBudget({ mode: 'manual', workers: 99, expansion: 999, maxWorkers: 8, maxExpansion: 100 })
  assert.equal(manualOutOfRange.workers, 8)
  assert.equal(manualOutOfRange.expansion, 100)
}

// --- objectiveFit: a hint only, never the gate ------------------------------

{
  assert.equal(objectiveFit('').hint, 'unsure')
  assert.equal(objectiveFit('fix the typo in the readme').hint, 'narrow')
  const wide = objectiveFit(
    'Do these:\n- job one with a long brief that goes on and on\n- job two with another long brief\n- job three with a third long brief\n- job four',
  )
  assert.equal(wide.hint, 'wide', 'a bulleted list is a wide hint')
  assert.ok(wide.bullets >= 3)
}

console.log('ok arm.test.mjs')

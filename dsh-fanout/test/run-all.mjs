/**
 * run-all.mjs — run every test file in order with plain `node`.
 *
 * Each file is a normal ESM module that throws on failure; this runner imports
 * them sequentially and reports one `ok <file>` line per passing file. Import
 * the tests (rather than spawning node) keeps it dependency-free and gives the
 * real per-file exit behaviour: a failed file is caught, the rest still run, and
 * this process exits non-zero at the end.
 *
 *   node run-all.mjs          (from test/)
 *   node test/run-all.mjs     (from the plugin root)
 */
import process from 'node:process'

// The client tests stub `window` and `fetch`, so they run last and cannot leak
// those globals into the Host-side suites.
const files = ['arm.test.mjs', 'plan.test.mjs', 'model.test.mjs', 'team.test.mjs', 'worktree.test.mjs', 'prompts.test.mjs', 'bridge.test.mjs', 'graph.test.mjs', 'queue.test.mjs', 'gates.test.mjs', 'context.test.mjs', 'kernel.test.mjs', 'prompts2.test.mjs', 'apply.test.mjs', 'ui-state.test.mjs', 'ui-panel.test.mjs']

let failures = 0
for (const file of files) {
  try {
    // Dynamic import so one failing file does not stop the remaining files.
    await import(`./${file}`)
    console.log(`ok ${file}`)
  } catch (error) {
    failures += 1
    console.error(`not ok ${file}`)
    console.error(error instanceof Error ? error.stack : String(error))
  }
}

if (failures > 0) {
  console.error(`${failures}/${files.length} test file(s) failed`)
  process.exitCode = 1
} else {
  console.log(`ok all ${files.length} test files`)
}

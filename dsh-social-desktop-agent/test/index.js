/**
 * test/index.js — entry point so `node --test <this directory>` works.
 *
 * Node 24.18.0 does not expand a directory positional argument for `--test`: it
 * hands the path to the module loader. Because this directory has an
 * index.js, `<dir>` resolves to this file, which imports every
 * `*.test.mjs` below it into the same test runner.
 *
 * Using `node --test dsh-social-desktop-agent/test` (the acceptance command)
 * therefore runs core, browser, desktop and integration tests together. Running
 * `node --test "test/**\/*.test.mjs"` is equivalent and skips this file.
 */

import { readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

function collect(dir) {
  const found = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      found.push(...collect(full))
    } else if (entry.isFile() && entry.name.endsWith('.test.mjs')) {
      found.push(full)
    }
  }
  return found
}

const files = collect(HERE).sort()
for (const file of files) {
  await import(pathToFileURL(file).href)
}

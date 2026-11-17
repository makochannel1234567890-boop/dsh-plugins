/**
 * Durable, file-backed state for dsh-fanout.
 *
 * The Harness session log is not touched: runs live as plain JSON/markdown under
 * `~/.dsh/storages/fanout`, so a restart loses only the live drivers, never the
 * evidence a human or the integrator needs.
 *
 * @module dsh-fanout/lib/store
 */

import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export function defaultStoreDir() {
  return path.join(os.homedir(), '.dsh', 'storages', 'fanout')
}

async function readJson(file) {
  try {
    const text = await fsp.readFile(file, 'utf8')
    return JSON.parse(text)
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

async function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp`
  await fsp.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await fsp.rename(tmp, file)
}

export class FanoutStore {
  constructor(storeDir) {
    this.dir = path.resolve(storeDir)
    this.runsDir = path.join(this.dir, 'runs')
    this.divergenceDir = path.join(this.dir, 'divergence')
    this.configFile = path.join(this.dir, 'config.json')
    this.bridgeFile = path.join(this.dir, 'bridge.json')
    this.queue = Promise.resolve()
  }

  async ensure() {
    await fsp.mkdir(this.runsDir, { recursive: true })
    await fsp.mkdir(this.divergenceDir, { recursive: true })
  }

  /**
   * Serialise writes so two runs never interleave a rename.
   *
   * The returned promise is the *caller's* write: a failed write must reject so
   * the bridge/tools can report it instead of answering ok. The internal chain
   * still swallows the failure so one bad write cannot block every later one.
   */
  enqueue(task) {
    const run = this.queue.then(task)
    this.queue = run.catch(() => {})
    return run
  }

  async loadConfig() {
    return readJson(this.configFile)
  }

  async saveConfig(value) {
    await this.ensure()
    return this.enqueue(() => writeJsonAtomic(this.configFile, value))
  }

  async loadBridge() {
    return readJson(this.bridgeFile)
  }

  async saveBridge(value) {
    await this.ensure()
    return this.enqueue(() => writeJsonAtomic(this.bridgeFile, value))
  }

  runDir(runId) {
    return path.join(this.runsDir, runId)
  }

  resultsDir(runId) {
    return path.join(this.runDir(runId), 'results')
  }

  async createRun(run) {
    await fsp.mkdir(this.resultsDir(run.id), { recursive: true })
    await this.saveRun(run)
    return run
  }

  async saveRun(run) {
    await this.ensure()
    const snapshot = { ...run, updatedAt: Date.now() }
    return this.enqueue(() => writeJsonAtomic(path.join(this.runDir(run.id), 'run.json'), snapshot))
  }

  async loadRun(runId) {
    return readJson(path.join(this.runDir(runId), 'run.json'))
  }

  async listRuns(limit = 20) {
    let names = []
    try {
      names = await fsp.readdir(this.runsDir)
    } catch (error) {
      if (error?.code === 'ENOENT') return []
      throw error
    }
    const runs = []
    for (const name of names.slice(-limit * 2)) {
      const run = await readJson(path.join(this.runsDir, name, 'run.json'))
      if (run !== undefined) runs.push(run)
    }
    runs.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
    return runs.slice(0, limit)
  }

  async readResult(runId, fileName) {
    try {
      return await fsp.readFile(path.join(this.resultsDir(runId), fileName), 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return undefined
      throw error
    }
  }

  async readFinal(runId) {
    try {
      return await fsp.readFile(path.join(this.runDir(runId), 'final.md'), 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return undefined
      throw error
    }
  }

  divergenceFile(id) {
    return path.join(this.divergenceDir, `${id}.json`)
  }

  async saveDivergence(record) {
    await this.ensure()
    return this.enqueue(() => writeJsonAtomic(this.divergenceFile(record.id), record))
  }

  async loadDivergence(id) {
    return readJson(this.divergenceFile(id))
  }

  /** Workspace-relative directory handed to workers in their brief. */
  static workspaceResultsDir(runId) {
    return `.dsh-fanout/runs/${runId}/results`
  }

  static workspaceDivergenceDir(id) {
    return `.dsh-fanout/divergence/${id}`
  }
}

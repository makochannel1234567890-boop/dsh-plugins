#!/usr/bin/env node
/**
 * External watchdog for dsh-crash-recovery.
 *
 * A crashed process cannot restart itself, so when DSH itself is what died the
 * in-process recovery only runs at the *next* launch. This helper is the part
 * that makes the launch happen: it watches the liveness journal written by the
 * plugin, and when the recorded pid is gone and no clean shutdown was recorded,
 * it relaunches exactly the command that was recorded.
 *
 * Deliberately bounded, because an auto-restarter that loops is worse than a
 * crash:
 *   - at most `--max-relaunch` (default 1) per crash id,
 *   - at most `--max-relaunch` in any `--cooldown` window (default 1 per hour),
 *   - `--dry-run` prints the command instead of running it,
 *   - `--once` performs a single check (useful from a scheduled task).
 *
 * Usage:
 *   node bin/watchdog.mjs --dry-run --once
 *   node bin/watchdog.mjs --interval 10000
 *
 * Exit codes: 0 nothing to do or relaunched, 2 still watching, 3 budget spent.
 *
 * @module dsh-crash-recovery/bin/watchdog
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Last give-up reason, so interval mode does not repeat the same complaint. */
let lastGiveUpReason = ''

/**
 * Where the Desktop shell writes its crash reports (`crash-<time>-host.log`).
 *
 * The journal alone cannot tell a crash from a normal quit on this platform:
 * the Desktop shell kills the Host process on quit, so `clean` stays false for
 * both. A `-host.log` is only written when the Host exits as a failure, which
 * is the discriminator this watchdog uses.
 */
function defaultCrashLogDir() {
  if (process.platform === 'win32' && typeof process.env.APPDATA === 'string' && process.env.APPDATA.length > 0) {
    return path.join(process.env.APPDATA, '@deepseek-ai', 'dsh-desktop', 'logs')
  }
  return ''
}

function parseArgs(argv) {
  const options = {
    storeDir: path.join(os.homedir(), '.dsh', 'storages', 'crash-recovery'),
    intervalMs: 10000,
    staleMs: 120000,
    maxRelaunch: 1,
    cooldownMs: 60 * 60 * 1000,
    dryRun: false,
    once: false,
    quiet: false,
    crashLogDir: defaultCrashLogDir(),
    requireCrashReport: true,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = () => {
      index += 1
      return argv[index]
    }
    switch (arg) {
      case '--store':
        options.storeDir = path.resolve(String(next() ?? options.storeDir))
        break
      case '--interval':
        options.intervalMs = Math.max(1000, Number(next()) || options.intervalMs)
        break
      case '--stale':
        options.staleMs = Math.max(1000, Number(next()) || options.staleMs)
        break
      case '--max-relaunch':
        options.maxRelaunch = Math.max(0, Number(next()) || 0)
        break
      case '--cooldown':
        options.cooldownMs = Math.max(1000, Number(next()) || options.cooldownMs)
        break
      case '--crash-log-dir':
        options.crashLogDir = path.resolve(String(next() ?? ''))
        break
      case '--no-crash-report-guard':
        options.requireCrashReport = false
        break
      case '--dry-run':
        options.dryRun = true
        break
      case '--once':
        options.once = true
        break
      case '--quiet':
        options.quiet = true
        break
      case '--help':
      case '-h':
        printHelp()
        process.exit(0)
        break
      default:
        if (arg.startsWith('--')) {
          console.error(`unknown option: ${arg}`)
          process.exit(64)
        }
    }
  }
  return options
}

function printHelp() {
  console.log(`dsh-crash-recovery watchdog

  --store <dir>        crash-recovery store dir (default ~/.dsh/storages/crash-recovery)
  --interval <ms>      poll interval (default 10000)
  --stale <ms>         heartbeat age that counts as dead (default 120000)
  --max-relaunch <n>   relaunches per crash and per cooldown window (default 1)
  --cooldown <ms>      cooldown window (default 1h)
  --crash-log-dir <d>  Desktop crash reports; relaunch only with a fresh -host.log
                       (default %APPDATA%\\@deepseek-ai\\dsh-desktop\\logs on Windows)
  --no-crash-report-guard  ignore the crash report check (old behaviour)
  --dry-run            print the relaunch command, run nothing
  --once               one check, then exit
  --quiet              only report relaunches and errors

Exit codes: 0 nothing to do or relaunched, 2 watching, 3 budget spent.`)
}

function log(options, ...args) {
  if (options.quiet) return
  console.log('[watchdog]', ...args)
}

function readJson(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined
  } catch {
    return undefined
  }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/**
 * Whether the Desktop shell wrote a Host crash report at/after `sinceMs`.
 *
 * Returns `undefined` when the guard cannot apply (no directory configured or
 * the directory does not exist), so non-Desktop profiles keep the old
 * "unclean journal means crash" behaviour.
 *
 * @param {string} dir
 * @param {number} sinceMs
 * @returns {boolean | undefined}
 */
export function hasHostCrashReport(dir, sinceMs) {
  if (typeof dir !== 'string' || dir.length === 0) return undefined
  if (!existsSync(dir)) return undefined
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return false
  }
  const floor = Number.isFinite(sinceMs) && sinceMs > 0 ? sinceMs - 60_000 : 0
  for (const name of entries) {
    if (!/^crash-.+-host\.log$/u.test(name)) continue
    try {
      if (statSync(path.join(dir, name)).mtimeMs >= floor) return true
    } catch {
      // Ignore unreadable entries and keep looking.
    }
  }
  return false
}

/**
 * The command that actually brings the application back.
 *
 * The journal records the *Host* command, which for the Desktop app is
 * `DeepSeek Harness.exe <…>/dsh-desktop-host/lib/index.js …`. Replaying that
 * would start a headless Host instead of the windowed app, so an Electron
 * shell whose argv names the desktop Host is relaunched as the shell alone.
 *
 * @param {any} journal
 * @returns {{ execPath: string, argv: string[], cwd: any } | undefined}
 */
export function relaunchCommand(journal) {
  const relaunch = journal?.relaunch ?? {}
  if (typeof relaunch.execPath !== 'string' || relaunch.execPath.length === 0) return undefined
  const argv = Array.isArray(relaunch.argv) ? relaunch.argv.filter((item) => typeof item === 'string') : []
  const shell = path.basename(relaunch.execPath).toLowerCase()
  const isDesktopShell = shell === 'deepseek harness.exe' || shell === 'electron.exe' || shell === 'electron'
  const namesDesktopHost = argv.some((item) => item.includes('-desktop-host'))
  return {
    execPath: relaunch.execPath,
    argv: isDesktopShell && namesDesktopHost ? [] : argv,
    cwd: relaunch.cwd,
  }
}

/**
 * One decision. Pure-ish: returns what it *would* do plus the relaunch plan.
 *
 * @param {{ journal: any, budget: any, options: any, now: number, alive: boolean, hostCrashReport?: boolean | undefined }} input
 */
export function decide(input) {
  const { journal, budget, options, now, alive } = input
  if (journal === undefined) return { action: 'idle', reason: 'no journal yet' }
  if (journal.clean === true) return { action: 'stop', reason: `previous boot was clean (${journal.exitReason || 'unknown'})` }
  if (alive) return { action: 'watch', reason: 'recorded pid is alive' }
  if (!Number.isFinite(Number(journal.heartbeatAt)) || now - Number(journal.heartbeatAt) < options.staleMs) {
    return { action: 'watch', reason: 'heartbeat is still fresh' }
  }
  if (input.hostCrashReport === false) {
    return {
      action: 'stop',
      reason: 'the Host died without a crash report: treating this as a normal quit',
    }
  }
  const crashId = `${journal.bootId}@${journal.heartbeatAt}`
  const relaunches = Array.isArray(budget?.relaunches) ? budget.relaunches : []
  const forCrash = relaunches.filter((item) => item?.crashId === crashId)
  if (forCrash.length >= options.maxRelaunch) {
    return { action: 'give-up', reason: `crash ${crashId} already relaunched ${forCrash.length}x`, crashId }
  }
  const recent = relaunches.filter((item) => now - Number(item?.at ?? 0) < options.cooldownMs)
  if (recent.length >= options.maxRelaunch) {
    return { action: 'give-up', reason: `relaunch budget spent (${recent.length} in the cooldown window)`, crashId }
  }
  const command = relaunchCommand(journal)
  if (command === undefined) {
    return { action: 'give-up', reason: 'journal has no relaunch command', crashId }
  }
  return {
    action: 'relaunch',
    crashId,
    reason: `pid ${journal.pid} is gone and the boot was not clean`,
    command,
  }
}

async function tick(options) {
  const liveFile = path.join(options.storeDir, 'live.json')
  const budgetFile = path.join(options.storeDir, 'watchdog.json')
  const journal = readJson(liveFile)
  const budget = readJson(budgetFile) ?? { relaunches: [] }
  const now = Date.now()
  const alive = journal !== undefined && pidAlive(Number(journal.pid))
  const since = Number(journal?.startedAt ?? journal?.heartbeatAt ?? 0)
  const hostCrashReport = options.requireCrashReport
    ? hasHostCrashReport(options.crashLogDir, since)
    : undefined
  const decision = decide({ journal, budget, options, now, alive, hostCrashReport })

  if (decision.action === 'relaunch') {
    const { execPath, argv, cwd } = decision.command
    log(options, `relaunching: ${execPath} ${argv.join(' ')} (cwd ${cwd})`)
    if (!options.dryRun) {
      const child = spawn(execPath, argv, {
        cwd: typeof cwd === 'string' && existsSync(cwd) ? cwd : process.cwd(),
        detached: true,
        stdio: 'ignore',
        env: { ...process.env },
      })
      child.unref()
      mkdirSync(options.storeDir, { recursive: true })
      const next = {
        relaunches: [...(budget.relaunches ?? []), { at: now, crashId: decision.crashId, pid: child.pid ?? 0 }].slice(-50),
      }
      writeFileSync(budgetFile, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    }
    return 0
  }
  if (decision.action === 'give-up') {
    // Interval mode re-checks forever; log one line per distinct reason.
    if (decision.reason !== lastGiveUpReason) {
      console.error(`[watchdog] giving up: ${decision.reason}`)
      lastGiveUpReason = decision.reason
    }
    return 3
  }
  lastGiveUpReason = ''
  if (decision.action === 'stop') {
    log(options, decision.reason)
    return 0
  }
  log(options, `${decision.action}: ${decision.reason}`)
  return 2
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url.endsWith(path.basename(process.argv[1]))
if (invokedDirectly) {
  const options = parseArgs(process.argv.slice(2))
  mkdirSync(options.storeDir, { recursive: true })
  const loop = async () => {
    let code = 2
    try {
      code = await tick(options)
    } catch (error) {
      console.error(`[watchdog] ${String(error?.stack ?? error)}`)
      code = 1
    }
    if (options.once) process.exit(code)
    // Interval mode never exits on "nothing to do" or "budget spent": a future
    // crash is a different incident, and the watcher must outlive normal quits
    // of the application it watches.
    setTimeout(loop, options.intervalMs)
  }
  loop()
}

/**
 * dsh-emulator-lab — エミュレーター制御層（純 ESM / DSH 非依存）
 *
 * 役割:
 *   - Android AVD / iOS Simulator の検出（ツール探索のみ・プロセス起動なし）
 *   - AVD 作成引数・起動引数・simctl 引数の組み立て
 *   - SoC 制約（メモリ上限）によるクランプ
 *   - エミュレーターの起動 / 停止
 *   - 実測 FPS のサンプリング（Android: dumpsys gfxinfo framestats / iOS: simctl spawn log）
 *
 * 設計方針:
 *   - 外部コマンドは必ず `opts.run(cmd, args, runOpts)` 経由。既定実装は
 *     node:child_process（execFile のプロミス化 / detached 起動は spawn）を使う。
 *     `opts.run` を差し替えれば完全にオフラインでテストできる。
 *   - `run` の戻り値の形は `{ code:number|null, stdout:string, stderr:string, pid:number|null, error:string|null }`。
 *     detached 起動（エミュレーター本体）では `pid` が入る。
 *   - 検出系（detectEmulators）は絶対に例外を投げない。失敗は available:false で表現する。
 *   - launch() も例外を投げない。失敗は `{ ok:false, error:{...} }` で返す（契約固定）。
 *   - 実エミュレーターは起動しない（テストは全て opts.run をモックする）。
 *
 * 共有 API（他担当が import する。名前・形は変えない）:
 *   detectEmulators / buildAvdArgs / clampConstraints / buildBootArgs /
 *   buildSimctlArgs / launch / sampleFps / shutdown
 */

import { execFile, spawn } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';

const DEFAULT_TIMEOUT_MS = 8000;
const ANDROID_DEFAULT_SERIAL_PORT = 5554;
const MAX_DELTA_NS = 2_000_000_000; // 2 秒を超えるフレーム間隔は異常値として捨てる
const MAX_SAMPLES_DEFAULT = 300;
const GPU_MODES = ['swiftshader_indirect', 'host'];

/* ------------------------------------------------------------------ */
/* 既定の run 実装                                                     */
/* ------------------------------------------------------------------ */

function failureResult(error) {
  const message = String(error?.message ?? error ?? 'unknown error');
  return { code: null, stdout: '', stderr: message, pid: null, error: message };
}

/**
 * 既定のコマンドランナー。
 * runOpts.detached のときだけ spawn して「起動できた時点」で resolve する（pid を返す）。
 * それ以外は execFile で終了まで待ち、標準出力を返す。
 */
function defaultRun(cmd, args = [], runOpts = {}) {
  const timeoutMs = runOpts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (runOpts.detached) {
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
      } catch (error) {
        resolve(failureResult(error));
        return;
      }
      let settled = false;
      const done = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      child.once('spawn', () => {
        const pid = child.pid ?? null;
        try {
          child.unref();
        } catch {
          /* unref できなくても致命的ではない */
        }
        done({ code: 0, stdout: '', stderr: '', pid, error: null });
      });
      child.once('error', (error) => done(failureResult(error)));
    });
  }

  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        const stderrText = String(stderr ?? '') || (error ? String(error.message ?? error) : '');
        resolve({
          code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
          stdout: String(stdout ?? ''),
          stderr: stderrText,
          pid: null,
          error: error ? String(error.message ?? error) : null,
        });
      },
    );
  });
}

function resolveRun(opts) {
  return typeof opts?.run === 'function' ? opts.run : defaultRun;
}

/** run を呼ぶが絶対に throw しない。戻り値は常に run の結果形状。 */
async function safeRun(run, cmd, args, runOpts = {}) {
  try {
    const result = await run(cmd, args, runOpts);
    if (!result || typeof result !== 'object') {
      return { code: 0, stdout: '', stderr: '', pid: null, error: null };
    }
    return {
      code: result.code ?? 0,
      stdout: String(result.stdout ?? ''),
      stderr: String(result.stderr ?? ''),
      pid: Number.isInteger(result.pid) ? result.pid : null,
      error: result.error ?? null,
    };
  } catch (error) {
    return failureResult(error);
  }
}

function isOk(result) {
  return Boolean(result) && result.code === 0;
}

/* ------------------------------------------------------------------ */
/* 小さなユーティリティ                                                */
/* ------------------------------------------------------------------ */

function toInt(value, fallback) {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) ? n : fallback;
}

function round(value, digits = 1) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** '720x1600' と { w, h }（soc-catalog の DEVICE_PROFILES 形式）の両方を受ける。 */
function normalizeResolution(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    const match = value.trim().match(/^(\d+)\s*[x×]\s*(\d+)$/i);
    return match ? `${Number(match[1])}x${Number(match[2])}` : null;
  }
  if (typeof value === 'object') {
    const w = toInt(value.w ?? value.width, null);
    const h = toInt(value.h ?? value.height, null);
    return w && h ? `${w}x${h}` : null;
  }
  return null;
}

function emptyAndroid() {
  return { available: false, emulatorPath: null, avdmanagerPath: null, adbPath: null, avds: [] };
}

function emptyIos() {
  return { available: false, xcrunPath: null, simctlPath: null, runtimes: [], devices: [] };
}

/**
 * profile は「文字列（AVD 名）」またはオブジェクト。
 * 他担当の SoC カタログとは独立に、端末プロファイルとして最小限のキーだけ解釈する。
 */
function normalizeProfile(profile) {
  const p = typeof profile === 'string' ? { name: profile } : profile && typeof profile === 'object' ? profile : {};

  const apiLevel = toInt(p.apiLevel ?? p.api, 30);
  const tag = String(p.tag ?? p.imageTag ?? 'google_apis');
  const abi = String(p.abi ?? p.arch ?? 'x86_64');
  const simulator = p.simulator && typeof p.simulator === 'object' ? p.simulator : {};

  return {
    raw: p,
    platform: String(p.platform ?? p.kind ?? 'android') === 'ios' ? 'ios' : 'android',
    avdName: String(p.avdName ?? p.name ?? p.id ?? `dsh-api${apiLevel}`),
    apiLevel,
    tag,
    abi,
    systemImage: String(
      p.systemImage ?? p.image ?? `system-images;android-${apiLevel};${tag};${abi}`,
    ),
    deviceId: String(p.device ?? p.deviceId ?? p.deviceProfile ?? 'pixel_2'),
    avdPath: p.avdPath ? String(p.avdPath) : null,
    maxCores: toInt(p.maxCores ?? p.cores, 8),
    packageName: p.packageName ?? p.pkg ?? p.package ?? null,
    udid: p.udid ?? simulator.udid ?? null,
    deviceName: String(simulator.deviceName ?? p.deviceName ?? p.name ?? 'iPhone SE (3rd generation)'),
    runtime: String(simulator.runtime ?? p.runtime ?? 'iOS 17.5'),
    statusBar: simulator.statusBar ?? p.statusBar ?? null,
  };
}

/** 制約の既定値を埋める（クランプはしない）。 */
function withConstraintDefaults(constraints = {}) {
  const c = constraints && typeof constraints === 'object' ? constraints : {};
  return {
    ramMb: toInt(c.ramMb ?? c.memoryMb, 2048),
    heapMb: toInt(c.heapMb ?? c.heapSizeMb, 256),
    cores: toInt(c.cores, 4),
    gpuMode: String(c.gpuMode ?? 'swiftshader_indirect'),
    resolution: normalizeResolution(c.resolution) ?? '720x1600',
    dpi: toInt(c.dpi, 320),
  };
}

/* ------------------------------------------------------------------ */
/* 検出                                                                */
/* ------------------------------------------------------------------ */

function sdkRoots(platform, env) {
  const roots = [env.ANDROID_HOME, env.ANDROID_SDK_ROOT, env.ANDROID_SDK_HOME]
    .filter(Boolean)
    .map(String);
  if (platform === 'win32' && env.LOCALAPPDATA) {
    roots.push(path.join(String(env.LOCALAPPDATA), 'Android', 'Sdk'));
  }
  if (platform === 'darwin') {
    roots.push(path.join(homedir(), 'Library', 'Android', 'sdk'));
  }
  if (platform === 'linux') {
    roots.push(path.join(homedir(), 'Android', 'Sdk'));
  }
  return [...new Set(roots)];
}

function toolCandidates(roots, platform, tool) {
  const isWin = platform === 'win32';
  // avdmanager だけは Windows でも .bat。他は .exe。
  const suffix = isWin ? (tool === 'avdmanager' ? '.bat' : '.exe') : '';
  const sub = tool === 'emulator' ? 'emulator' : tool === 'adb' ? 'platform-tools' : 'cmdline-tools/latest/bin';

  const paths = roots.map((root) => path.join(root, sub, `${tool}${suffix}`));
  if (isWin && tool === 'avdmanager') {
    for (const root of roots) {
      paths.push(path.join(root, 'cmdline-tools', 'bin', 'avdmanager.bat'));
      paths.push(path.join(root, 'tools', 'bin', 'avdmanager.bat'));
    }
  }

  const names = isWin
    ? tool === 'avdmanager'
      ? ['avdmanager.bat', 'avdmanager']
      : [`${tool}.exe`, tool]
    : [tool];
  return [...new Set([...paths, ...names])];
}

async function findTool(run, candidates, args, timeoutMs) {
  for (const candidate of candidates) {
    const result = await safeRun(run, candidate, args, { timeoutMs });
    if (isOk(result)) return { path: candidate, result };
  }
  return null;
}

function parseAvdList(stdout) {
  const avds = [];
  let current = null;
  for (const raw of String(stdout ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;

    const nameMatch = line.match(/^Name:\s*(.+)$/);
    if (nameMatch) {
      current = { name: nameMatch[1].trim(), target: null, apiLevel: null, ramMb: null };
      avds.push(current);
      continue;
    }
    if (!current) continue;

    const targetMatch = line.match(/^Target:\s*(.+)$/);
    if (targetMatch) {
      current.target = targetMatch[1].trim();
      const apiMatch = current.target.match(/API\s+(\d+)/i) ?? current.target.match(/android-(\d+)/i);
      if (apiMatch) current.apiLevel = toInt(apiMatch[1], null);
      continue;
    }

    const ramMatch = line.match(/^(?:RAM|hw\.ramSize)\s*:\s*(\d+)\s*([Mm])?/i);
    if (ramMatch) {
      current.ramMb = toInt(ramMatch[1], null);
    }
  }
  return avds;
}

async function detectAndroid(run, platform, env, timeoutMs) {
  const roots = sdkRoots(platform, env);

  const emulator = await findTool(run, toolCandidates(roots, platform, 'emulator'), ['-version'], timeoutMs);
  const adb = await findTool(run, toolCandidates(roots, platform, 'adb'), ['version'], timeoutMs);
  const avdManager = await findTool(
    run,
    toolCandidates(roots, platform, 'avdmanager'),
    ['list', 'avd'],
    timeoutMs,
  );

  const available = Boolean(emulator && adb);
  const emulatorPath = emulator?.path ?? null;
  const adbPath = adb?.path ?? null;
  const avdmanagerPath = avdManager?.path ?? null;

  let avds = [];
  if (emulatorPath) {
    if (avdManager) {
      avds = parseAvdList(avdManager.result.stdout);
    } else {
      // avdmanager が無くても、既存 AVD の名前だけは emulator から取れる。
      const listed = await safeRun(run, emulatorPath, ['-list-avds'], { timeoutMs });
      if (isOk(listed)) {
        avds = String(listed.stdout ?? '')
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line && !line.startsWith('INFO') && !line.startsWith('WARNING'))
          .map((name) => ({ name, target: null, apiLevel: null, ramMb: null }));
      }
    }
  }

  return { available, emulatorPath, avdmanagerPath, adbPath, avds };
}

function parseSimctlRuntimes(stdout) {
  const runtimes = [];
  for (const raw of String(stdout ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('==')) continue;
    const match = line.match(/^(iOS\s+[\d.]+)\s*\(/);
    if (match && !runtimes.includes(match[1].trim())) runtimes.push(match[1].trim());
  }
  return runtimes;
}

function parseSimctlDevices(stdout) {
  const devices = [];
  let runtime = null;
  for (const raw of String(stdout ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;

    const section = line.match(/^--\s*(.+?)\s*--$/);
    if (section) {
      runtime = section[1].trim();
      continue;
    }
    const device = line.match(/^(.+?)\s*\(([0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12})\)\s*\(([^)]+)\)\s*$/);
    if (device) {
      devices.push({
        name: device[1].trim(),
        udid: device[2].trim(),
        state: device[3].trim(),
        runtime,
      });
    }
  }
  return devices;
}

async function detectIos(run, platform, env, timeoutMs) {
  if (platform !== 'darwin') return emptyIos();

  const xcrunCandidates = platform === 'darwin' ? ['xcrun', '/usr/bin/xcrun'] : ['xcrun'];
  const xcrun = await findTool(run, xcrunCandidates, ['--version'], timeoutMs);
  if (!xcrun) return emptyIos();

  const simctl = await findTool(run, [xcrun.path], ['simctl', 'help'], timeoutMs);
  if (!simctl) {
    return { ...emptyIos(), xcrunPath: xcrun.path };
  }

  const runtimesResult = await safeRun(run, xcrun.path, ['simctl', 'list', 'runtimes'], { timeoutMs });
  const devicesResult = await safeRun(run, xcrun.path, ['simctl', 'list', 'devices'], { timeoutMs });

  return {
    available: true,
    xcrunPath: xcrun.path,
    // simctl は xcrun 経由でしか呼べないため、同じ実行パスを指す。
    simctlPath: xcrun.path,
    runtimes: isOk(runtimesResult) ? parseSimctlRuntimes(runtimesResult.stdout) : [],
    devices: isOk(devicesResult) ? parseSimctlDevices(devicesResult.stdout) : [],
  };
}

/**
 * エミュレーター関連ツールの検出。プロセスは起動しない（バージョン確認のみ）。
 *
 * @param {{ run?:Function, platform?:string, env?:object, timeoutMs?:number }} [opts]
 * @returns {Promise<{android:{available:boolean,emulatorPath:string|null,avdmanagerPath:string|null,adbPath:string|null,avds:Array<{name:string,target:string|null,apiLevel:number|null,ramMb:number|null}>}, ios:{available:boolean,xcrunPath:string|null,simctlPath:string|null,runtimes:string[],devices:Array<{name:string,udid:string,state:string,runtime:string|null}>}}>}
 */
export async function detectEmulators(opts = {}) {
  const run = resolveRun(opts);
  const platform = String(opts.platform ?? process.platform);
  const env = opts.env ?? process.env;
  const timeoutMs = opts.timeoutMs ?? 4000;

  let android = emptyAndroid();
  let ios = emptyIos();

  try {
    android = (await detectAndroid(run, platform, env, timeoutMs)) ?? emptyAndroid();
  } catch {
    android = emptyAndroid();
  }
  try {
    // Windows / Linux では iOS 側は必ず available:false（例外も投げない）。
    ios = (await detectIos(run, platform, env, timeoutMs)) ?? emptyIos();
  } catch {
    ios = emptyIos();
  }

  return { android, ios };
}

/* ------------------------------------------------------------------ */
/* 引数組み立て                                                        */
/* ------------------------------------------------------------------ */

/**
 * AVD 作成（および --force による上書き）用の avdmanager 引数。
 * -c は本プラグイン契約では RAM(MB)、-H は AVD のヒープサイズ（本プラグイン拡張）。
 *
 * @param {object|string} profile
 * @param {object} [constraints]
 * @returns {string[]}
 */
export function buildAvdArgs(profile, constraints = {}) {
  const p = normalizeProfile(profile);
  const c = withConstraintDefaults(constraints);

  const args = [
    'create',
    'avd',
    '-n',
    p.avdName,
    '-k',
    p.systemImage,
    '-d',
    p.deviceId,
    '-c',
    `${c.ramMb}M`,
    '-H',
    `${c.heapMb}M`,
  ];
  if (p.avdPath) args.push('-p', p.avdPath);
  args.push('--force');
  return args;
}

/**
 * SoC の物理上限で制約をクランプする。warnings は戻り値の配列で返す。
 * 形式: `<token>: <説明>`（token は機械判定用: ram_clamped / heap_clamped / cores_clamped / gpu_mode_normalized）。
 *
 * @param {object} profile
 * @param {{memoryLimitGB?:number, recommendedHeapMb?:number}} soc
 * @param {object} constraints
 * @returns {{constraints:{ramMb:number,heapMb:number,cores:number,gpuMode:string,resolution:string,dpi:number}, warnings:string[]}}
 */
export function clampConstraints(profile, soc, constraints = {}) {
  const p = normalizeProfile(profile);
  const s = soc && typeof soc === 'object' ? soc : {};
  const base = withConstraintDefaults(constraints);
  const warnings = [];
  const resolution =
    normalizeResolution(constraints?.resolution) ??
    normalizeResolution(p.raw?.resolution) ??
    base.resolution;

  let ramMb = base.ramMb;
  const ramLimitMb = Number.isFinite(Number(s.memoryLimitGB)) && Number(s.memoryLimitGB) > 0
    ? Math.floor(Number(s.memoryLimitGB) * 1024)
    : null;

  if (ramLimitMb !== null && ramMb > ramLimitMb) {
    const clamped = Math.floor(ramLimitMb / 64) * 64;
    warnings.push(
      `ram_clamped: ramMb ${ramMb} -> ${clamped} (SoC メモリ上限 ${s.memoryLimitGB}GB)`,
    );
    ramMb = clamped;
  }
  if (ramMb < 512) {
    warnings.push(`ram_raised: ramMb ${ramMb} -> 512 (最小値)`);
    ramMb = 512;
  }

  let heapMb = base.heapMb;
  const heapLimitMb = Math.min(
    Number.isFinite(Number(s.recommendedHeapMb)) && Number(s.recommendedHeapMb) > 0
      ? Math.floor(Number(s.recommendedHeapMb))
      : 256,
    ramMb,
  );
  if (heapMb > heapLimitMb) {
    warnings.push(`heap_clamped: heapMb ${heapMb} -> ${heapLimitMb}`);
    heapMb = heapLimitMb;
  }
  if (heapMb < 64) {
    heapMb = 64;
  }

  let cores = base.cores;
  const coreLimit = Number.isFinite(p.maxCores) && p.maxCores > 0 ? p.maxCores : 8;
  if (cores > coreLimit) {
    warnings.push(`cores_clamped: cores ${cores} -> ${coreLimit}`);
    cores = coreLimit;
  }
  if (cores < 1) {
    warnings.push(`cores_clamped: cores ${cores} -> 1`);
    cores = 1;
  }

  let gpuMode = base.gpuMode;
  if (!GPU_MODES.includes(gpuMode)) {
    warnings.push(
      `gpu_mode_normalized: gpuMode "${gpuMode}" -> "swiftshader_indirect"`,
    );
    gpuMode = 'swiftshader_indirect';
  }

  return {
    constraints: {
      ramMb,
      heapMb,
      cores,
      gpuMode,
      resolution,
      dpi: base.dpi,
    },
    warnings,
  };
}

function normalizeNetwork(network) {
  if (!network) return null;
  if (typeof network === 'string') {
    const name = network.trim();
    if (!name) return null;
    return { delay: name, speed: name === 'none' ? 'full' : name };
  }
  if (typeof network !== 'object') return null;
  const delay = String(network.delay ?? network.latency ?? network.name ?? 'none');
  let speed = String(network.speed ?? network.bandwidth ?? network.name ?? 'none');
  if (delay === 'none') speed = 'full';
  if (speed === 'none') speed = 'full';
  return { delay, speed };
}

/**
 * emulator（AVD）起動引数。
 *
 * @param {object|string} profile
 * @param {{constraints?:object, network?:object|string, networkProfile?:object|string,
 *          headless?:boolean, noWindow?:boolean, readOnly?:boolean,
 *          writableSystem?:boolean, extraArgs?:string[]}} [opts]
 * @returns {string[]}
 */
export function buildBootArgs(profile, opts = {}) {
  const p = normalizeProfile(profile);
  const c = withConstraintDefaults(opts.constraints ?? {});
  const resolution =
    normalizeResolution(opts.constraints?.resolution) ??
    normalizeResolution(p.raw?.resolution) ??
    c.resolution;

  const args = [
    '-avd',
    p.avdName,
    '-no-snapshot',
    '-memory',
    String(c.ramMb),
    '-gpu',
    c.gpuMode,
    '-cores',
    String(c.cores),
  ];

  if (/^\d+x\d+$/.test(resolution)) {
    args.push('-skin', resolution);
  }

  const network = normalizeNetwork(opts.network ?? opts.networkProfile);
  if (network) {
    args.push('-netdelay', network.delay, '-netspeed', network.speed);
  }

  if (opts.headless || opts.noWindow) args.push('-no-window');
  if (opts.readOnly) args.push('-read-only');
  if (opts.writableSystem) args.push('-writable-system');
  if (Array.isArray(opts.extraArgs)) args.push(...opts.extraArgs);

  return args;
}

/**
 * xcrun に渡す simctl 引数（起動）。
 * 注: status_bar override は別コマンドのため launch() 側で発行する。
 *
 * @param {object|string} profile
 * @returns {string[]}
 */
export function buildSimctlArgs(profile) {
  const p = normalizeProfile(profile);
  const target = p.udid ?? p.deviceName;
  return ['simctl', 'boot', String(target)];
}

function buildStatusBarArgs(profile) {
  const p = normalizeProfile(profile);
  const bar = p.statusBar;
  if (!bar || typeof bar !== 'object') return null;
  const target = p.udid ?? p.deviceName;
  const args = ['simctl', 'status_bar', String(target), 'override'];
  if (bar.time !== undefined) args.push('--time', String(bar.time));
  if (bar.batteryLevel !== undefined) args.push('--batteryLevel', String(bar.batteryLevel));
  if (bar.cellularBars !== undefined) args.push('--cellularBars', String(bar.cellularBars));
  if (bar.wifiBars !== undefined) args.push('--wifiBars', String(bar.wifiBars));
  return args.length > 4 ? args : null;
}

/* ------------------------------------------------------------------ */
/* 起動 / 停止                                                         */
/* ------------------------------------------------------------------ */

/**
 * エミュレーターを起動する。例外は投げず、失敗は `{ ok:false, error }` で返す。
 *
 * target: { kind?:'android'|'ios', profile?:object|string, constraints?:object,
 *           serial?:string, emulatorPath?:string, xcrunPath?:string }
 * 戻り値: { pid:number|null, command:string[], kind:'android'|'ios', serial:string|null,
 *           ok:boolean, error:null|{message:string, code:number|null, stderr:string} }
 *
 * 注: iOS は simctl boot が短命コマンドのため pid は null（serial が udid になる）。
 *
 * @param {object} target
 * @param {{run?:Function, timeoutMs?:number}} [opts]
 */
export async function launch(target = {}, opts = {}) {
  const run = resolveRun(opts);
  const t = target && typeof target === 'object' ? target : {};
  const profileSource = t.profile ?? t;
  const p = normalizeProfile(profileSource);
  const kind = t.kind === 'ios' || (!t.kind && p.platform === 'ios') ? 'ios' : 'android';
  const timeoutMs = opts.timeoutMs ?? (kind === 'ios' ? 120000 : 60000);

  if (kind === 'ios') {
    const xcrunPath = String(opts.xcrunPath ?? t.xcrunPath ?? 'xcrun');
    const bootArgs = buildSimctlArgs(p);
    const command = [xcrunPath, ...bootArgs];
    const serial = p.udid ?? p.deviceName ?? null;

    const result = await safeRun(run, xcrunPath, bootArgs, { timeoutMs });
    if (!isOk(result)) {
      return {
        pid: null,
        command,
        kind,
        serial,
        ok: false,
        error: {
          message: result.error ?? result.stderr ?? 'simctl boot に失敗しました',
          code: result.code ?? null,
          stderr: result.stderr ?? '',
        },
      };
    }

    // status_bar override は装飾。失敗しても起動自体は成功扱い。
    const statusBarArgs = buildStatusBarArgs(p);
    if (statusBarArgs) {
      await safeRun(run, xcrunPath, statusBarArgs, { timeoutMs: 15000 });
    }

    return { pid: null, command, kind, serial, ok: true, error: null };
  }

  const emulatorPath = String(opts.emulatorPath ?? t.emulatorPath ?? 'emulator');
  const bootArgs = buildBootArgs(p, { ...opts, constraints: t.constraints ?? opts.constraints });
  const command = [emulatorPath, ...bootArgs];
  const serial = String(
    t.serial ?? opts.serial ?? `emulator-${toInt(opts.port ?? t.port, ANDROID_DEFAULT_SERIAL_PORT)}`,
  );

  const result = await safeRun(run, emulatorPath, bootArgs, { detached: true, timeoutMs });
  const pid = Number.isInteger(result?.pid) ? result.pid : null;
  const code = result?.code ?? null;

  if (pid === null || code !== 0) {
    return {
      pid,
      command,
      kind,
      serial,
      ok: false,
      error: {
        message: result?.error ?? 'エミュレーターを起動できませんでした',
        code,
        stderr: result?.stderr ?? '',
      },
    };
  }

  return { pid, command, kind, serial, ok: true, error: null };
}

/**
 * 起動したエミュレーターを停止する。
 *
 * @param {{kind?:string, serial?:string|null, udid?:string|null}} handle
 * @param {{run?:Function, adbPath?:string, xcrunPath?:string}} [opts]
 * @returns {Promise<{ok:boolean, kind:string, command:string[], code:number|null, stderr:string}>}
 */
export async function shutdown(handle = {}, opts = {}) {
  const run = resolveRun(opts);
  const h = handle && typeof handle === 'object' ? handle : {};
  const kind = h.kind === 'ios' || (!h.kind && h.udid) ? 'ios' : 'android';
  const timeoutMs = opts.timeoutMs ?? 60000;

  if (kind === 'ios') {
    const xcrunPath = String(opts.xcrunPath ?? h.xcrunPath ?? 'xcrun');
    const udid = h.udid ?? h.serial ?? null;
    const args = ['simctl', 'shutdown', ...(udid ? [String(udid)] : [])];
    const result = await safeRun(run, xcrunPath, args, { timeoutMs });
    return {
      ok: isOk(result),
      kind,
      command: [xcrunPath, ...args],
      code: result.code ?? null,
      stderr: result.stderr ?? '',
    };
  }

  const adbPath = String(opts.adbPath ?? h.adbPath ?? 'adb');
  const serial = h.serial ?? null;
  const args = [...(serial ? ['-s', String(serial)] : []), 'emu', 'kill'];
  const result = await safeRun(run, adbPath, args, { timeoutMs });
  return {
    ok: isOk(result),
    kind,
    command: [adbPath, ...args],
    code: result.code ?? null,
    stderr: result.stderr ?? '',
  };
}

/* ------------------------------------------------------------------ */
/* 実測 FPS                                                            */
/* ------------------------------------------------------------------ */

function unavailableResult() {
  return { fps: null, method: 'unavailable', samples: [] };
}

function inferPlatform(serialOrUdid, opts) {
  if (opts?.platform === 'ios' || opts?.platform === 'android') return opts.platform;
  const id = String(serialOrUdid ?? '');
  if (/^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/.test(id)) {
    return 'ios';
  }
  return 'android';
}

/**
 * dumpsys gfxinfo <pkg> framestats の出力からフレーム間隔を取り出す。
 * 壊れた出力（PROFILEDATA や FrameCompleted 列が無い）では空配列。
 */
function parseFramestats(stdout, maxSamples) {
  const lines = String(stdout ?? '').split(/\r?\n/);
  const completions = [];
  let inBlock = false;
  let expectHeader = false;
  let frameIndex = -1;
  let sawHeader = false;

  for (const raw of lines) {
    const line = raw.trim();
    if (line === '---PROFILEDATA---') {
      if (!inBlock) {
        inBlock = true;
        expectHeader = true;
      } else {
        inBlock = false;
      }
      continue;
    }
    if (!inBlock || !line) continue;

    if (expectHeader) {
      const columns = line.split(',').map((c) => c.trim());
      const idx = columns.indexOf('FrameCompleted');
      expectHeader = false;
      if (idx < 0) {
        // ヘッダに必要な列が無いブロックは使わない。
        inBlock = false;
        continue;
      }
      frameIndex = idx;
      sawHeader = true;
      continue;
    }

    const cells = line.split(',');
    if (frameIndex < 0 || cells.length <= frameIndex) continue;
    const value = Number(cells[frameIndex]);
    if (Number.isFinite(value) && value > 0) completions.push(value);
  }

  if (!sawHeader || completions.length < 2) return [];

  const deltas = [];
  for (let i = 1; i < completions.length; i += 1) {
    const delta = completions[i] - completions[i - 1];
    if (delta > 0 && delta < MAX_DELTA_NS) deltas.push(delta);
  }

  const limit = Number.isInteger(maxSamples) && maxSamples > 0 ? maxSamples : MAX_SAMPLES_DEFAULT;
  return deltas.slice(-limit).map((delta) => round(1e9 / delta, 2));
}

async function sampleFpsAndroid(serial, run, opts) {
  const packageName = String(
    opts.packageName ?? opts.pkg ?? opts.package ?? 'com.example.app',
  );
  const adbPath = String(opts.adbPath ?? 'adb');
  const args = [
    ...(serial ? ['-s', String(serial)] : []),
    'shell',
    'dumpsys',
    'gfxinfo',
    packageName,
    'framestats',
  ];

  const result = await safeRun(run, adbPath, args, { timeoutMs: opts.timeoutMs ?? 9000 });
  if (!isOk(result)) return unavailableResult();

  const samples = parseFramestats(result.stdout, opts.maxSamples);
  if (samples.length < 2) return unavailableResult();

  const intervals = samples.map((fps) => 1e9 / fps);
  const fps = 1e9 / median(intervals);
  return { fps: round(fps, 1), method: 'gfxinfo', samples };
}

async function sampleFpsIos(udid, run, opts) {
  if (!udid) return unavailableResult();
  const xcrunPath = String(opts.xcrunPath ?? 'xcrun');
  const windowSeconds = toInt(opts.windowSeconds, 2);
  const args = [
    'simctl',
    'spawn',
    String(udid),
    'log',
    'show',
    '--style',
    'compact',
    '--last',
    `${windowSeconds}s`,
    '--predicate',
    'eventMessage CONTAINS "FPS"',
  ];

  const result = await safeRun(run, xcrunPath, args, { timeoutMs: opts.timeoutMs ?? 12000 });
  if (!isOk(result)) return unavailableResult();

  // 「58.5 FPS」と「FPS: 58.5」の両方の書き方を受ける。
  const values = [];
  const patterns = [
    /(\d+(?:\.\d+)?)\s*(?:fps|FPS)\b/g,
    /(?:fps|FPS)\s*[:=]?\s*(\d+(?:\.\d+)?)/g,
  ];
  for (const pattern of patterns) {
    for (const match of String(result.stdout ?? '').matchAll(pattern)) {
      const value = Number(match[1]);
      if (Number.isFinite(value) && value > 0 && value < 600) values.push(value);
    }
  }
  if (!values.length) return unavailableResult();

  return {
    fps: round(median(values), 1),
    method: 'simctl',
    samples: values.map((value) => round(value, 2)),
  };
}

/**
 * 実測 FPS を 1 サンプル取る。例外は投げず、取れない場合は method:'unavailable'。
 *
 * @param {string} serialOrUdid
 * @param {{run?:Function, platform?:'android'|'ios', packageName?:string,
 *          adbPath?:string, xcrunPath?:string, maxSamples?:number, timeoutMs?:number}} [opts]
 * @returns {Promise<{fps:number|null, method:'gfxinfo'|'simctl'|'unavailable', samples:number[]}>}
 */
export async function sampleFps(serialOrUdid, opts = {}) {
  try {
    const run = resolveRun(opts);
    const platform = inferPlatform(serialOrUdid, opts);
    if (platform === 'ios') return await sampleFpsIos(serialOrUdid, run, opts);
    return await sampleFpsAndroid(serialOrUdid, run, opts);
  } catch {
    return unavailableResult();
  }
}

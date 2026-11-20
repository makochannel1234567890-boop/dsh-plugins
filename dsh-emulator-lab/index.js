/**
 * dsh-emulator-lab — 右サイドバーから Android AVD / iOS Simulator を起動し、
 * SoC ごとのローエンド性能を FPS として推定・実測する Host プラグイン。
 *
 * 責務の分け方:
 *   - lib/soc-catalog.js … SoC と端末プロファイルのカタログ（純データ）
 *   - lib/soc-model.js   … 決定的な FPS 推定モデル（乱数・時刻を使わない）
 *   - lib/emulator.js    … 検出・起動・停止・実測サンプリング（I/O）
 *   - index.js（ここ）   … ツール登録、引数の検証、カタログ解決、出力の整形だけ
 *
 * lib/ は遅延 import する。プラグイン読み込みの時点で lib のどれかが
 * 書きかけ・不在でも Host 側の起動を壊さず、ツール呼び出し時に
 * 何が足りないかを説明できるようにするため。
 *
 * @module dsh-emulator-lab
 */

export const name = 'emulator-lab'

/**
 * 必須サービス。任意サービスは `ctx.get(name)` で取る。
 * `systemPrompt` は任意（無いプロファイルでもプロンプト注入だけ諦めて動く）。
 */
export const inject = ['tools']

const SECTION_NAME = 'tool:emulator-lab'
/** 既存セクション（長考 2450 / テンプレート 2500）の直後。 */
const SECTION_ORDER = 2520

const PROMPT_SECTION = `## Emulator lab (dsh-emulator-lab)

When the user wants to see how a low-end phone runs something, use this plugin instead of guessing:
- \`emulator_detect\` — which emulator tooling exists on this machine, and which SoC / device profiles are catalogued. Run it first when a launch fails.
- \`emulator_launch\` — boot a profile: \`platform\` (\`android\` or \`ios\`) plus \`deviceProfileId\`; \`socId\` overrides the profile's SoC. RAM/heap/cores are clamped to that SoC's limits.
- \`emulator_fps\` — \`mode:'simulated'\` returns a deterministic estimate for a workload, \`mode:'measured'\` samples a running emulator.

Android and iOS are separate platforms: never compare or mix their profiles. A simulated FPS is an estimate — when reporting it, say "estimated", name the bottleneck, and quote the warnings.`

/** 数値の「無し」は union ではなくセンチネルで表す（出力スキーマを単純に保つ）。 */
const UNAVAILABLE = -1

/**
 * シミュレーションの既定ワークロード。「軽めの 3D ゲームを 720p/60fps で動かす」
 * 想定で、ローエンド SoC でも 1fps に潰れず差が出る値にしてある。
 * ツール引数で個別に上書きできる。
 */
const DEFAULT_WORKLOAD = Object.freeze({
  id: 'default-3d',
  name: 'Casual 3D scene',
  mtRequirement: 1.5,
  cpuWeight: 0.8,
  gpuWeight: 0.8,
  vramMb: 384,
  threads: 4,
  targetFps: 60,
})

/* --------------------------------------------------------------------- */
/* lib の遅延 import                                                      */
/* --------------------------------------------------------------------- */

let libsPromise

function loadLibs() {
  if (libsPromise === undefined) {
    libsPromise = Promise.all([
      import('./lib/soc-catalog.js'),
      import('./lib/soc-model.js'),
      import('./lib/emulator.js'),
    ])
      .then(([socCatalog, socModel, emulator]) => ({ socCatalog, socModel, emulator }))
      .catch((error) => {
        // 次回の呼び出しで再試行できるよう、失敗した promise を捨てる。
        libsPromise = undefined
        const reason = error instanceof Error ? error.message : String(error)
        throw new Error(
          `dsh-emulator-lab の lib/*.js を読み込めませんでした（${reason}）。`
          + ' lib/soc-catalog.js・lib/soc-model.js・lib/emulator.js が揃っているか確認してください。',
        )
      })
  }
  return libsPromise
}

/* --------------------------------------------------------------------- */
/* 小さな入力ヘルパ                                                       */
/* --------------------------------------------------------------------- */

function asObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function asText(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function asFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function renderJson(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

function requirePlatform(value) {
  if (value === 'android' || value === 'ios') return value
  throw new Error('platform には "android" か "ios" を指定してください。')
}

function requireText(value, field, hint) {
  const text = asText(value)
  if (text.length > 0) return text
  throw new Error(`${field} を指定してください。${hint ?? ''}`.trim())
}

/** 端末プロファイルを引き、プラットフォームの食い違いを先に弾く。 */
function requireDeviceProfile(catalog, id, platform) {
  const profile = catalog.getDeviceProfile(id)
  if (profile === undefined) {
    const candidates = catalog.DEVICE_PROFILES
      .filter((entry) => platform === undefined || entry.platform === platform)
      .map((entry) => entry.id)
    throw new Error(
      `デバイスプロファイル "${id}" はカタログにありません。`
      + `候補: ${candidates.length > 0 ? candidates.join(', ') : '（該当なし）'}`,
    )
  }
  if (platform !== undefined && profile.platform !== platform) {
    throw new Error(
      `デバイスプロファイル "${id}" は ${profile.platform} 用です（platform: "${platform}" が指定されました）。`,
    )
  }
  return profile
}

/** プロファイルの SoC、または明示された socId を解決する。 */
function resolveSoc(catalog, profile, requestedId) {
  const socId = asText(requestedId).length > 0 ? asText(requestedId) : String(profile?.socId ?? '')
  const soc = catalog.getSoc(socId)
  if (soc === undefined) {
    throw new Error(
      `SoC "${socId}" はカタログにありません。lib/soc-catalog.js の SOC_CATALOG にある id を指定してください。`,
    )
  }
  return soc
}

/** 端末プロファイル + SoC から、SoC の物理上限に沿った制約を作る。 */
function constraintsFor(profile, soc) {
  const constraints = {}
  const memoryLimitGb = Number(soc?.memoryLimitGB)
  if (Number.isFinite(memoryLimitGb) && memoryLimitGb > 0) {
    constraints.ramMb = Math.round(memoryLimitGb * 1024)
  }
  const heapMb = Number(profile?.defaultHeapMb)
  if (Number.isFinite(heapMb) && heapMb > 0) {
    constraints.heapMb = Math.round(heapMb)
  }
  const width = Number(profile?.resolution?.w)
  const height = Number(profile?.resolution?.h)
  if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
    constraints.resolution = `${Math.round(width)}x${Math.round(height)}`
  }
  return constraints
}

/**
 * iOS の DEVICE_PROFILES の label は表示用（例: "iPhone 13 Pro (A15/120Hz)"）。
 * simctl が受け取るのはシミュレータ名（例: "iPhone 13 Pro"）なので、
 * 末尾の丸括弧を落として名前として渡す。
 */
function simulatorName(label) {
  const text = asText(label)
  if (text.length === 0) return ''
  return text.replace(/\s*\([^)]*\)\s*$/, '').trim() || text
}

/** ツール引数 > DEFAULT_WORKLOAD の順で 1 つのワークロードにまとめる。 */
function workloadFromArgs(input) {
  const pick = (key, fallback) => {
    const value = asFiniteNumber(input[key])
    return value === undefined ? fallback : value
  }
  const vram = asFiniteNumber(input.vramMb)
  return {
    id: DEFAULT_WORKLOAD.id,
    name: DEFAULT_WORKLOAD.name,
    mtRequirement: pick('mtRequirement', DEFAULT_WORKLOAD.mtRequirement),
    cpuWeight: pick('cpuWeight', DEFAULT_WORKLOAD.cpuWeight),
    gpuWeight: pick('gpuWeight', DEFAULT_WORKLOAD.gpuWeight),
    vramMb: vram !== undefined && vram >= 0 ? vram : DEFAULT_WORKLOAD.vramMb,
    threads: pick('threads', DEFAULT_WORKLOAD.threads),
    targetFps: pick('targetFps', DEFAULT_WORKLOAD.targetFps),
  }
}

function socLabel(soc) {
  if (soc === null || soc === undefined) return ''
  const vendor = asText(soc.vendor)
  const model = asText(soc.name)
  return `${vendor} ${model}`.trim()
}

/* --------------------------------------------------------------------- */
/* 出力スキーマ                                                           */
/* --------------------------------------------------------------------- */

const DETECT_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  required: [
    'androidAvailable',
    'androidEmulatorPath',
    'androidAvdmanagerPath',
    'androidAdbPath',
    'avds',
    'iosAvailable',
    'iosXcrunPath',
    'iosSimctlPath',
    'iosDevices',
    'iosRuntimes',
    'deviceProfiles',
    'socIds',
    'socCount',
    'deviceProfileCount',
    'warnings',
    'message',
  ],
  properties: {
    androidAvailable: { type: 'boolean', description: 'Android の emulator/adb が見つかったか。' },
    androidEmulatorPath: { type: 'string', description: '解決した emulator のパス（無ければ空文字）。' },
    androidAvdmanagerPath: { type: 'string', description: '解決した avdmanager のパス（無ければ空文字）。' },
    androidAdbPath: { type: 'string', description: '解決した adb のパス（無ければ空文字）。' },
    avds: {
      type: 'array',
      description: '既存の AVD。',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'target', 'apiLevel'],
        properties: {
          name: { type: 'string' },
          target: { type: 'string' },
          apiLevel: { type: 'integer', description: '不明なら -1。' },
        },
      },
    },
    iosAvailable: { type: 'boolean', description: 'iOS Simulator（xcrun/simctl）が使えるか。' },
    iosXcrunPath: { type: 'string' },
    iosSimctlPath: { type: 'string' },
    iosDevices: {
      type: 'array',
      description: '既存の Simulator。',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'udid', 'state'],
        properties: {
          name: { type: 'string' },
          udid: { type: 'string' },
          state: { type: 'string' },
        },
      },
    },
    iosRuntimes: { type: 'array', items: { type: 'string' } },
    deviceProfiles: {
      type: 'array',
      description: 'emulator_launch の deviceProfileId に渡せる値。',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'platform', 'socId', 'refreshHz'],
        properties: {
          id: { type: 'string' },
          platform: { type: 'string' },
          socId: { type: 'string' },
          refreshHz: { type: 'integer' },
        },
      },
    },
    socIds: {
      type: 'array',
      description: 'emulator_fps の socId に渡せる値。',
      items: { type: 'string' },
    },
    socCount: { type: 'integer' },
    deviceProfileCount: { type: 'integer' },
    warnings: { type: 'array', items: { type: 'string' } },
    message: { type: 'string' },
  },
}

const LAUNCH_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  required: [
    'ok',
    'platform',
    'deviceProfileId',
    'deviceLabel',
    'socId',
    'socName',
    'serial',
    'pid',
    'command',
    'constraints',
    'warnings',
    'error',
    'message',
  ],
  properties: {
    ok: { type: 'boolean' },
    platform: { type: 'string' },
    deviceProfileId: { type: 'string' },
    deviceLabel: { type: 'string' },
    socId: { type: 'string' },
    socName: { type: 'string' },
    serial: { type: 'string', description: 'adb serial（Android）または udid（iOS）。未確定なら空文字。' },
    pid: { type: 'integer', description: '起動したプロセス ID。iOS（短命な simctl）は -1。' },
    command: { type: 'array', items: { type: 'string' }, description: '実際に組み立てた起動コマンド。' },
    constraints: {
      type: 'object',
      additionalProperties: false,
      required: ['ramMb', 'heapMb', 'cores', 'gpuMode', 'resolution'],
      properties: {
        ramMb: { type: 'integer' },
        heapMb: { type: 'integer' },
        cores: { type: 'integer' },
        gpuMode: { type: 'string' },
        resolution: { type: 'string' },
      },
    },
    warnings: { type: 'array', items: { type: 'string' }, description: 'SoC 上限によるクランプ等。' },
    error: { type: 'string', description: '失敗時のみ非空。' },
    message: { type: 'string' },
  },
}

const FPS_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  required: [
    'mode',
    'ok',
    'fps',
    'targetFps',
    'method',
    'capped',
    'bottleneck',
    'socId',
    'socName',
    'deviceProfileId',
    'platform',
    'subscores',
    'samples',
    'warnings',
    'message',
  ],
  properties: {
    mode: { type: 'string', enum: ['simulated', 'measured'] },
    ok: { type: 'boolean', description: '使える数値が得られたか。' },
    fps: { type: 'number', description: 'FPS。取得できなければ -1。' },
    targetFps: { type: 'number', description: '目標 FPS。measured では -1。' },
    method: { type: 'string', description: 'estimated / gfxinfo / simctl / unavailable。' },
    capped: { type: 'boolean', description: '目標 FPS に張り付いているか。' },
    bottleneck: { type: 'string', description: 'gpu / cpu / memory / thermal / none / 空文字。' },
    socId: { type: 'string' },
    socName: { type: 'string' },
    deviceProfileId: { type: 'string' },
    platform: { type: 'string' },
    subscores: {
      type: 'object',
      additionalProperties: false,
      required: ['cpu', 'gpu', 'mem', 'thermal'],
      properties: {
        cpu: { type: 'number' },
        gpu: { type: 'number' },
        mem: { type: 'number' },
        thermal: { type: 'number' },
      },
    },
    samples: { type: 'array', items: { type: 'number' }, description: 'measured の生サンプル（FPS）。' },
    warnings: { type: 'array', items: { type: 'string' } },
    message: { type: 'string' },
  },
}

/* --------------------------------------------------------------------- */
/* プラグイン本体                                                         */
/* --------------------------------------------------------------------- */

export function apply(ctx, config = {}) {
  const settings = { enabled: config?.enabled !== false }
  if (!settings.enabled) return

  const log = (message) => {
    try {
      ctx.logger?.warn?.(`dsh-emulator-lab: ${message}`)
    } catch {
      // ログ失敗で本体を壊さない。
    }
  }

  /**
   * 登録したツール定義を名前で引けるようにしておく。Web API（右サイドバーの
   * パネル用）は同じ実装を薄く包むだけで、検証ロジックを二重に持たない。
   */
  const definitions = new Map()

  function registerTool(definition) {
    definitions.set(definition.name, definition)
    ctx.tools.register(definition)
  }

  /* ------------------------------------------------------------------- */
  /* emulator_detect                                                     */
  /* ------------------------------------------------------------------- */

  registerTool({
    name: 'emulator_detect',
    description: 'Report which emulator tooling this machine has (Android: emulator / avdmanager / adb; iOS: xcrun / simctl) and the SoC and device profiles this plugin catalogues, including the exact ids emulator_launch and emulator_fps accept. It only runs probe/version commands and never boots an emulator. Call it before the first launch, or when a launch fails because a tool is missing.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    output: { schema: DETECT_OUTPUT, render: renderJson },
    async execute() {
      const { socCatalog, emulator } = await loadLibs()
      const detected = asObject(await emulator.detectEmulators({ timeoutMs: 4000 }))
      const android = asObject(detected.android)
      const ios = asObject(detected.ios)

      const socs = Array.isArray(socCatalog.SOC_CATALOG) ? socCatalog.SOC_CATALOG : []
      const profiles = Array.isArray(socCatalog.DEVICE_PROFILES) ? socCatalog.DEVICE_PROFILES : []
      const avds = Array.isArray(android.avds) ? android.avds : []
      const iosDevices = Array.isArray(ios.devices) ? ios.devices : []

      const warnings = []
      if (android.available !== true) {
        warnings.push('Android エミュレータが見つかりません（PATH / ANDROID_HOME / ANDROID_SDK_ROOT を確認してください）。')
      }
      if (ios.available !== true) {
        warnings.push('iOS Simulator はこの OS では利用できません（macOS + Xcode が必要です）。')
      }

      const avdCount = avds.length
      const simCount = iosDevices.length
      const message = [
        android.available === true
          ? `Android OK（AVD ${avdCount} 件）`
          : 'Android なし',
        ios.available === true
          ? `iOS OK（Simulator ${simCount} 件）`
          : 'iOS なし',
        `SoC ${socs.length} 件 / 端末プロファイル ${profiles.length} 件`,
      ].join(' · ')

      return {
        androidAvailable: android.available === true,
        androidEmulatorPath: asText(android.emulatorPath),
        androidAvdmanagerPath: asText(android.avdmanagerPath),
        androidAdbPath: asText(android.adbPath),
        avds: avds.map((avd) => ({
          name: asText(avd?.name),
          target: asText(avd?.target),
          apiLevel: Number.isInteger(avd?.apiLevel) ? avd.apiLevel : UNAVAILABLE,
        })),
        iosAvailable: ios.available === true,
        iosXcrunPath: asText(ios.xcrunPath),
        iosSimctlPath: asText(ios.simctlPath),
        iosDevices: iosDevices.map((device) => ({
          name: asText(device?.name),
          udid: asText(device?.udid),
          state: asText(device?.state),
        })),
        iosRuntimes: (Array.isArray(ios.runtimes) ? ios.runtimes : []).map((runtime) => asText(runtime)),
        deviceProfiles: profiles.map((profile) => ({
          id: asText(profile?.id),
          platform: asText(profile?.platform),
          socId: asText(profile?.socId),
          refreshHz: Number.isFinite(Number(profile?.refreshHz)) ? Math.round(Number(profile.refreshHz)) : UNAVAILABLE,
        })),
        socIds: socs.map((soc) => asText(soc?.id)),
        socCount: socs.length,
        deviceProfileCount: profiles.length,
        warnings,
        message,
      }
    },
    presentCall: () => ({ card: 'generic', title: 'Detect emulators', kind: 'read' }),
  })

  /* ------------------------------------------------------------------- */
  /* emulator_launch                                                     */
  /* ------------------------------------------------------------------- */

  registerTool({
    name: 'emulator_launch',
    description: 'Boot an Android AVD or an iOS Simulator that represents a low-end phone profile. Takes the platform and a deviceProfileId (both listed by emulator_detect); socId overrides the profile SoC so the same screen can simulate a weaker or stronger chip. RAM, heap and core count are clamped to that SoC\'s physical limits, and the resulting launch command and any clamp warnings are returned. Booting a device is a real side effect: do not call it repeatedly, and prefer headless when the user only wants numbers.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['platform', 'deviceProfileId'],
      properties: {
        platform: {
          type: 'string',
          enum: ['android', 'ios'],
          description: 'Target platform. Android and iOS profiles are not interchangeable.',
        },
        deviceProfileId: {
          type: 'string',
          description: 'Device profile id from emulator_detect (for example "android-720p-t606").',
        },
        socId: {
          type: 'string',
          description: 'Optional SoC id that overrides the profile\'s own SoC (for example "helio-g85").',
        },
        headless: {
          type: 'boolean',
          description: 'Android only: add -no-window so nothing opens on screen. Ignored on iOS.',
        },
      },
    },
    output: { schema: LAUNCH_OUTPUT, render: renderJson },
    async execute(args) {
      const input = asObject(args)
      const platform = requirePlatform(input.platform)
      const deviceProfileId = requireText(
        input.deviceProfileId,
        'deviceProfileId',
        'emulator_detect の deviceProfiles[].id を渡してください。',
      )

      const { socCatalog, emulator } = await loadLibs()
      const profile = requireDeviceProfile(socCatalog, deviceProfileId, platform)
      const soc = resolveSoc(socCatalog, profile, input.socId)

      const clamped = asObject(emulator.clampConstraints(profile, soc, constraintsFor(profile, soc)))
      const constraints = asObject(clamped.constraints)
      const warnings = Array.isArray(clamped.warnings) ? clamped.warnings.map((warning) => String(warning)) : []

      const launchProfile = platform === 'ios'
        ? {
            ...profile,
            deviceName: simulatorName(profile.label) || String(profile.id),
            runtime: asText(profile.osVersion),
          }
        : profile

      const launchOpts = {}
      if (input.headless === true) launchOpts.headless = true

      const handle = asObject(await emulator.launch(
        { kind: platform, profile: launchProfile, constraints },
        launchOpts,
      ))

      const ok = handle.ok === true
      const serial = asText(handle.serial)
      const errorText = ok ? '' : asText(asObject(handle.error).message) || '起動コマンドが失敗しました'
      const message = ok
        ? `${platform} エミュレーターを起動しました（serial: ${serial.length > 0 ? serial : '未確定'}）。`
        : `起動に失敗しました: ${errorText}。emulator_detect でツールの有無を確認してください。`
      if (!ok) log(`launch failed: ${errorText}`)

      return {
        ok,
        platform,
        deviceProfileId: String(profile.id ?? deviceProfileId),
        deviceLabel: asText(profile.label),
        socId: String(soc.id ?? ''),
        socName: socLabel(soc),
        serial,
        pid: Number.isInteger(handle.pid) ? handle.pid : UNAVAILABLE,
        command: Array.isArray(handle.command) ? handle.command.map((part) => String(part)) : [],
        constraints: {
          ramMb: Math.round(Number(constraints.ramMb ?? 0)),
          heapMb: Math.round(Number(constraints.heapMb ?? 0)),
          cores: Math.round(Number(constraints.cores ?? 0)),
          gpuMode: asText(constraints.gpuMode),
          resolution: asText(constraints.resolution),
        },
        warnings,
        error: errorText,
        message,
      }
    },
    presentCall: (args) => {
      const input = asObject(args)
      return {
        card: 'generic',
        title: `Launch ${asText(input.platform) || 'emulator'}`,
        kind: 'execute',
        rawInput: asText(input.deviceProfileId),
      }
    },
  })

  /* ------------------------------------------------------------------- */
  /* emulator_fps                                                        */
  /* ------------------------------------------------------------------- */

  registerTool({
    name: 'emulator_fps',
    description: 'Answer "how many FPS does this low-end phone get?". mode:"simulated" computes a deterministic estimate from the SoC model for a workload (no emulator needed, no randomness, same input = same number); mode:"measured" samples a running emulator (Android dumpsys gfxinfo framestats, iOS simctl log). Report a simulated result as "estimated", name the bottleneck, and quote the warnings instead of presenting it as a benchmark.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['mode'],
      properties: {
        mode: {
          type: 'string',
          enum: ['simulated', 'measured'],
          description: 'simulated = estimate from the SoC model; measured = sample the running emulator.',
        },
        platform: {
          type: 'string',
          enum: ['android', 'ios'],
          description: 'Optional platform guard. For measured it disambiguates the serial/udid.',
        },
        socId: {
          type: 'string',
          description: 'simulated: SoC id from emulator_detect socIds. Defaults to the device profile\'s SoC.',
        },
        deviceProfileId: {
          type: 'string',
          description: 'simulated: device profile id; supplies the SoC and the device limits (heap, refresh rate).',
        },
        serial: {
          type: 'string',
          description: 'measured: Android adb serial or iOS simulator udid (emulator_launch returns it).',
        },
        packageName: {
          type: 'string',
          description: 'measured Android: app package to read framestats from (default com.example.app in lib).',
        },
        mtRequirement: { type: 'number', description: 'simulated: INT8 TOPS the workload needs (default 1.5).' },
        cpuWeight: { type: 'number', description: 'simulated: CPU load factor (default 0.8).' },
        gpuWeight: { type: 'number', description: 'simulated: GPU load factor (default 0.8).' },
        vramMb: { type: 'number', description: 'simulated: VRAM the workload needs in MB (default 384).' },
        threads: { type: 'number', description: 'simulated: worker thread count (default 4).' },
        targetFps: { type: 'number', description: 'simulated: frame target the workload aims for (default 60).' },
      },
    },
    output: { schema: FPS_OUTPUT, render: renderJson },
    async execute(args) {
      const input = asObject(args)
      const mode = input.mode === 'measured' ? 'measured' : input.mode === 'simulated' ? 'simulated' : undefined
      if (mode === undefined) throw new Error('mode には "simulated" か "measured" を指定してください。')

      const { socCatalog, socModel, emulator } = await loadLibs()

      if (mode === 'measured') {
        const serial = requireText(
          input.serial,
          'serial',
          'emulator_launch が返した serial（iOS は udid）を渡してください。',
        )
        const platform = input.platform === undefined ? undefined : requirePlatform(input.platform)
        const sampleOpts = {}
        if (platform !== undefined) sampleOpts.platform = platform
        const packageName = asText(input.packageName)
        if (packageName.length > 0) sampleOpts.packageName = packageName

        const sample = asObject(await emulator.sampleFps(serial, sampleOpts))
        const fps = asFiniteNumber(sample.fps)
        const method = asText(sample.method) || 'unavailable'
        const samples = (Array.isArray(sample.samples) ? sample.samples : [])
          .map((value) => Number(value))
          .filter((value) => Number.isFinite(value))
        const ok = fps !== undefined && fps > 0
        return {
          mode,
          ok,
          fps: ok ? fps : UNAVAILABLE,
          targetFps: UNAVAILABLE,
          method,
          capped: false,
          bottleneck: '',
          socId: '',
          socName: '',
          deviceProfileId: '',
          platform: platform ?? '',
          subscores: { cpu: 0, gpu: 0, mem: 0, thermal: 0 },
          samples,
          warnings: ok ? [] : ['実測値を取得できませんでした（対象アプリが前面でフレームを描いていない可能性があります）。'],
          message: ok
            ? `実測 ${fps} fps（${method}・${samples.length} サンプル）。`
            : '実測 FPS を取得できませんでした。アプリを起動してから再試行してください。',
        }
      }

      const deviceProfileId = asText(input.deviceProfileId)
      const platformGuard = input.platform === undefined ? undefined : requirePlatform(input.platform)
      const profile = deviceProfileId.length > 0
        ? requireDeviceProfile(socCatalog, deviceProfileId, platformGuard)
        : undefined
      if (profile === undefined && asText(input.socId).length === 0) {
        throw new Error(
          'simulated モードには socId か deviceProfileId が必要です。'
          + ' emulator_detect の socIds / deviceProfiles から選んでください。',
        )
      }
      const soc = resolveSoc(socCatalog, profile, input.socId)
      if (platformGuard !== undefined && soc.platform !== platformGuard) {
        throw new Error(
          `SoC "${String(soc.id)}" は ${String(soc.platform)} 用です（platform: "${platformGuard}" が指定されました）。`,
        )
      }

      const workload = workloadFromArgs(input)
      const estimate = asObject(
        profile === undefined
          ? socModel.estimateFps(soc, workload)
          : socModel.estimateFps(soc, workload, { device: profile }),
      )
      const warnings = Array.isArray(estimate.warnings) ? estimate.warnings.map((warning) => String(warning)) : []
      const fps = asFiniteNumber(estimate.fps)
      const usable = fps !== undefined && !warnings.some((warning) => warning.includes('推定できません'))
      const bottleneck = asText(estimate.bottleneck) || 'none'
      const subscores = asObject(estimate.subscores)

      return {
        mode,
        ok: usable,
        fps: fps === undefined ? UNAVAILABLE : fps,
        targetFps: asFiniteNumber(estimate.targetFps) ?? workload.targetFps,
        method: 'estimated',
        capped: estimate.capped === true,
        bottleneck,
        socId: String(soc.id ?? ''),
        socName: socLabel(soc),
        deviceProfileId: profile === undefined ? '' : String(profile.id ?? ''),
        platform: asText(soc.platform),
        subscores: {
          cpu: Number(subscores.cpu ?? 0),
          gpu: Number(subscores.gpu ?? 0),
          mem: Number(subscores.mem ?? 0),
          thermal: Number(subscores.thermal ?? 0),
        },
        samples: [],
        warnings,
        message: usable
          ? `推定 ${fps} fps（目標 ${asFiniteNumber(estimate.targetFps) ?? workload.targetFps}）。ボトルネック: ${bottleneck}。`
          : 'この入力では FPS を推定できませんでした。warnings を確認してください。',
      }
    },
    presentCall: (args) => {
      const input = asObject(args)
      return {
        card: 'generic',
        title: `FPS (${asText(input.mode) || 'simulated'})`,
        kind: 'other',
        rawInput: asText(input.socId) || asText(input.deviceProfileId) || asText(input.serial),
      }
    },
  })

  /* ------------------------------------------------------------------- */
  /* Web API（右サイドバーのパネル用）                                       */
  /*                                                                          */
  /* パネル（client/client.js）は同一オリジンのこの prefix に POST する。         */
  /* ホストが居なければパネルはローカル推定に落ちるので、ここが無くても         */
  /* 画面は壊れない（起動・停止だけが効かなくなる）。                          */
  /*   POST {prefix}/probe  {}                                   → 検出結果  */
  /*   POST {prefix}/start  {platform, deviceId, socId?}          → 起動      */
  /*   POST {prefix}/stop   {platform}                            → 停止      */
  /*   POST {prefix}/sample {platform, soc, device, workload}     → 推定 FPS  */
  /*                                                                          */
  /* /sample は 0.5 秒ごとに叩かれるので I/O を持たせない（実測はモデル向けの   */
  /* emulator_fps mode:"measured" が担う）。                                   */
  /* ------------------------------------------------------------------- */

  const API_PREFIX = '/dsh-emulator-lab/api'
  const API_BODY_LIMIT_BYTES = 256 * 1024

  /** このプラグインから起動したハンドル（/stop 用）。プロセス内だけの状態。 */
  const launches = new Map()

  function sendJson(res, status, payload) {
    const body = JSON.stringify(payload)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
    })
    res.end(body)
  }

  async function readJsonBody(req) {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > API_BODY_LIMIT_BYTES) throw new Error('body が大きすぎます。')
      chunks.push(chunk)
    }
    if (chunks.length === 0) return {}
    const text = Buffer.concat(chunks).toString('utf8').trim()
    if (text.length === 0) return {}
    try {
      return asObject(JSON.parse(text))
    } catch {
      throw new Error('body が JSON として読めません。')
    }
  }

  /** 同一オリジンだけ許可する（別サイトからの起動 POST を弾く）。 */
  function isSameOrigin(req) {
    const origin = req.headers?.origin
    if (typeof origin !== 'string' || origin.length === 0) return true
    try {
      return new URL(origin).host === req.headers?.host
    } catch {
      return false
    }
  }

  /** パネルはユーザーが動かした SoC 値そのものを送ってくる。妥当ならそれを使う。 */
  function suppliedSoc(body) {
    const soc = asObject(body.soc)
    const valid = ['tops', 'cpuScore', 'memBandwidthGBs', 'thermalBudgetW'].every((key) => {
      const value = soc[key]
      return typeof value === 'number' && Number.isFinite(value) && value > 0
    })
    return valid ? soc : undefined
  }

  async function probePayload() {
    const detected = await definitions.get('emulator_detect').execute({}, {})
    return {
      ok: true,
      android: {
        available: detected.androidAvailable === true,
        reason: detected.androidAvailable === true
          ? undefined
          : 'emulator / adb が見つかりません（PATH / ANDROID_HOME / ANDROID_SDK_ROOT）。',
      },
      ios: {
        available: detected.iosAvailable === true,
        reason: detected.iosAvailable === true
          ? undefined
          : 'iOS Simulator は macOS + Xcode でのみ使えます。',
      },
      socCount: detected.socCount,
      deviceProfileCount: detected.deviceProfileCount,
    }
  }

  async function samplePayload(body) {
    const { socCatalog, socModel } = await loadLibs()
    const soc = suppliedSoc(body)
      ?? socCatalog.getSoc(asText(body.socId) || asText(asObject(body.soc).id))
    if (soc === undefined) throw new Error('soc を解決できません（soc か socId を渡してください）。')

    const suppliedDevice = asObject(body.device)
    const device = Object.keys(suppliedDevice).length > 0
      ? suppliedDevice
      : socCatalog.getDeviceProfile(asText(body.deviceId))
    const workload = workloadFromArgs(asObject(body.workload))
    const estimate = asObject(
      socModel.estimateFps(soc, workload, device === undefined ? {} : { device }),
    )
    const fps = asFiniteNumber(estimate.fps)
    return {
      ok: fps !== undefined,
      simulatedFps: fps === undefined ? UNAVAILABLE : fps,
      targetFps: asFiniteNumber(estimate.targetFps) ?? workload.targetFps,
      bottleneck: asText(estimate.bottleneck) || 'none',
      capped: estimate.capped === true,
      // 温度はこの経路では推定しない（パネルは自分の熱モデルを表示し続ける）。
      thermalC: null,
      throttled: false,
      warnings: Array.isArray(estimate.warnings) ? estimate.warnings.map((entry) => String(entry)) : [],
    }
  }

  async function apiHandler(req, res) {
    if (!isSameOrigin(req)) {
      sendJson(res, 403, { ok: false, detail: 'cross-origin requests are not allowed' })
      return
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, detail: 'POST only' })
      return
    }

    const pathname = String(req.url ?? '').split('?')[0]
    const action = pathname.split('/').filter((part) => part.length > 0).pop() ?? ''

    let body
    try {
      body = await readJsonBody(req)
    } catch (error) {
      sendJson(res, 400, { ok: false, detail: error instanceof Error ? error.message : String(error) })
      return
    }

    try {
      if (action === 'probe') {
        sendJson(res, 200, await probePayload())
        return
      }
      if (action === 'sample') {
        sendJson(res, 200, await samplePayload(body))
        return
      }
      if (action === 'start') {
        const platform = requirePlatform(body.platform)
        const deviceProfileId = asText(body.deviceId)
          || asText(asObject(body.device).id)
          || asText(body.deviceProfileId)
        if (deviceProfileId.length === 0) throw new Error('deviceId を指定してください。')
        const launchArgs = { platform, deviceProfileId }
        const socId = asText(body.socId) || asText(asObject(body.soc).id)
        if (socId.length > 0) launchArgs.socId = socId
        if (body.headless === true) launchArgs.headless = true

        const result = await definitions.get('emulator_launch').execute(launchArgs, {})
        if (result.ok === true) {
          launches.set(platform, { kind: platform, serial: result.serial || undefined, at: Date.now() })
        }
        sendJson(res, 200, {
          ok: result.ok === true,
          detail: result.message,
          serial: result.serial,
          constraints: result.constraints,
          warnings: result.warnings,
        })
        return
      }
      if (action === 'stop') {
        const platform = requirePlatform(body.platform)
        const handle = launches.get(platform)
        if (handle === undefined) {
          sendJson(res, 200, {
            ok: true,
            detail: 'このプラグインからは起動していないため、何もしませんでした。',
          })
          return
        }
        const { emulator } = await loadLibs()
        const result = asObject(await emulator.shutdown(handle))
        launches.delete(platform)
        sendJson(res, 200, {
          ok: result.ok === true,
          detail: result.ok === true
            ? '停止しました。'
            : `停止コマンドが失敗しました（code ${String(result.code ?? '?')}）。`,
        })
        return
      }
      sendJson(res, 404, { ok: false, detail: `unknown action: ${action}` })
    } catch (error) {
      sendJson(res, 400, { ok: false, detail: error instanceof Error ? error.message : String(error) })
    }
  }

  let unregisterApi
  try {
    const webServer = ctx.get('webServer')
    if (webServer !== undefined && typeof webServer.register === 'function') {
      unregisterApi = webServer.register({ kind: 'prefix', path: API_PREFIX, handler: apiHandler })
    }
  } catch (error) {
    log(`could not mount ${API_PREFIX}: ${String(error)}`)
  }

  ctx.effect(() => () => {
    launches.clear()
    try {
      unregisterApi?.()
    } catch {
      // 解放失敗は無視してよい（プラグイン停止処理を妨げない）。
    }
  })

  /* ------------------------------------------------------------------- */
  /* モデル向けの静的セクション                                             */
  /* ------------------------------------------------------------------- */

  const systemPrompt = ctx.get('systemPrompt')
  systemPrompt?.section({ name: SECTION_NAME, order: SECTION_ORDER, text: PROMPT_SECTION })
}

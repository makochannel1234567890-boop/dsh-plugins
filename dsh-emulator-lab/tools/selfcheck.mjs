#!/usr/bin/env node
/**
 * dsh-emulator-lab — DSH 非依存のスモークテスト。
 *
 * DSH が無い素の Node でも、プラグインの中核（lib/*.js と index.js の Host 契約）
 * が契約どおり動くかを 1 コマンドで確かめる。
 *
 *   node tools/selfcheck.mjs
 *
 * - 成功: 結果を JSON で stdout に出して exit 0
 * - 失敗: JSON + 人が読める 1 行を stderr に出して exit 1
 *
 * 検証するもの:
 *   1. lib/soc-catalog.js・lib/soc-model.js・lib/emulator.js が import できること
 *   2. 3 モジュールの公開 API が契約どおり存在すること
 *   3. カタログ件数と、DEVICE_PROFILES.socId がすべて実在すること
 *   4. estimateFps() が 1 件ぶん妥当な数値を返し、同じ入力で同じ結果になること（決定的）
 *   5. detectEmulators() が例外を投げず、{ android, ios } の available:boolean を返すこと
 *   6. index.js が Host プラグイン契約（name / inject / apply）を満たすこと
 */

const STARTED_AT = Date.now()

/** lib の公開 API 契約。ここに足すときは README の契約表も更新する。 */
const LIBRARIES = [
  {
    key: 'catalog',
    file: '../lib/soc-catalog.js',
    arrays: ['SOC_CATALOG', 'DEVICE_PROFILES'],
    objects: [],
    functions: ['getSoc', 'getDeviceProfile', 'listSocs'],
  },
  {
    key: 'model',
    file: '../lib/soc-model.js',
    arrays: [],
    objects: ['DEFAULT_WEIGHTS'],
    functions: ['estimateFps', 'createRuntimeState'],
  },
  {
    key: 'emulator',
    file: '../lib/emulator.js',
    arrays: [],
    objects: [],
    functions: [
      'detectEmulators',
      'launch',
      'sampleFps',
      'shutdown',
      'buildBootArgs',
      'buildAvdArgs',
      'clampConstraints',
    ],
  },
]

/** スモーク用のワークロード（lib のテストと同じ「軽めの 3D」）。 */
const WORKLOAD = Object.freeze({
  id: 'selfcheck',
  name: 'Selfcheck workload',
  mtRequirement: 1.5,
  cpuWeight: 0.8,
  gpuWeight: 0.8,
  vramMb: 384,
  threads: 4,
  targetFps: 60,
})

function failure(error, extra = {}) {
  return { ok: false, error, ...extra }
}

function reasonOf(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

function checkShape(moduleKey, mod, descriptor) {
  const missing = []
  for (const name of descriptor.arrays) {
    if (!Array.isArray(mod[name])) missing.push(`${moduleKey}.${name}（配列）`)
  }
  for (const name of descriptor.objects) {
    const value = mod[name]
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      missing.push(`${moduleKey}.${name}（オブジェクト）`)
    }
  }
  for (const name of descriptor.functions) {
    if (typeof mod[name] !== 'function') missing.push(`${moduleKey}.${name}（関数）`)
  }
  return missing
}

async function loadLibraries() {
  const loaded = {}
  for (const descriptor of LIBRARIES) {
    try {
      loaded[descriptor.key] = await import(new URL(descriptor.file, import.meta.url).href)
    } catch (error) {
      return failure(
        `${descriptor.file} を読み込めません（未実装・不在・構文エラーのいずれか）: ${reasonOf(error)}`,
        { missing: [descriptor.file], notes: ['lib/ と index.js が揃っているか確認してください。'] },
      )
    }
  }

  const missing = []
  for (const descriptor of LIBRARIES) {
    missing.push(...checkShape(descriptor.key, loaded[descriptor.key], descriptor))
  }
  if (missing.length > 0) {
    return failure('lib の公開 API が契約と一致しません（未実装）', {
      missing,
      notes: missing.map((entry) => `未実装: ${entry}`),
    })
  }

  return { ok: true, libraries: loaded }
}

function checkCatalog(catalog) {
  const socs = catalog.SOC_CATALOG
  const profiles = catalog.DEVICE_PROFILES

  const ids = new Set()
  const duplicateSocs = []
  for (const soc of socs) {
    const id = typeof soc?.id === 'string' ? soc.id : ''
    if (id.length === 0) {
      duplicateSocs.push('<id が無い SoC>')
    } else if (ids.has(id)) {
      duplicateSocs.push(id)
    } else {
      ids.add(id)
    }
  }

  const profileIds = new Set()
  const duplicateProfiles = []
  const danglingSocRefs = []
  for (const profile of profiles) {
    const id = typeof profile?.id === 'string' ? profile.id : ''
    if (id.length === 0) {
      duplicateProfiles.push('<id が無い端末プロファイル>')
    } else if (profileIds.has(id)) {
      duplicateProfiles.push(id)
    } else {
      profileIds.add(id)
    }
    if (catalog.getSoc(profile?.socId) === undefined) {
      danglingSocRefs.push(`${id || '?'} -> ${String(profile?.socId)}`)
    }
  }

  const androidSocs = socs.filter((soc) => soc?.platform === 'android').length
  const iosSocs = socs.filter((soc) => soc?.platform === 'ios').length
  const listAgrees = catalog.listSocs('android').length === androidSocs
    && catalog.listSocs('ios').length === iosSocs
    && catalog.listSocs().length === socs.length

  const summary = {
    socCount: socs.length,
    androidSocs,
    iosSocs,
    deviceProfileCount: profiles.length,
    androidProfiles: profiles.filter((profile) => profile?.platform === 'android').length,
    iosProfiles: profiles.filter((profile) => profile?.platform === 'ios').length,
    listSocsAgrees: listAgrees,
    danglingSocRefs,
    duplicateSocIds: duplicateSocs,
    duplicateProfileIds: duplicateProfiles,
  }

  if (socs.length === 0 || profiles.length === 0) {
    return failure('カタログが空です（SOC_CATALOG / DEVICE_PROFILES に 1 件以上必要）', { catalog: summary })
  }
  if (danglingSocRefs.length > 0) {
    return failure('DEVICE_PROFILES の socId が SOC_CATALOG に存在しません', {
      catalog: summary,
      notes: danglingSocRefs.map((entry) => `不整合: ${entry}`),
    })
  }
  if (duplicateSocs.length > 0 || duplicateProfiles.length > 0) {
    return failure('カタログの id が重複しています', { catalog: summary })
  }
  if (!listAgrees) {
    return failure('listSocs() の件数がカタログと一致しません', { catalog: summary })
  }

  return { ok: true, catalog: summary }
}

function checkEstimate(model, catalog) {
  const soc = catalog.getSoc('unisoc-t606')
    ?? catalog.listSocs('android')[0]
    ?? catalog.SOC_CATALOG[0]

  let first
  let second
  try {
    first = model.estimateFps(soc, WORKLOAD)
    second = model.estimateFps(soc, WORKLOAD)
  } catch (error) {
    return failure(`estimateFps() が例外を投げました: ${reasonOf(error)}`, {
      estimate: { socId: String(soc?.id ?? '') },
    })
  }

  const estimate = {
    socId: String(soc?.id ?? ''),
    socName: `${String(soc?.vendor ?? '')} ${String(soc?.name ?? '')}`.trim(),
    fps: Number(first?.fps),
    targetFps: Number(first?.targetFps),
    bottleneck: String(first?.bottleneck ?? ''),
    capped: first?.capped === true,
    subscores: {
      cpu: Number(first?.subscores?.cpu),
      gpu: Number(first?.subscores?.gpu),
      mem: Number(first?.subscores?.mem),
      thermal: Number(first?.subscores?.thermal),
    },
    warnings: Array.isArray(first?.warnings) ? first.warnings.map((entry) => String(entry)) : [],
    deterministic: JSON.stringify(first) === JSON.stringify(second),
    workload: { ...WORKLOAD },
  }

  if (!Number.isFinite(estimate.fps) || estimate.fps <= 0) {
    return failure('estimateFps() が正の FPS を返しませんでした', { estimate })
  }
  if (!Number.isFinite(estimate.targetFps) || estimate.targetFps <= 0) {
    return failure('estimateFps() が targetFps を返しませんでした', { estimate })
  }
  if (estimate.fps > estimate.targetFps) {
    return failure('estimateFps() の fps が targetFps を超えています（クランプ契約違反）', { estimate })
  }
  if (!estimate.deterministic) {
    return failure('estimateFps() が同じ入力で同じ結果を返しません（決定的であること）', { estimate })
  }

  return { ok: true, estimate }
}

async function checkDetection(emulator) {
  let detected
  try {
    detected = await emulator.detectEmulators({ timeoutMs: 3000 })
  } catch (error) {
    return failure(`detectEmulators() が例外を投げました: ${reasonOf(error)}`, { emulators: {} })
  }

  const android = detected?.android
  const ios = detected?.ios
  const emulators = {
    android: {
      available: android?.available === true,
      avdCount: Array.isArray(android?.avds) ? android.avds.length : 0,
      emulatorPath: typeof android?.emulatorPath === 'string' ? android.emulatorPath : '',
    },
    ios: {
      available: ios?.available === true,
      deviceCount: Array.isArray(ios?.devices) ? ios.devices.length : 0,
      xcrunPath: typeof ios?.xcrunPath === 'string' ? ios.xcrunPath : '',
    },
    platform: process.platform,
    node: process.version,
  }

  if (typeof android?.available !== 'boolean' || typeof ios?.available !== 'boolean') {
    return failure('detectEmulators() が { android, ios } の available:boolean を返していません', { emulators })
  }

  return { ok: true, emulators }
}

async function checkPlugin() {
  let plugin
  try {
    plugin = await import(new URL('../index.js', import.meta.url).href)
  } catch (error) {
    return failure(`index.js を読み込めません: ${reasonOf(error)}`, { missing: ['index.js'] })
  }

  const problems = []
  if (plugin.name !== 'emulator-lab') problems.push(`export const name = ${JSON.stringify(plugin.name)}`)
  if (!Array.isArray(plugin.inject)) {
    problems.push('export const inject（配列）')
  } else if (!plugin.inject.includes('tools')) {
    problems.push('inject に "tools" が含まれていません')
  }
  if (typeof plugin.apply !== 'function') problems.push('export function apply(ctx, config)')

  const summary = {
    name: typeof plugin.name === 'string' ? plugin.name : '',
    inject: Array.isArray(plugin.inject) ? plugin.inject.map((entry) => String(entry)) : [],
    hasApply: typeof plugin.apply === 'function',
  }

  if (problems.length > 0) {
    return failure('index.js が Host プラグイン契約を満たしていません（未実装）', {
      plugin: summary,
      missing: problems,
      notes: problems.map((entry) => `未実装: ${entry}`),
    })
  }

  return { ok: true, plugin: summary }
}

async function main() {
  const loaded = await loadLibraries()
  if (loaded.ok !== true) return loaded

  const { catalog, model, emulator } = loaded.libraries

  const catalogCheck = checkCatalog(catalog)
  if (catalogCheck.ok !== true) return catalogCheck

  const estimateCheck = checkEstimate(model, catalog)
  if (estimateCheck.ok !== true) return estimateCheck

  const detectionCheck = await checkDetection(emulator)
  if (detectionCheck.ok !== true) return detectionCheck

  const pluginCheck = await checkPlugin()
  if (pluginCheck.ok !== true) return pluginCheck

  return {
    ok: true,
    plugin: pluginCheck.plugin,
    catalog: catalogCheck.catalog,
    estimate: estimateCheck.estimate,
    emulators: detectionCheck.emulators,
    elapsedMs: Date.now() - STARTED_AT,
  }
}

const payload = await main()
process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)

if (payload.ok !== true) {
  process.exitCode = 1
  process.stderr.write(`dsh-emulator-lab selfcheck FAILED: ${payload.error}\n`)
  for (const note of payload.notes ?? []) process.stderr.write(`  - ${note}\n`)
  if (Array.isArray(payload.missing) && payload.missing.length > 0 && !payload.notes) {
    for (const entry of payload.missing) process.stderr.write(`  - ${entry}\n`)
  }
} else {
  process.stdout.write(
    `dsh-emulator-lab selfcheck OK: SoC ${payload.catalog.socCount} 件 / `
    + `端末 ${payload.catalog.deviceProfileCount} 件 / 推定 ${payload.estimate.fps} fps `
    + `(${payload.estimate.socId})\n`,
  )
}

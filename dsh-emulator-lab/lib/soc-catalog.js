/**
 * dsh-emulator-lab — SoC / デバイスカタログ
 *
 * DSH（DeepSeek Harness）に依存しない純 ESM モジュール。
 * ブラウザ API・Node API・乱数・現在時刻を一切使わない。
 *
 * 数値の扱い:
 *   - tops            : INT8 の NPU/GPU 合算ピーク性能（メーカー公称値ベースの概算 TOPS）
 *   - cpuScore/gpuScore: 相対ベンチマーク指数（同一スケール、おおよそ 0〜100 の体感値）
 *   - memBandwidthGBs : メモリ帯域の概算（LPDDR4X/LPDDR5 の理論値ベース）
 *   - memoryLimitGB   : その SoC を積む端末の標準的な物理 RAM 容量
 *   - recommendedHeapMb: アプリが安全に確保できるヒープ/VRAM の目安
 *   - thermalBudgetW  : 連続負荷で放熱し続けられるパッケージ電力の概算
 *   - releaseYear     : 発表年
 *   - tier            : 価格帯の目安（low < mid < high）
 *
 * これらは実測値ではなく「ローエンド端末の性能差を再現するための概算」である。
 * 数値を変える場合は test/soc-model.test.mjs の相対比較が壊れないよう注意すること。
 */

export const SOC_CATALOG = [
  // ---------------------------------------------------------------------------
  // ローエンド Android（2019〜2023 のエントリー〜低価格帯）
  // ---------------------------------------------------------------------------
  {
    id: 'unisoc-t606',
    vendor: 'Unisoc',
    name: 'T606',
    platform: 'android',
    tops: 0.4, // 専用 NPU を持たない世代。INT8 は CPU/DSP 相当のごく小さな値
    cpuScore: 18, // Cortex-A75 x2 + A55 x6 相当の指数
    gpuScore: 10, // Mali-G57 MP1
    memBandwidthGBs: 12.8, // LPDDR4X 2ch 概算
    memoryLimitGB: 3,
    recommendedHeapMb: 256,
    thermalBudgetW: 2.5, // 12nm クラスで放熱余力は小さい
    releaseYear: 2021,
    tier: 'low',
  },
  {
    id: 'exynos-850',
    vendor: 'Samsung',
    name: 'Exynos 850',
    platform: 'android',
    tops: 0.5,
    cpuScore: 20, // Cortex-A55 x8 のみ（big core なし）
    gpuScore: 9, // Mali-G52 MP1
    memBandwidthGBs: 14.9, // LPDDR4X 概算
    memoryLimitGB: 3,
    recommendedHeapMb: 256,
    thermalBudgetW: 2.6,
    releaseYear: 2020,
    tier: 'low',
  },
  {
    id: 'helio-g85',
    vendor: 'MediaTek',
    name: 'Helio G85',
    platform: 'android',
    tops: 0.6, // APU なし。ゲーム向けだが AI 専用回路は非搭載
    cpuScore: 22, // Cortex-A75 x2 + A55 x6
    gpuScore: 13, // Mali-G52 MC2
    memBandwidthGBs: 13.4,
    memoryLimitGB: 4,
    recommendedHeapMb: 320,
    thermalBudgetW: 3.0,
    releaseYear: 2020,
    tier: 'low',
  },
  {
    id: 'snapdragon-680',
    vendor: 'Qualcomm',
    name: 'Snapdragon 680',
    platform: 'android',
    tops: 1.2, // Hexagon 686 の小規模な INT8 パス
    cpuScore: 26, // Kryo 265 (A73 x4 + A53 x4)
    gpuScore: 14, // Adreno 610
    memBandwidthGBs: 17.1, // LPDDR4X 2ch
    memoryLimitGB: 4,
    recommendedHeapMb: 384,
    thermalBudgetW: 3.2,
    releaseYear: 2021,
    tier: 'low',
  },
  {
    id: 'helio-g99',
    vendor: 'MediaTek',
    name: 'Helio G99',
    platform: 'android',
    tops: 1.0,
    cpuScore: 33, // Cortex-A76 x2 + A55 x6
    gpuScore: 20, // Mali-G57 MC2
    memBandwidthGBs: 17.1,
    memoryLimitGB: 6,
    recommendedHeapMb: 448,
    thermalBudgetW: 3.4,
    releaseYear: 2022,
    tier: 'low',
  },
  {
    id: 'snapdragon-4-gen-2',
    vendor: 'Qualcomm',
    name: 'Snapdragon 4 Gen 2',
    platform: 'android',
    tops: 2.0, // Hexagon 世代の INT8 推論（エントリー向け）
    cpuScore: 30, // Kryo (A78 x2 + A55 x6)
    gpuScore: 17, // Adreno 613
    memBandwidthGBs: 17.1,
    memoryLimitGB: 4,
    recommendedHeapMb: 384,
    thermalBudgetW: 3.4,
    releaseYear: 2023,
    tier: 'low',
  },
  {
    id: 'dimensity-6100-plus',
    vendor: 'MediaTek',
    name: 'Dimensity 6100+',
    platform: 'android',
    tops: 1.8,
    cpuScore: 31, // Cortex-A76 x2 + A55 x6
    gpuScore: 19, // Mali-G57 MC2
    memBandwidthGBs: 17.1,
    memoryLimitGB: 6,
    recommendedHeapMb: 448,
    thermalBudgetW: 3.5,
    releaseYear: 2023,
    tier: 'low',
  },

  // ---------------------------------------------------------------------------
  // ミドル Android
  // ---------------------------------------------------------------------------
  {
    id: 'snapdragon-695',
    vendor: 'Qualcomm',
    name: 'Snapdragon 695',
    platform: 'android',
    tops: 1.5,
    cpuScore: 36, // Kryo 660 (A78 x2 + A55 x6)
    gpuScore: 22, // Adreno 619
    memBandwidthGBs: 17.1,
    memoryLimitGB: 6,
    recommendedHeapMb: 512,
    thermalBudgetW: 3.6,
    releaseYear: 2021,
    tier: 'mid',
  },
  {
    id: 'dimensity-7050',
    vendor: 'MediaTek',
    name: 'Dimensity 7050',
    platform: 'android',
    tops: 2.6,
    cpuScore: 44, // Cortex-A78 x2 + A55 x6
    gpuScore: 30, // Mali-G68 MC4
    memBandwidthGBs: 25.6, // LPDDR5
    memoryLimitGB: 8,
    recommendedHeapMb: 512,
    thermalBudgetW: 4.2,
    releaseYear: 2023,
    tier: 'mid',
  },
  {
    id: 'snapdragon-7s-gen-2',
    vendor: 'Qualcomm',
    name: 'Snapdragon 7s Gen 2',
    platform: 'android',
    tops: 4.0,
    cpuScore: 48,
    gpuScore: 34, // Adreno 710
    memBandwidthGBs: 25.6,
    memoryLimitGB: 8,
    recommendedHeapMb: 512,
    thermalBudgetW: 4.4,
    releaseYear: 2023,
    tier: 'mid',
  },
  {
    id: 'snapdragon-778g',
    vendor: 'Qualcomm',
    name: 'Snapdragon 778G',
    platform: 'android',
    tops: 5.0,
    cpuScore: 52,
    gpuScore: 40, // Adreno 642L
    memBandwidthGBs: 25.6,
    memoryLimitGB: 8,
    recommendedHeapMb: 512,
    thermalBudgetW: 4.6,
    releaseYear: 2021,
    tier: 'mid',
  },

  // ---------------------------------------------------------------------------
  // iOS（Apple A シリーズ）
  // ---------------------------------------------------------------------------
  {
    id: 'apple-a12',
    vendor: 'Apple',
    name: 'A12 Bionic',
    platform: 'ios',
    tops: 5.0, // Neural Engine 8-core、公称 5 TOPS
    cpuScore: 58, // Vortex x2 + Tempest x4
    gpuScore: 46, // 4-core Apple GPU
    memBandwidthGBs: 34.1, // iPhone XR は LPDDR4X 3GB
    memoryLimitGB: 3,
    recommendedHeapMb: 1024,
    thermalBudgetW: 4.0,
    releaseYear: 2018,
    tier: 'mid',
  },
  {
    id: 'apple-a13',
    vendor: 'Apple',
    name: 'A13 Bionic',
    platform: 'ios',
    tops: 6.0, // Neural Engine 8-core、公称 6 TOPS
    cpuScore: 66,
    gpuScore: 55,
    memBandwidthGBs: 42.7, // iPhone 11 は LPDDR4X 4GB
    memoryLimitGB: 4,
    recommendedHeapMb: 1024,
    thermalBudgetW: 4.2,
    releaseYear: 2019,
    tier: 'mid',
  },
  {
    id: 'apple-a15',
    vendor: 'Apple',
    name: 'A15 Bionic',
    platform: 'ios',
    tops: 15.8, // Neural Engine 16-core、公称 15.8 TOPS
    cpuScore: 88,
    gpuScore: 82, // 5-core GPU（13 Pro は 5-core）
    memBandwidthGBs: 51.2, // LPDDR4X 6GB
    memoryLimitGB: 6,
    recommendedHeapMb: 1536,
    thermalBudgetW: 5.0,
    releaseYear: 2021,
    tier: 'high',
  },
];

/**
 * デバイス（エミュレーターの画面・OS 設定）プリセット。
 * socId は必ず SOC_CATALOG の id を指す。
 */
export const DEVICE_PROFILES = [
  {
    id: 'android-720p-t606',
    label: 'Android 低予算 720p/60Hz',
    platform: 'android',
    socId: 'unisoc-t606',
    resolution: { w: 720, h: 1600 },
    refreshHz: 60,
    osVersion: 'Android 13',
    defaultHeapMb: 256,
  },
  {
    id: 'android-hd-plus-g85',
    label: 'Android エントリー HD+/60Hz',
    platform: 'android',
    socId: 'helio-g85',
    resolution: { w: 720, h: 1600 },
    refreshHz: 60,
    osVersion: 'Android 12',
    defaultHeapMb: 320,
  },
  {
    id: 'android-fhd-sd680',
    label: 'Android 低価格 FHD+/60Hz',
    platform: 'android',
    socId: 'snapdragon-680',
    resolution: { w: 1080, h: 2400 },
    refreshHz: 60,
    osVersion: 'Android 13',
    defaultHeapMb: 384,
  },
  {
    id: 'android-fhd-4gen2',
    label: 'Android ローエンド FHD+/60Hz',
    platform: 'android',
    socId: 'snapdragon-4-gen-2',
    resolution: { w: 1080, h: 2400 },
    refreshHz: 60,
    osVersion: 'Android 14',
    defaultHeapMb: 384,
  },
  {
    id: 'android-fhd-g99',
    label: 'Android ローエンド FHD+/90Hz',
    platform: 'android',
    socId: 'helio-g99',
    resolution: { w: 1080, h: 2400 },
    refreshHz: 90,
    osVersion: 'Android 13',
    defaultHeapMb: 448,
  },
  {
    id: 'android-fhd-dim6100',
    label: 'Android ローエンド FHD+/90Hz (Dimensity)',
    platform: 'android',
    socId: 'dimensity-6100-plus',
    resolution: { w: 1080, h: 2400 },
    refreshHz: 90,
    osVersion: 'Android 14',
    defaultHeapMb: 448,
  },
  {
    id: 'android-fhd-sd695',
    label: 'Android ミドル FHD+/120Hz',
    platform: 'android',
    socId: 'snapdragon-695',
    resolution: { w: 1080, h: 2400 },
    refreshHz: 120,
    osVersion: 'Android 13',
    defaultHeapMb: 512,
  },
  {
    id: 'android-fhd-dim7050',
    label: 'Android ミドル FHD+/120Hz (Dimensity)',
    platform: 'android',
    socId: 'dimensity-7050',
    resolution: { w: 1080, h: 2400 },
    refreshHz: 120,
    osVersion: 'Android 14',
    defaultHeapMb: 512,
  },
  {
    id: 'android-fhd-778g',
    label: 'Android ミドル上位 FHD+/120Hz',
    platform: 'android',
    socId: 'snapdragon-778g',
    resolution: { w: 1080, h: 2400 },
    refreshHz: 120,
    osVersion: 'Android 13',
    defaultHeapMb: 512,
  },
  {
    id: 'ios-iphone-xr-a12',
    label: 'iPhone XR (A12)',
    platform: 'ios',
    socId: 'apple-a12',
    resolution: { w: 828, h: 1792 },
    refreshHz: 60,
    osVersion: 'iOS 17',
    defaultHeapMb: 1024,
  },
  {
    id: 'ios-iphone-11-a13',
    label: 'iPhone 11 (A13)',
    platform: 'ios',
    socId: 'apple-a13',
    resolution: { w: 828, h: 1792 },
    refreshHz: 60,
    osVersion: 'iOS 17',
    defaultHeapMb: 1024,
  },
  {
    id: 'ios-iphone-13-a15',
    label: 'iPhone 13 (A15)',
    platform: 'ios',
    socId: 'apple-a15',
    resolution: { w: 1170, h: 2532 },
    refreshHz: 60,
    osVersion: 'iOS 17',
    defaultHeapMb: 1536,
  },
  {
    id: 'ios-iphone-13-pro-a15',
    label: 'iPhone 13 Pro (A15/120Hz)',
    platform: 'ios',
    socId: 'apple-a15',
    resolution: { w: 1170, h: 2532 },
    refreshHz: 120,
    osVersion: 'iOS 17',
    defaultHeapMb: 1536,
  },
];

/**
 * SoC を id で引く。
 * @param {unknown} id
 * @returns {(typeof SOC_CATALOG)[number] | undefined}
 */
export function getSoc(id) {
  if (typeof id !== 'string' || id.length === 0) return undefined;
  return SOC_CATALOG.find((soc) => soc.id === id);
}

/**
 * SoC 一覧を返す。platform 省略時は全件。
 * 呼び出し側が sort/push してもカタログを壊さないよう、常に新しい配列を返す。
 * @param {'android'|'ios'|string} [platform]
 * @returns {(typeof SOC_CATALOG)[number][]}
 */
export function listSocs(platform) {
  if (platform === undefined || platform === null) return SOC_CATALOG.slice();
  return SOC_CATALOG.filter((soc) => soc.platform === platform);
}

/**
 * デバイスプロファイルを id で引く。
 * @param {unknown} id
 * @returns {(typeof DEVICE_PROFILES)[number] | undefined}
 */
export function getDeviceProfile(id) {
  if (typeof id !== 'string' || id.length === 0) return undefined;
  return DEVICE_PROFILES.find((device) => device.id === id);
}

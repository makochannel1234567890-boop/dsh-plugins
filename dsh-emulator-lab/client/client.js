/**
 * dsh-emulator-lab — client half（DSH Web GUI の右サイドバー「エミュレーター」タブ）
 *
 * 画面側でやること:
 *   Android / iOS をタブで切り替え、SoC と端末プロファイルを選び、TOPS・メモリ上限・
 *   メモリ帯域・TDP・ワークロード強度を動かしながら、決定的な FPS 推定とボトルネック、
 *   熱スロットリング警告を表示する。起動 / 停止はホスト半の HTTP エンドポイントに投げ、
 *   エンドポイントが無い環境ではローカル推定だけで動く（UI は死なない）。
 *
 * ■ 右サイドバーのスロット（実コードで確認した登録経路）
 *   DSH 0.2 系に `sidebarRight` という *スロット* は無い。右サイドバーのタブは
 *   2 段登録で足す（既存の `dsh-plugin-wallpaper-engine` が同じ経路で動いている）:
 *     ① `ctx.slots.inject('sidebar.right.pane.tab', cb)`  … 右サイドバー座位の能力ゲート
 *     ② `ctx.sidebarRightTabs.register({ id, kind, keepMounted, title, guide })` … タブ種別
 *     ③ `ctx.slots.register({ name: 'sidebar.right.pane.tab', key: id }, Component)` … タブ本体
 *   ①②のサービスは**任意サービス**なので `ctx.get()` を短くポーリングして取る
 *   （inject に書くと古いホストでプラグインごと park される）。
 *
 * ■ ホスト半の HTTP 契約（未実装ならローカル推定に落ちる）
 *   ベース URL は既定 `/dsh-emulator-lab/api`（同一オリジン）。上書きは
 *   `window.__DSH_EMULATOR_LAB_ENDPOINT__` か、パネル内の「接続」欄（localStorage 保存）。
 *     POST {base}/probe  {} → { ok, android:{available,reason?}, ios:{available,reason?} }
 *     POST {base}/start  { platform, socId, deviceId, soc, device, workload }
 *                        → { ok, detail? }
 *     POST {base}/stop   { platform } → { ok, detail? }
 *     POST {base}/sample { platform, soc, device, workload, running } → {
 *       simulatedFps:number, measuredFps?:number|null, measuredMethod?:string,
 *       bottleneck?:'gpu'|'cpu'|'memory'|'thermal'|'none',
 *       thermalC?:number|null, throttled?:boolean, warnings?:string[] }
 *   `/sample` の返り値はローカル推定の結果と同じ形なので、ホストが未接続でも表示は壊れない。
 *
 * ■ なぜ 1 ファイルか
 *   このプロファイルはバンドラ無しで `client.js` をそのまま読む（`window.__ModuleLoader__`）。
 *   factory の `require` はブラウザのモジュール表（react 等）しか解決できないため、
 *   `panel.js` に分けても実行時 require できない。よって UI は本ファイルに同居させる。
 *
 * ■ 数値モデル
 *   `lib/soc-model.js` と同じ係数・同じ丸めを写している（カタログも `lib/soc-catalog.js` と同値）。
 *   クライアントは lib/ を import できないため同梱している。片方を変えたらもう片方も直すこと。
 */

window.__ModuleLoader__.load({
  id: 'dsh-emulator-lab',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;

    /* ====================================================================== */
    /* 定数                                                                    */
    /* ====================================================================== */

    const TAB_ID = 'dsh-emulator-lab/emulator';
    const TAB_KIND = 'emulator-lab';
    const TAB_TITLE = 'エミュレーター';
    const DEFAULT_ENDPOINT = '/dsh-emulator-lab/api';
    const STORAGE_KEY = 'dsh-emulator-lab:panel';
    const POLL_MS = 500;
    const FPS_MAX = 120;
    const SERVICE_POLL_MS = 250;
    const SERVICE_POLL_TRIES = 40;

    /* ====================================================================== */
    /* カタログ（lib/soc-catalog.js と同値）                                    */
    /* ====================================================================== */

    const SOCS = [
      { id: 'unisoc-t606', vendor: 'Unisoc', name: 'T606', platform: 'android', tops: 0.4, cpuScore: 18, gpuScore: 10, memBandwidthGBs: 12.8, memoryLimitGB: 3, recommendedHeapMb: 256, thermalBudgetW: 2.5, tier: 'low' },
      { id: 'exynos-850', vendor: 'Samsung', name: 'Exynos 850', platform: 'android', tops: 0.5, cpuScore: 20, gpuScore: 9, memBandwidthGBs: 14.9, memoryLimitGB: 3, recommendedHeapMb: 256, thermalBudgetW: 2.6, tier: 'low' },
      { id: 'helio-g85', vendor: 'MediaTek', name: 'Helio G85', platform: 'android', tops: 0.6, cpuScore: 22, gpuScore: 13, memBandwidthGBs: 13.4, memoryLimitGB: 4, recommendedHeapMb: 320, thermalBudgetW: 3.0, tier: 'low' },
      { id: 'snapdragon-680', vendor: 'Qualcomm', name: 'Snapdragon 680', platform: 'android', tops: 1.2, cpuScore: 26, gpuScore: 14, memBandwidthGBs: 17.1, memoryLimitGB: 4, recommendedHeapMb: 384, thermalBudgetW: 3.2, tier: 'low' },
      { id: 'helio-g99', vendor: 'MediaTek', name: 'Helio G99', platform: 'android', tops: 1.0, cpuScore: 33, gpuScore: 20, memBandwidthGBs: 17.1, memoryLimitGB: 6, recommendedHeapMb: 448, thermalBudgetW: 3.4, tier: 'low' },
      { id: 'snapdragon-4-gen-2', vendor: 'Qualcomm', name: 'Snapdragon 4 Gen 2', platform: 'android', tops: 2.0, cpuScore: 30, gpuScore: 17, memBandwidthGBs: 17.1, memoryLimitGB: 4, recommendedHeapMb: 384, thermalBudgetW: 3.4, tier: 'low' },
      { id: 'dimensity-6100-plus', vendor: 'MediaTek', name: 'Dimensity 6100+', platform: 'android', tops: 1.8, cpuScore: 31, gpuScore: 19, memBandwidthGBs: 17.1, memoryLimitGB: 6, recommendedHeapMb: 448, thermalBudgetW: 3.5, tier: 'low' },
      { id: 'snapdragon-695', vendor: 'Qualcomm', name: 'Snapdragon 695', platform: 'android', tops: 1.5, cpuScore: 36, gpuScore: 22, memBandwidthGBs: 17.1, memoryLimitGB: 6, recommendedHeapMb: 512, thermalBudgetW: 3.6, tier: 'mid' },
      { id: 'dimensity-7050', vendor: 'MediaTek', name: 'Dimensity 7050', platform: 'android', tops: 2.6, cpuScore: 44, gpuScore: 30, memBandwidthGBs: 25.6, memoryLimitGB: 8, recommendedHeapMb: 512, thermalBudgetW: 4.2, tier: 'mid' },
      { id: 'snapdragon-7s-gen-2', vendor: 'Qualcomm', name: 'Snapdragon 7s Gen 2', platform: 'android', tops: 4.0, cpuScore: 48, gpuScore: 34, memBandwidthGBs: 25.6, memoryLimitGB: 8, recommendedHeapMb: 512, thermalBudgetW: 4.4, tier: 'mid' },
      { id: 'snapdragon-778g', vendor: 'Qualcomm', name: 'Snapdragon 778G', platform: 'android', tops: 5.0, cpuScore: 52, gpuScore: 40, memBandwidthGBs: 25.6, memoryLimitGB: 8, recommendedHeapMb: 512, thermalBudgetW: 4.6, tier: 'mid' },
      { id: 'apple-a12', vendor: 'Apple', name: 'A12 Bionic', platform: 'ios', tops: 5.0, cpuScore: 58, gpuScore: 46, memBandwidthGBs: 34.1, memoryLimitGB: 3, recommendedHeapMb: 1024, thermalBudgetW: 4.0, tier: 'mid' },
      { id: 'apple-a13', vendor: 'Apple', name: 'A13 Bionic', platform: 'ios', tops: 6.0, cpuScore: 66, gpuScore: 55, memBandwidthGBs: 42.7, memoryLimitGB: 4, recommendedHeapMb: 1024, thermalBudgetW: 4.2, tier: 'mid' },
      { id: 'apple-a15', vendor: 'Apple', name: 'A15 Bionic', platform: 'ios', tops: 15.8, cpuScore: 88, gpuScore: 82, memBandwidthGBs: 51.2, memoryLimitGB: 6, recommendedHeapMb: 1536, thermalBudgetW: 5.0, tier: 'high' },
    ];

    const DEVICES = [
      { id: 'android-720p-t606', label: 'Android 低予算 720p/60Hz', platform: 'android', socId: 'unisoc-t606', refreshHz: 60, defaultHeapMb: 256 },
      { id: 'android-hd-plus-g85', label: 'Android エントリー HD+/60Hz', platform: 'android', socId: 'helio-g85', refreshHz: 60, defaultHeapMb: 320 },
      { id: 'android-fhd-sd680', label: 'Android 低価格 FHD+/60Hz', platform: 'android', socId: 'snapdragon-680', refreshHz: 60, defaultHeapMb: 384 },
      { id: 'android-fhd-4gen2', label: 'Android ローエンド FHD+/60Hz', platform: 'android', socId: 'snapdragon-4-gen-2', refreshHz: 60, defaultHeapMb: 384 },
      { id: 'android-fhd-g99', label: 'Android ローエンド FHD+/90Hz', platform: 'android', socId: 'helio-g99', refreshHz: 90, defaultHeapMb: 448 },
      { id: 'android-fhd-dim6100', label: 'Android ローエンド FHD+/90Hz (Dimensity)', platform: 'android', socId: 'dimensity-6100-plus', refreshHz: 90, defaultHeapMb: 448 },
      { id: 'android-fhd-sd695', label: 'Android ミドル FHD+/120Hz', platform: 'android', socId: 'snapdragon-695', refreshHz: 120, defaultHeapMb: 512 },
      { id: 'android-fhd-dim7050', label: 'Android ミドル FHD+/120Hz (Dimensity)', platform: 'android', socId: 'dimensity-7050', refreshHz: 120, defaultHeapMb: 512 },
      { id: 'android-fhd-778g', label: 'Android ミドル上位 FHD+/120Hz', platform: 'android', socId: 'snapdragon-778g', refreshHz: 120, defaultHeapMb: 512 },
      { id: 'ios-iphone-xr-a12', label: 'iPhone XR (A12)', platform: 'ios', socId: 'apple-a12', refreshHz: 60, defaultHeapMb: 1024 },
      { id: 'ios-iphone-11-a13', label: 'iPhone 11 (A13)', platform: 'ios', socId: 'apple-a13', refreshHz: 60, defaultHeapMb: 1024 },
      { id: 'ios-iphone-13-a15', label: 'iPhone 13 (A15)', platform: 'ios', socId: 'apple-a15', refreshHz: 60, defaultHeapMb: 1536 },
      { id: 'ios-iphone-13-pro-a15', label: 'iPhone 13 Pro (A15/120Hz)', platform: 'ios', socId: 'apple-a15', refreshHz: 120, defaultHeapMb: 1536 },
    ];

    const TIER_META = {
      low: { label: 'ローエンド', color: '#c2410c' },
      mid: { label: 'ミドル', color: '#b45309' },
      high: { label: 'ハイエンド', color: '#15803d' },
    };

    const BOTTLENECK_META = {
      gpu: { label: 'GPU', hint: 'TOPS 不足（描画・推論）' },
      cpu: { label: 'CPU', hint: 'CPU スコア不足' },
      memory: { label: 'メモリ帯域', hint: '帯域 / 容量不足' },
      thermal: { label: '発熱', hint: 'TDP に対して放熱が足りない' },
      none: { label: 'なし', hint: '目標 FPS に到達' },
    };

    function getSoc(id) {
      return SOCS.find((soc) => soc.id === id);
    }

    function getDevice(id) {
      return DEVICES.find((device) => device.id === id);
    }

    function socsOf(platform) {
      return SOCS.filter((soc) => soc.platform === platform);
    }

    function devicesOf(platform) {
      return DEVICES.filter((device) => device.platform === platform);
    }

    /* ====================================================================== */
    /* 性能モデル（lib/soc-model.js の写し）                                    */
    /* ====================================================================== */

    const MODEL = {
      gpuSaturationK: 2.0,
      cpuSaturationK: 2.0,
      memSaturationK: 2.0,
      cpuReferenceScore: 40,
      cpuThreadBaseline: 4,
      cpuThreadPenaltyPerExtra: 0.06,
      referenceCpuDemand: 2.0,
      memBaselineGBs: 1.5,
      memGBsPerVramGB: 7.0,
      memNearLimitRatio: 0.85,
      memCapacityPenalty: 0.5,
      memReferenceVramMb: 2048,
      thermalBaseW: 0.9,
      thermalWPerLoad: 4.6,
      thermalFloor: 0.4,
      thermalSpan: 0.6,
      referenceLoadTops: 8,
      ambientC: 26,
      idleW: 0.8,
      loadW: 5.5,
      conductanceWPerC: 0.22,
      referenceBudgetW: 3,
      heatCapacityJPerC: 9,
      throttleBaseC: 38,
      throttleCPerW: 2.0,
      throttleSlopePerC: 0.02,
      throttleFloor: 0.35,
      fpsDigits: 2,
      scoreDigits: 3,
    };

    const PLATFORM_TUNING = {
      android: { heapPenalty: 0.85, thermalBias: 1.0 },
      ios: { heapPenalty: 0.7, thermalBias: 1.05 },
      default: { heapPenalty: 0.9, thermalBias: 1.0 },
    };

    const BOTTLENECK_BY_CHANNEL = { gpu: 'gpu', cpu: 'cpu', mem: 'memory', thermal: 'thermal' };

    function clamp01(value) {
      return Math.min(1, Math.max(0, value));
    }

    function saturation(x, k) {
      return 1 - Math.exp(-k * Math.max(0, x));
    }

    function roundDigits(value, digits) {
      const factor = Math.pow(10, digits);
      return Math.round(value * factor) / factor;
    }

    function roundFps(value) {
      return roundDigits(value, MODEL.fpsDigits);
    }

    function roundScore(value) {
      return roundDigits(value, MODEL.scoreDigits);
    }

    function platformKeyOf(platform) {
      return platform === 'android' || platform === 'ios' ? platform : null;
    }

    function isPositiveNumber(value) {
      return typeof value === 'number' && Number.isFinite(value) && value > 0;
    }

    /**
     * ワークロード強度（必要 TOPS）から、モデルが必要とする 6 フィールドを組み立てる。
     * UI が持つノブは「必要 TOPS」1 本だけなので、残りは決定的な比率で導く。
     */
    function buildWorkload(metrics, device) {
      const effort = isPositiveNumber(metrics.workloadTops) ? metrics.workloadTops : 1;
      return {
        id: 'panel-workload',
        mtRequirement: effort,
        cpuWeight: 0.6 + 0.12 * effort,
        gpuWeight: 1.0,
        vramMb: Math.round(256 + 96 * effort),
        threads: 4,
        targetFps: isPositiveNumber(device.refreshHz) ? device.refreshHz : 60,
      };
    }

    /**
     * 定常状態の FPS。`estimateFps()` と同じ式・同じ丸め。
     * @returns {{fps:number,targetFps:number,capped:boolean,bottleneck:string,
     *            subscores:object,warnings:string[],loadIndex:number}}
     */
    function estimateFps(soc, workload, device) {
      const tuning = PLATFORM_TUNING[platformKeyOf(soc.platform)] || PLATFORM_TUNING.default;
      const warnings = [];
      const targetFps = workload.targetFps;

      const gpuDemandTops = workload.mtRequirement * workload.gpuWeight;
      const gpuCap = clamp01(saturation(soc.tops / gpuDemandTops, MODEL.gpuSaturationK));

      const extraThreads = Math.max(0, workload.threads - MODEL.cpuThreadBaseline);
      const threadPressure = 1 + extraThreads * MODEL.cpuThreadPenaltyPerExtra;
      const cpuDemand = workload.cpuWeight * threadPressure;
      const cpuRatio = soc.cpuScore / (MODEL.cpuReferenceScore * cpuDemand);
      const cpuCap = clamp01(saturation(cpuRatio, MODEL.cpuSaturationK));

      const vramGb = workload.vramMb / 1024;
      const requiredBandwidthGBs =
        MODEL.memBaselineGBs + vramGb * MODEL.memGBsPerVramGB * (targetFps / 60);
      let memCap = clamp01(saturation(soc.memBandwidthGBs / requiredBandwidthGBs, MODEL.memSaturationK));

      const capacityMb = soc.memoryLimitGB * 1024;
      if (workload.vramMb > capacityMb) {
        warnings.push(`VRAM ${workload.vramMb}MB が SoC のメモリ容量 ${Math.round(capacityMb)}MB を超えています。`);
        memCap = clamp01(memCap * MODEL.memCapacityPenalty);
      } else if (workload.vramMb > capacityMb * MODEL.memNearLimitRatio) {
        warnings.push(`VRAM がメモリ容量の ${Math.round(MODEL.memNearLimitRatio * 100)}% を超えています。`);
      }

      if (device && isPositiveNumber(device.defaultHeapMb) && workload.vramMb > device.defaultHeapMb) {
        warnings.push(`VRAM ${workload.vramMb}MB が端末の推奨ヒープ ${device.defaultHeapMb}MB を超えています。`);
        memCap = clamp01(memCap * tuning.heapPenalty);
      }

      const gpuLoadNorm = clamp01(gpuDemandTops / MODEL.referenceLoadTops);
      const cpuLoadNorm = clamp01(cpuDemand / MODEL.referenceCpuDemand);
      const memLoadNorm = clamp01(workload.vramMb / MODEL.memReferenceVramMb);
      const loadIndex = clamp01(0.55 * gpuLoadNorm + 0.3 * cpuLoadNorm + 0.15 * memLoadNorm);

      const requiredW = MODEL.thermalBaseW + MODEL.thermalWPerLoad * loadIndex;
      const thermalRatio = soc.thermalBudgetW / requiredW;
      const thermalCap = clamp01(MODEL.thermalFloor + MODEL.thermalSpan * Math.min(1, thermalRatio));

      const caps = { cpu: cpuCap, gpu: gpuCap, mem: memCap, thermal: thermalCap };
      const keys = Object.keys(caps);
      let costSum = 0;
      for (const key of keys) costSum += 1 / Math.max(caps[key], 1e-6);
      const cost = costSum / keys.length;

      const rawFps = targetFps / cost;
      const fps = Math.min(targetFps, Math.max(1, roundFps(rawFps)));
      const capped = fps >= targetFps;

      let bottleneck = 'none';
      if (!capped) {
        const weakest = keys.slice().sort((a, b) => caps[a] - caps[b])[0];
        if (caps[weakest] < 0.92) bottleneck = BOTTLENECK_BY_CHANNEL[weakest];
      }

      return {
        fps,
        targetFps,
        capped,
        bottleneck,
        subscores: {
          cpu: roundScore(caps.cpu),
          gpu: roundScore(caps.gpu),
          mem: roundScore(caps.mem),
          thermal: roundScore(caps.thermal),
        },
        warnings,
        loadIndex,
      };
    }

    /** 熱回路のパラメータ（`createRuntimeState()` と同じ組み立て）。 */
    function thermalParams(soc, loadIndex) {
      const tuning = PLATFORM_TUNING[platformKeyOf(soc.platform)] || PLATFORM_TUNING.default;
      const budgetW = isPositiveNumber(soc.thermalBudgetW) ? soc.thermalBudgetW : MODEL.referenceBudgetW;
      const conductance = MODEL.conductanceWPerC * (budgetW / MODEL.referenceBudgetW) * tuning.thermalBias;
      const powerW = MODEL.idleW + MODEL.loadW * loadIndex;
      return {
        ambientC: MODEL.ambientC,
        conductance,
        heatRatePerSec: conductance / MODEL.heatCapacityJPerC,
        throttleC: MODEL.throttleBaseC + MODEL.throttleCPerW * budgetW,
        equilibriumC: MODEL.ambientC + powerW / conductance,
      };
    }

    /** 温度 → FPS 倍率（`throttleC` 超過 1℃ ごとに 2% 減、下限 0.35）。 */
    function thermalFactor(temperatureC, throttleC) {
      const over = temperatureC - throttleC;
      if (over <= 0) return 1;
      return Math.max(MODEL.throttleFloor, 1 - MODEL.throttleSlopePerC * over);
    }

    /** 1 次遅れ系の解析解で温度を進める（sample を何回に分けても同じ結果）。 */
    function advanceTemperature(tempC, params, elapsedMs) {
      if (!isPositiveNumber(elapsedMs)) return tempC;
      const dtSeconds = elapsedMs / 1000;
      return params.equilibriumC + (tempC - params.equilibriumC) * Math.exp(-params.heatRatePerSec * dtSeconds);
    }

    /* ====================================================================== */
    /* 端末・プラットフォームの状況                                             */
    /* ====================================================================== */

    function detectMac() {
      try {
        const uaData = navigator.userAgentData;
        if (uaData && typeof uaData.platform === 'string') return /mac/i.test(uaData.platform);
        return /Mac/i.test(String(navigator.platform || '') + ' ' + String(navigator.userAgent || ''));
      } catch {
        return false;
      }
    }

    /**
     * 起動可否。ホストが答えを持っていればそれを優先し、無ければローカル判断。
     * iOS Simulator は macOS 専用（simctl が必要）。
     */
    function resolveAvailability(platform, linkMode, hostAvailability) {
      const hostAnswer = hostAvailability ? hostAvailability[platform] : null;
      if (linkMode === 'host' && hostAnswer && typeof hostAnswer.available === 'boolean') {
        return { available: hostAnswer.available, reason: hostAnswer.reason || '' };
      }
      if (platform === 'ios' && !detectMac()) {
        return { available: false, reason: 'iOS Simulator は macOS 専用です（simctl が見つかりません）。' };
      }
      return { available: true, reason: '' };
    }

    /* ====================================================================== */
    /* 設定の保存                                                              */
    /* ====================================================================== */

    function readStored() {
      const empty = { platform: 'android', socId: null, deviceId: null, endpoint: null };
      try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (!raw) return empty;
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return empty;
        return {
          platform: parsed.platform === 'ios' ? 'ios' : 'android',
          socId: typeof parsed.socId === 'string' ? parsed.socId : null,
          deviceId: typeof parsed.deviceId === 'string' ? parsed.deviceId : null,
          endpoint: typeof parsed.endpoint === 'string' && parsed.endpoint ? parsed.endpoint : null,
        };
      } catch {
        return empty;
      }
    }

    function writeStored(patch) {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(patch));
      } catch {
        /* 保存できない環境では黙って諦める（表示は壊さない） */
      }
    }

    function initialSelection() {
      const stored = readStored();
      const platform = stored.platform;
      const storedSoc = getSoc(stored.socId);
      const soc = storedSoc && storedSoc.platform === platform ? storedSoc : socsOf(platform)[0];
      const storedDevice = getDevice(stored.deviceId);
      const device = storedDevice && storedDevice.platform === platform
        ? storedDevice
        : devicesOf(platform).find((entry) => entry.socId === soc.id) || devicesOf(platform)[0];
      /* 保存値 > ページ側のグローバル上書き > 既定。保存値が最優先なのは、
         パネルの「適用」で決めた URL が再読み込みで消えないようにするため。 */
      const globalEndpoint = typeof window.__DSH_EMULATOR_LAB_ENDPOINT__ === 'string'
        ? window.__DSH_EMULATOR_LAB_ENDPOINT__
        : '';
      return {
        platform,
        soc,
        device,
        endpoint: stored.endpoint || globalEndpoint || DEFAULT_ENDPOINT,
      };
    }

    /** SoC のカタログ値でスライダーを初期化する。 */
    function seedMetrics(soc) {
      return {
        tops: soc.tops,
        memoryLimitGB: soc.memoryLimitGB,
        memBandwidthGBs: soc.memBandwidthGBs,
        thermalBudgetW: soc.thermalBudgetW,
        workloadTops: 2,
      };
    }

    /* ====================================================================== */
    /* スタイル（ダークテーマ前提。トークンがあれば使い、無ければ自前色）        */
    /* ====================================================================== */

    const PANEL_CSS = `
.del-panel{display:flex;flex-direction:column;gap:14px;padding:12px 12px 24px;height:100%;overflow-y:auto;
  color:var(--dsw-alias-label-primary,#e6e6e6);background:var(--dsw-alias-bg-base,#141414);
  font-size:12.5px;line-height:1.5;box-sizing:border-box}
.del-panel *{box-sizing:border-box}
.del-sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;
  clip:rect(0 0 0 0);white-space:nowrap;border:0}
.del-tabs{display:flex;gap:4px;padding:3px;border-radius:9px;
  background:var(--dsw-alias-bg-layer-2,#222);border:1px solid var(--dsw-alias-border-l1,#2f2f2f)}
.del-tab{flex:1;padding:6px 8px;border-radius:7px;border:1px solid transparent;background:transparent;
  color:var(--dsw-alias-label-secondary,#b6b6b6);font:inherit;font-weight:600;cursor:pointer}
.del-tab:hover{color:var(--dsw-alias-label-primary,#e6e6e6);background:var(--dsw-alias-bg-layer-1,#1b1b1b)}
.del-tab[aria-selected="true"]{color:var(--dsw-alias-label-primary,#e6e6e6);
  background:var(--dsw-alias-bg-overlay,#2a2a2a);border-color:var(--dsw-alias-border-l2,#3d3d3d)}
.del-tab:focus-visible,.del-btn:focus-visible,.del-chip:focus-visible,.del-input:focus-visible,
.del-range:focus-visible,.del-select:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4c8dff);
  outline-offset:2px}
.del-section{display:flex;flex-direction:column;gap:8px}
.del-section-title{margin:0;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;
  color:var(--dsw-alias-label-caption,#8a8a8a)}
.del-soclist{display:flex;flex-direction:column;gap:4px;max-height:190px;overflow-y:auto;padding:2px;
  border-radius:8px}
.del-chip{display:flex;align-items:center;gap:8px;width:100%;padding:6px 8px;text-align:left;
  border-radius:7px;border:1px solid var(--dsw-alias-border-l1,#2f2f2f);
  background:var(--dsw-alias-bg-layer-1,#1b1b1b);color:var(--dsw-alias-label-secondary,#b6b6b6);
  font:inherit;cursor:pointer}
.del-chip:hover{background:var(--dsw-alias-bg-layer-2,#222);color:var(--dsw-alias-label-primary,#e6e6e6)}
.del-chip[aria-checked="true"]{color:var(--dsw-alias-label-primary,#e6e6e6);
  background:var(--dsw-alias-bg-overlay,#2a2a2a);border-color:var(--dsw-alias-border-l2,#3d3d3d)}
.del-dot{width:8px;height:8px;border-radius:50%;flex:none;box-shadow:0 0 0 3px rgba(255,255,255,.06)}
.del-chip-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.del-chip-meta{flex:none;font-size:10.5px;color:var(--dsw-alias-label-caption,#8a8a8a);font-variant-numeric:tabular-nums}
.del-select,.del-input{width:100%;padding:6px 8px;border-radius:7px;
  border:1px solid var(--dsw-alias-border-l1,#2f2f2f);background:var(--dsw-alias-bg-layer-1,#1b1b1b);
  color:var(--dsw-alias-label-primary,#e6e6e6);font:inherit}
.del-row{display:flex;align-items:center;justify-content:space-between;gap:8px}
.del-field{display:flex;flex-direction:column;gap:4px}
.del-field-label{display:flex;align-items:baseline;justify-content:space-between;gap:8px;font-size:11.5px;
  color:var(--dsw-alias-label-secondary,#b6b6b6)}
.del-field-value{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary,#e6e6e6);font-weight:600}
.del-range{width:100%;accent-color:var(--dsw-alias-brand-primary,#4c8dff);margin:0}
.del-actions{display:flex;gap:6px}
.del-btn{flex:1;padding:8px 10px;border-radius:8px;font:inherit;font-weight:600;cursor:pointer;
  border:1px solid var(--dsw-alias-border-l2,#3d3d3d);background:var(--dsw-alias-bg-layer-2,#222);
  color:var(--dsw-alias-label-primary,#e6e6e6)}
.del-btn:hover:not(:disabled){background:var(--dsw-alias-bg-overlay,#2a2a2a)}
.del-btn:disabled{opacity:.45;cursor:not-allowed}
.del-btn-primary{background:var(--dsw-alias-brand-primary,#2b6cb0);border-color:transparent;color:#fff}
.del-btn-primary:hover:not(:disabled){filter:brightness(1.1)}
.del-status{display:flex;align-items:center;gap:6px;font-size:11.5px;
  color:var(--dsw-alias-label-secondary,#b6b6b6)}
.del-spin{width:11px;height:11px;border-radius:50%;flex:none;
  border:2px solid var(--dsw-alias-border-l2,#3d3d3d);border-top-color:var(--dsw-alias-brand-primary,#4c8dff);
  animation:del-spin .8s linear infinite}
@keyframes del-spin{to{transform:rotate(360deg)}}
.del-gauge{padding:12px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1,#2f2f2f);
  background:var(--dsw-alias-bg-layer-1,#1b1b1b);display:flex;flex-direction:column;gap:8px}
.del-fps{display:flex;align-items:baseline;gap:6px}
.del-fps-value{font-size:34px;font-weight:700;line-height:1;font-variant-numeric:tabular-nums}
.del-fps-unit{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary,#b6b6b6)}
.del-bar{position:relative;height:8px;border-radius:999px;overflow:hidden;
  background:var(--dsw-alias-bg-layer-2,#222)}
.del-bar-fill{position:absolute;inset:0 auto 0 0;border-radius:999px;transition:width .25s ease}
.del-bar-ticks{position:absolute;inset:0;pointer-events:none;
  background:repeating-linear-gradient(to right,transparent 0 11.9%,rgba(255,255,255,.07) 11.9% 12%)}
.del-kv{display:flex;align-items:baseline;justify-content:space-between;gap:8px;font-size:11.5px;
  color:var(--dsw-alias-label-secondary,#b6b6b6)}
.del-kv b{color:var(--dsw-alias-label-primary,#e6e6e6);font-weight:600;font-variant-numeric:tabular-nums}
.del-note{font-size:11px;line-height:1.45;padding:6px 8px;border-radius:7px;
  border:1px solid var(--dsw-alias-border-l1,#2f2f2f);color:var(--dsw-alias-label-secondary,#b6b6b6);
  background:var(--dsw-alias-bg-layer-2,#222)}
.del-note[data-kind="warn"]{border-color:rgba(245,158,11,.45);color:var(--dsw-alias-state-warn-primary,#f0b429)}
.del-note[data-kind="error"]{border-color:rgba(239,68,68,.45);color:var(--dsw-alias-state-error-primary,#ef4444)}
.del-badge{display:inline-flex;align-items:center;gap:4px;padding:1px 6px;border-radius:999px;
  font-size:10px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;vertical-align:middle}
.del-badge[data-kind="sim"]{background:rgba(76,141,255,.16);color:var(--dsw-alias-brand-primary,#78aeff)}
.del-badge[data-kind="live"]{background:rgba(21,128,61,.2);color:var(--dsw-alias-state-success-primary,#3fbf6f)}
.del-muted{color:var(--dsw-alias-label-tertiary,#8a8a8a)}
`;

    /* ====================================================================== */
    /* アイコン                                                               */
    /* ====================================================================== */

    function EmulatorIcon(props) {
      const size = (props && Number(props.size)) || 16;
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        h('rect', { x: 4, y: 1.5, width: 8, height: 13, rx: 1.8 }),
        h('path', { d: 'M6.6 3.4h2.8' }),
        h('circle', { cx: 8, cy: 12.2, r: 0.7 }),
        h('path', { d: 'M9.6 6.6 8 8l1.6 1.4' }),
      );
    }

    /* ====================================================================== */
    /* 部品                                                                   */
    /* ====================================================================== */

    function Slider(props) {
      const { id, label, value, min, max, step, unit, format, onChange } = props;
      const shown = format ? format(value) : String(value);
      return h(
        'div',
        { className: 'del-field' },
        h(
          'div',
          { className: 'del-field-label' },
          h('label', { htmlFor: id }, label),
          h('span', { className: 'del-field-value' }, shown + (unit ? unit : '')),
        ),
        h('input', {
          id,
          className: 'del-range',
          type: 'range',
          min,
          max,
          step,
          value,
          'aria-label': label,
          'aria-valuetext': shown + (unit ? unit : ''),
          onChange: (event) => onChange(Number(event.target.value)),
        }),
      );
    }

    function SocList(props) {
      const { list, selectedId, onSelect } = props;
      const listRef = React.useRef(null);

      /** roving tabindex: キーボードで選んだチップへ、描画前の既存 DOM 上で直接フォーカスを移す。 */
      function focusChipAt(index) {
        const group = listRef.current;
        const node = group && group.children ? group.children[index] : null;
        if (node && typeof node.focus === 'function') node.focus();
      }

      function move(delta) {
        const index = list.findIndex((soc) => soc.id === selectedId);
        const next = Math.min(list.length - 1, Math.max(0, index + delta));
        if (next === index) return;
        onSelect(list[next].id);
        focusChipAt(next);
      }

      function selectAt(index) {
        onSelect(list[index].id);
        focusChipAt(index);
      }

      function onKeyDown(event) {
        const handled = {
          ArrowDown: () => move(1),
          ArrowRight: () => move(1),
          ArrowUp: () => move(-1),
          ArrowLeft: () => move(-1),
          Home: () => selectAt(0),
          End: () => selectAt(list.length - 1),
        }[event.key];
        if (!handled) return;
        event.preventDefault();
        handled();
      }

      return h(
        'div',
        {
          className: 'del-soclist',
          role: 'radiogroup',
          'aria-label': 'SoC',
          ref: listRef,
          onKeyDown,
        },
        list.map((soc) => {
          const tier = TIER_META[soc.tier] || TIER_META.mid;
          const selected = soc.id === selectedId;
          return h(
            'button',
            {
              key: soc.id,
              type: 'button',
              role: 'radio',
              'aria-checked': selected ? 'true' : 'false',
              tabIndex: selected ? 0 : -1,
              className: 'del-chip',
              title: `${soc.vendor} ${soc.name}（${tier.label}）`,
              onClick: () => onSelect(soc.id),
            },
            h('span', { className: 'del-dot', style: { background: tier.color }, 'aria-hidden': 'true' }),
            h('span', { className: 'del-chip-name' }, soc.name),
            h('span', { className: 'del-chip-meta' }, `${tier.label} · ${soc.tops} TOPS`),
          );
        }),
      );
    }

    /** FPS ゲージ（0–120 のバー + 大きな数字）。role="meter" 相当は progressbar で表現する。 */
    function FpsGauge(props) {
      const { fps, targetFps, bottleneck, throttled, thermalC, source, measured } = props;
      const ratio = Math.min(1, Math.max(0, fps / FPS_MAX));
      const color = fps >= 55 ? 'var(--dsw-alias-state-success-primary,#3fbf6f)'
        : fps >= 30 ? 'var(--dsw-alias-state-warn-primary,#f0b429)'
          : 'var(--dsw-alias-state-error-primary,#ef4444)';
      const bottleneckMeta = BOTTLENECK_META[bottleneck] || BOTTLENECK_META.none;

      return h(
        'div',
        { className: 'del-gauge' },
        h(
          'div',
          { className: 'del-row' },
          h('span', { className: 'del-section-title' }, 'FPS'),
          h(
            'span',
            { className: 'del-badge', 'data-kind': source === 'host' ? 'live' : 'sim' },
            source === 'host' ? 'host' : 'simulated',
          ),
        ),
        h(
          'div',
          { className: 'del-fps' },
          h('span', { className: 'del-fps-value', style: { color } }, fps.toFixed(1)),
          h('span', { className: 'del-fps-unit' }, `FPS / 目標 ${targetFps}`),
        ),
        h(
          'div',
          {
            className: 'del-bar',
            role: 'progressbar',
            'aria-label': 'フレームレート',
            'aria-valuemin': 0,
            'aria-valuemax': FPS_MAX,
            'aria-valuenow': Number(fps.toFixed(1)),
            'aria-valuetext': `${fps.toFixed(1)} FPS（0〜${FPS_MAX}）`,
          },
          h('div', { className: 'del-bar-fill', style: { width: `${ratio * 100}%`, background: color } }),
          h('div', { className: 'del-bar-ticks', 'aria-hidden': 'true' }),
        ),
        h(
          'div',
          { className: 'del-kv' },
          h('span', null, 'ボトルネック'),
          h('b', null, `${bottleneckMeta.label}${bottleneck === 'none' ? '' : `（${bottleneckMeta.hint}）`}`),
        ),
        h(
          'div',
          { className: 'del-kv' },
          h('span', null, '実測値'),
          measured == null
            ? h('b', { className: 'del-muted' }, '取得できません（推定のみ）')
            : h('b', null, `${measured.toFixed(1)} FPS`),
        ),
        h(
          'div',
          { className: 'del-kv' },
          h('span', null, '推定温度'),
          h('b', null, thermalC == null ? '—' : `${thermalC.toFixed(1)} ℃`),
        ),
        throttled
          ? h(
            'div',
            { className: 'del-note', 'data-kind': 'warn', role: 'status' },
            '熱スロットリング中: 温度が閾値を超えたため FPS を減点しています。',
          )
          : null,
      );
    }

    /* ====================================================================== */
    /* パネル本体                                                              */
    /* ====================================================================== */

    function EmulatorPanel() {
      const boot = React.useMemo(initialSelection, []);
      const [platform, setPlatform] = React.useState(boot.platform);
      const [socId, setSocId] = React.useState(boot.soc.id);
      const [deviceId, setDeviceId] = React.useState(boot.device.id);
      const [metrics, setMetrics] = React.useState(() => seedMetrics(boot.soc));
      const [endpoint, setEndpoint] = React.useState(boot.endpoint);
      const [endpointDraft, setEndpointDraft] = React.useState(boot.endpoint);
      const [link, setLink] = React.useState({ mode: 'probing', detail: '' });
      const [hostAvailability, setHostAvailability] = React.useState(null);
      const [runState, setRunState] = React.useState('idle');
      const [runNote, setRunNote] = React.useState('');
      const [frame, setFrame] = React.useState(() => ({
        fps: 0,
        targetFps: 60,
        bottleneck: 'none',
        subscores: { cpu: 0, gpu: 0, mem: 0, thermal: 0 },
        warnings: [],
        thermalC: MODEL.ambientC,
        throttled: false,
        source: 'local',
        measured: null,
      }));

      const socFromId = getSoc(socId);
      const soc = socFromId && socFromId.platform === platform ? socFromId : socsOf(platform)[0];
      const deviceFromId = getDevice(deviceId);
      const device = deviceFromId && deviceFromId.platform === platform ? deviceFromId : devicesOf(platform)[0];
      const availability = resolveAvailability(platform, link.mode, hostAvailability);

      /* SoC を切り替えたらスライダーをそのカタログ値に戻す。 */
      React.useEffect(() => {
        setMetrics(seedMetrics(soc));
      }, [soc.id]);

      /* 選択を保存（次回はこの状態で開く）。 */
      React.useEffect(() => {
        writeStored({ platform, socId, deviceId, endpoint });
      }, [platform, socId, deviceId, endpoint]);

      /* プラットフォーム切替時、その platform の先頭 SoC / 端末へ寄せる。 */
      React.useEffect(() => {
        const nextSocs = socsOf(platform);
        if (!nextSocs.some((entry) => entry.id === socId)) {
          const first = nextSocs[0];
          setSocId(first.id);
          const matching = devicesOf(platform).find((entry) => entry.socId === first.id);
          setDeviceId((matching || devicesOf(platform)[0]).id);
        }
      }, [platform, socId]);

      const overriddenSoc = React.useMemo(
        () => ({
          ...soc,
          tops: metrics.tops,
          memoryLimitGB: metrics.memoryLimitGB,
          memBandwidthGBs: metrics.memBandwidthGBs,
          thermalBudgetW: metrics.thermalBudgetW,
        }),
        [soc, metrics],
      );

      const workload = React.useMemo(() => buildWorkload(metrics, device), [metrics, device]);
      const estimate = React.useMemo(
        () => estimateFps(overriddenSoc, workload, device),
        [overriddenSoc, workload, device],
      );
      const thermal = React.useMemo(
        () => thermalParams(overriddenSoc, estimate.loadIndex),
        [overriddenSoc, estimate.loadIndex],
      );

      const running = runState === 'running';

      /* 500ms ティックが読む入力。依存を ref に逃がして interval を作り直さない。 */
      const liveRef = React.useRef(null);
      liveRef.current = {
        running,
        linkMode: link.mode,
        endpoint,
        platform,
        soc: overriddenSoc,
        device,
        workload,
        targetFps: workload.targetFps,
        baseFps: estimate.fps,
        bottleneck: estimate.bottleneck,
        subscores: estimate.subscores,
        warnings: estimate.warnings,
        thermal,
      };

      const thermalRef = React.useRef({ temperatureC: MODEL.ambientC, lastTs: null });
      const frameSigRef = React.useRef('');
      const busyRef = React.useRef(false);
      const startTimerRef = React.useRef(0);

      /* 停止したら温度を周囲温度へ戻す（次の起動は冷えた状態から）。 */
      React.useEffect(() => {
        if (running) return;
        thermalRef.current = { temperatureC: MODEL.ambientC, lastTs: null };
      }, [running]);

      function commitFrame(next) {
        const sig = [
          next.fps,
          next.thermalC == null ? 'n' : next.thermalC.toFixed(1),
          next.throttled ? 1 : 0,
          next.bottleneck,
          next.warnings.length,
          next.measured == null ? 'n' : next.measured.toFixed(1),
          next.source,
        ].join('|');
        if (sig === frameSigRef.current) return;
        frameSigRef.current = sig;
        setFrame(next);
      }

      function localFrame(live) {
        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        const state = thermalRef.current;
        const elapsed = state.lastTs == null ? 0 : now - state.lastTs;
        state.lastTs = now;

        if (!live.running) {
          state.temperatureC = MODEL.ambientC;
          commitFrame({
            fps: live.baseFps,
            targetFps: live.targetFps,
            bottleneck: live.bottleneck,
            subscores: live.subscores,
            warnings: live.warnings,
            thermalC: MODEL.ambientC,
            throttled: false,
            source: 'local',
            measured: null,
          });
          return;
        }

        state.temperatureC = advanceTemperature(state.temperatureC, live.thermal, elapsed);
        const factor = thermalFactor(state.temperatureC, live.thermal.throttleC);
        const fps = Math.min(live.baseFps, Math.max(1, roundFps(live.baseFps * factor)));
        commitFrame({
          fps,
          targetFps: live.targetFps,
          bottleneck: live.bottleneck,
          subscores: live.subscores,
          warnings: live.warnings,
          thermalC: state.temperatureC,
          throttled: state.temperatureC > live.thermal.throttleC,
          source: 'local',
          measured: null,
        });
      }

      async function hostFrame(live) {
        if (busyRef.current) return;
        busyRef.current = true;
        try {
          const response = await fetch(trimSlash(live.endpoint) + '/sample', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              platform: live.platform,
              soc: live.soc,
              device: live.device,
              workload: live.workload,
              running: live.running,
            }),
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const data = await response.json();
          commitFrame({
            fps: Number.isFinite(data.simulatedFps) ? data.simulatedFps : live.baseFps,
            targetFps: live.targetFps,
            bottleneck: BOTTLENECK_META[data.bottleneck] ? data.bottleneck : live.bottleneck,
            subscores: live.subscores,
            warnings: Array.isArray(data.warnings) ? data.warnings : live.warnings,
            thermalC: Number.isFinite(data.thermalC) ? data.thermalC : null,
            throttled: data.throttled === true,
            source: 'host',
            measured: Number.isFinite(data.measuredFps) ? data.measuredFps : null,
          });
        } catch (error) {
          /* ホストが落ちたらローカル推定へ戻す（画面は止めない）。 */
          setLink({ mode: 'local', detail: describeError(error) });
        } finally {
          busyRef.current = false;
        }
      }

      /* 0.5 秒のリアルタイム更新。アンマウントで必ず解除する。 */
      React.useEffect(() => {
        const id = window.setInterval(() => {
          const live = liveRef.current;
          if (!live) return;
          if (live.linkMode === 'host') hostFrame(live);
          else localFrame(live);
        }, POLL_MS);
        return () => window.clearInterval(id);
      }, []);

      /* アンマウント時に起動待ちタイマーも止める。 */
      React.useEffect(() => () => {
        if (startTimerRef.current) window.clearTimeout(startTimerRef.current);
      }, []);

      /* エンドポイントの疎通確認。接続できなければローカル推定のまま。 */
      React.useEffect(() => {
        let cancelled = false;
        setLink({ mode: 'probing', detail: '' });
        const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
        const timer = window.setTimeout(() => controller && controller.abort(), 2500);
        fetch(trimSlash(endpoint) + '/probe', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
          signal: controller ? controller.signal : undefined,
        })
          .then((response) => {
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return response.json();
          })
          .then((data) => {
            if (cancelled) return;
            setHostAvailability({
              android: data && data.android ? data.android : null,
              ios: data && data.ios ? data.ios : null,
            });
            setLink({ mode: 'host', detail: '' });
          })
          .catch((error) => {
            if (cancelled) return;
            setHostAvailability(null);
            setLink({ mode: 'local', detail: describeError(error) });
          })
          .finally(() => window.clearTimeout(timer));
        return () => {
          cancelled = true;
          window.clearTimeout(timer);
          if (controller) controller.abort();
        };
      }, [endpoint]);

      async function start() {
        if (runState !== 'idle') return;
        setRunNote('');
        setRunState('starting');
        if (link.mode === 'host') {
          try {
            const response = await fetch(trimSlash(endpoint) + '/start', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                platform,
                socId: soc.id,
                deviceId: device.id,
                soc: overriddenSoc,
                device,
                workload,
              }),
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok || data.ok === false) throw new Error(data.detail || `HTTP ${response.status}`);
            setRunState('running');
            setRunNote(data.detail || `${platform === 'ios' ? 'Simulator' : 'AVD'} を起動しました。`);
          } catch (error) {
            setRunState('idle');
            setRunNote('起動に失敗しました: ' + describeError(error));
          }
          return;
        }
        /* ホスト未接続: 実機は起動できないので、推定セッションだけを走らせる。 */
        setRunNote('推定モード: ホスト未接続のため AVD / Simulator は起動しません。');
        startTimerRef.current = window.setTimeout(() => {
          startTimerRef.current = 0;
          setRunState('running');
        }, 600);
      }

      async function stop() {
        if (runState !== 'running' && runState !== 'starting') return;
        setRunState('stopping');
        if (link.mode === 'host') {
          try {
            await fetch(trimSlash(endpoint) + '/stop', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ platform }),
            });
          } catch (error) {
            setRunNote('停止要求に失敗しました: ' + describeError(error));
          }
        }
        setRunState('idle');
      }

      function selectPlatform(next) {
        if (next === platform) return;
        setPlatform(next);
        setRunState('idle');
      }

      function onTabKeyDown(event) {
        const order = ['android', 'ios'];
        const index = order.indexOf(platform);
        if (event.key === 'ArrowRight') {
          event.preventDefault();
          selectPlatform(order[(index + 1) % order.length]);
        } else if (event.key === 'ArrowLeft') {
          event.preventDefault();
          selectPlatform(order[(index - 1 + order.length) % order.length]);
        }
      }

      function applyEndpoint() {
        const next = endpointDraft.trim() || DEFAULT_ENDPOINT;
        setEndpointDraft(next);
        setEndpoint(next);
      }

      function resetMetrics() {
        setMetrics(seedMetrics(soc));
      }

      const platformLabel = platform === 'ios' ? 'Simulator' : 'AVD';
      const busy = runState === 'starting' || runState === 'stopping';
      const statusText = {
        idle: '停止中',
        starting: `起動中… (${platformLabel})`,
        running: link.mode === 'host' ? `稼働中 (${platformLabel})` : `推定セッション稼働中 (${platformLabel})`,
        stopping: '停止中…',
      }[runState];

      return h(
        'div',
        { className: 'del-panel' },
        h('style', null, PANEL_CSS),

        /* ── プラットフォームタブ ─────────────────────────────────── */
        h(
          'div',
          { className: 'del-tabs', role: 'tablist', 'aria-label': 'プラットフォーム', onKeyDown: onTabKeyDown },
          ['android', 'ios'].map((id) =>
            h(
              'button',
              {
                key: id,
                type: 'button',
                role: 'tab',
                id: `del-tab-${id}`,
                className: 'del-tab',
                'aria-selected': id === platform ? 'true' : 'false',
                'aria-controls': `del-tabpanel-${id}`,
                tabIndex: id === platform ? 0 : -1,
                onClick: () => selectPlatform(id),
              },
              id === 'ios' ? 'iOS' : 'Android',
            ),
          ),
        ),

        h(
          'div',
          {
            role: 'tabpanel',
            id: `del-tabpanel-${platform}`,
            'aria-labelledby': `del-tab-${platform}`,
            className: 'del-section',
          },

          /* ── SoC ─────────────────────────────────────────────── */
          h('h3', { className: 'del-section-title' }, 'SoC'),
          h(SocList, {
            list: socsOf(platform),
            selectedId: soc.id,
            onSelect: setSocId,
          }),

          /* ── 端末プロファイル ─────────────────────────────────── */
          h(
            'div',
            { className: 'del-field' },
            h('label', { className: 'del-field-label', htmlFor: 'del-device' }, '端末プロファイル'),
            h(
              'select',
              {
                id: 'del-device',
                className: 'del-select',
                value: device.id,
                onChange: (event) => setDeviceId(event.target.value),
              },
              devicesOf(platform).map((entry) => h('option', { key: entry.id, value: entry.id }, entry.label)),
            ),
          ),

          /* ── 指標スライダー ───────────────────────────────────── */
          h(
            'div',
            { className: 'del-section' },
            h(
              'div',
              { className: 'del-row' },
              h('h3', { className: 'del-section-title' }, 'SoC 指標'),
              h(
                'button',
                {
                  type: 'button',
                  className: 'del-btn',
                  style: { flex: 'none', padding: '3px 8px', fontSize: '11px' },
                  onClick: resetMetrics,
                },
                'カタログ値に戻す',
              ),
            ),
            h(Slider, {
              id: 'del-tops',
              label: 'TOPS (INT8)',
              value: metrics.tops,
              min: 0.2,
              max: 20,
              step: 0.1,
              format: (value) => value.toFixed(1),
              onChange: (value) => setMetrics((prev) => ({ ...prev, tops: value })),
            }),
            h(Slider, {
              id: 'del-memcap',
              label: 'メモリ容量上限',
              value: metrics.memoryLimitGB,
              min: 1,
              max: 16,
              step: 1,
              unit: ' GB',
              onChange: (value) => setMetrics((prev) => ({ ...prev, memoryLimitGB: value })),
            }),
            h(Slider, {
              id: 'del-bandwidth',
              label: 'メモリ帯域',
              value: metrics.memBandwidthGBs,
              min: 5,
              max: 80,
              step: 0.1,
              unit: ' GB/s',
              format: (value) => value.toFixed(1),
              onChange: (value) => setMetrics((prev) => ({ ...prev, memBandwidthGBs: value })),
            }),
            h(Slider, {
              id: 'del-tdp',
              label: 'TDP（放熱バジェット）',
              value: metrics.thermalBudgetW,
              min: 1,
              max: 10,
              step: 0.1,
              unit: ' W',
              format: (value) => value.toFixed(1),
              onChange: (value) => setMetrics((prev) => ({ ...prev, thermalBudgetW: value })),
            }),
            h(Slider, {
              id: 'del-workload',
              label: 'ワークロード強度（必要 TOPS）',
              value: metrics.workloadTops,
              min: 0.2,
              max: 12,
              step: 0.1,
              unit: ' TOPS',
              format: (value) => value.toFixed(1),
              onChange: (value) => setMetrics((prev) => ({ ...prev, workloadTops: value })),
            }),
          ),

          /* ── 起動 / 停止 ─────────────────────────────────────── */
          h(
            'div',
            { className: 'del-section' },
            h(
              'div',
              { className: 'del-actions' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'del-btn del-btn-primary',
                  disabled: !availability.available || runState !== 'idle',
                  onClick: start,
                  'aria-describedby': availability.available ? undefined : 'del-avail-note',
                  title: availability.available ? `${platformLabel} を起動` : availability.reason,
                },
                `起動 (${platformLabel})`,
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'del-btn',
                  disabled: runState !== 'running' && runState !== 'starting',
                  onClick: stop,
                },
                '停止',
              ),
            ),
            h(
              'div',
              { className: 'del-status', role: 'status', 'aria-live': 'polite' },
              busy ? h('span', { className: 'del-spin', 'aria-hidden': 'true' }) : null,
              h('span', null, statusText),
            ),
            availability.available
              ? null
              : h('div', { className: 'del-note', 'data-kind': 'warn', id: 'del-avail-note' }, availability.reason),
            runNote ? h('div', { className: 'del-note' }, runNote) : null,
          ),

          /* ── FPS ゲージ ──────────────────────────────────────── */
          h(FpsGauge, {
            fps: frame.fps,
            targetFps: frame.targetFps,
            bottleneck: frame.bottleneck,
            throttled: frame.throttled,
            thermalC: frame.thermalC,
            source: frame.source,
            measured: frame.measured,
          }),

          /* ── 能力比 ──────────────────────────────────────────── */
          h(
            'div',
            { className: 'del-section' },
            h('h3', { className: 'del-section-title' }, '能力比 (0–1)'),
            ['gpu', 'cpu', 'mem', 'thermal'].map((key) =>
              h(
                'div',
                { key, className: 'del-kv' },
                h('span', null, { gpu: 'GPU', cpu: 'CPU', mem: 'メモリ', thermal: '発熱' }[key]),
                h('b', null, frame.subscores[key].toFixed(3)),
              ),
            ),
          ),

          /* ── 警告 ────────────────────────────────────────────── */
          frame.warnings.length
            ? h(
              'div',
              { className: 'del-section' },
              h('h3', { className: 'del-section-title' }, '警告'),
              frame.warnings.map((text, index) =>
                h('div', { key: index, className: 'del-note', 'data-kind': 'warn' }, text),
              ),
            )
            : null,

          /* ── 接続 ────────────────────────────────────────────── */
          h(
            'div',
            { className: 'del-section' },
            h('h3', { className: 'del-section-title' }, '接続'),
            h(
              'div',
              { className: 'del-field' },
              h('label', { className: 'del-field-label', htmlFor: 'del-endpoint' }, 'ホスト側エンドポイント'),
              h('input', {
                id: 'del-endpoint',
                className: 'del-input',
                type: 'text',
                value: endpointDraft,
                spellCheck: false,
                onChange: (event) => setEndpointDraft(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') applyEndpoint();
                },
              }),
              h(
                'div',
                { className: 'del-row' },
                h('span', { className: 'del-muted' }, link.mode === 'host'
                  ? 'ホスト接続中（実測値を取得できます）'
                  : link.mode === 'probing'
                    ? '接続確認中…'
                    : 'ローカル推定で動作中（ホスト未接続）'),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'del-btn',
                    style: { flex: 'none', padding: '3px 10px', fontSize: '11px' },
                    onClick: applyEndpoint,
                  },
                  '適用',
                ),
              ),
              link.mode === 'local' && link.detail
                ? h('div', { className: 'del-muted' }, link.detail)
                : null,
            ),
          ),
        ),
      );
    }

    /* ====================================================================== */
    /* プラグイン                                                              */
    /* ====================================================================== */

    function trimSlash(value) {
      return String(value || '').replace(/\/+$/, '');
    }

    function describeError(error) {
      if (!error) return '不明なエラー';
      if (error.name === 'AbortError') return '接続がタイムアウトしました';
      if (typeof error.message === 'string' && error.message) return error.message;
      return String(error);
    }

    /**
     * 右サイドバーのタブ登録。
     * 座位 `sidebar.right.pane.tab` の存在自体が能力ゲートで、その中で 2 つの任意サービス
     * （`sidebarRightTabs` = タブ種別、`sidebarRight` = 展開/フォーカス）を待って登録する。
     * 戻り値は座位のライフサイクルに紐づく後始末関数。
     */
    function installRightbarTab(ctx) {
      if (!ctx || !ctx.slots || typeof ctx.slots.inject !== 'function') return null;
      return ctx.slots.inject('sidebar.right.pane.tab', () => {
        let disposed = false;
        let attempts = 0;
        let pollTimer = 0;
        let disposeTab = null;
        let disposeBody = null;

        const cleanup = () => {
          disposed = true;
          if (pollTimer) {
            window.clearTimeout(pollTimer);
            pollTimer = 0;
          }
          if (disposeBody) {
            try { disposeBody(); } catch { /* 後始末の失敗は無視 */ }
            disposeBody = null;
          }
          if (disposeTab) {
            try { disposeTab(); } catch { /* 後始末の失敗は無視 */ }
            disposeTab = null;
          }
        };

        const attempt = () => {
          if (disposed) return;
          const tabs = typeof ctx.get === 'function' ? ctx.get('sidebarRightTabs') : null;
          if (!tabs || typeof tabs.register !== 'function') {
            attempts += 1;
            if (attempts > SERVICE_POLL_TRIES) return; // サービスが来ないホストでは静かに諦める
            pollTimer = window.setTimeout(attempt, SERVICE_POLL_MS);
            return;
          }
          try {
            disposeTab = tabs.register({
              id: TAB_ID,
              kind: TAB_KIND,
              keepMounted: true,
              title: () => TAB_TITLE,
              guide: [{
                id: 'emulator',
                order: 120,
                title: () => TAB_TITLE,
                description: () => 'Android / iOS のローエンド SoC 性能を推定して FPS を表示します',
                icon: EmulatorIcon,
              }],
            });
            disposeBody = ctx.slots.register(
              { name: 'sidebar.right.pane.tab', key: TAB_ID },
              () => h(EmulatorPanel),
            );
          } catch (error) {
            cleanup();
            try {
              console.warn('[dsh-emulator-lab] 右サイドバーへのタブ登録に失敗しました:', error);
            } catch { /* 無視 */ }
          }
        };

        attempt();
        return cleanup;
      });
    }

    function apply(ctx) {
      if (!ctx || typeof ctx.effect !== 'function') return;
      ctx.effect(() => installRightbarTab(ctx) || undefined);
    }

    return { inject: ['slots'], apply };
  },
});

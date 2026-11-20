/**
 * dsh-emulator-lab — SoC 性能モデル（純 ESM・DSH 非依存）
 *
 * 目的:
 *   SoC のハードウェア仕様（TOPS / CPU スコア / メモリ帯域 / 発熱バジェット）と
 *   ワークロード（必要 TOPS・CPU/GPU 負荷・VRAM・スレッド数・目標 FPS）から、
 *   その端末で出せるフレームレートを決定的に推定する。
 *
 * 決定性:
 *   乱数・現在時刻・環境（window/navigator など）を一切参照しない。
 *   同じ入力に対しては、呼び出し順や実行環境にかかわらず常に同じ数値を返す。
 *
 * モデルの構成（すべて 0〜1 の「能力比」に正規化する）:
 *   gpu項 : soc.tops / (mtRequirement * gpuWeight) の飽和曲線 1 - exp(-k*x)
 *   cpu項 : soc.cpuScore / (基準スコア * cpuWeight * スレッド圧) の飽和曲線
 *   mem項 : 必要帯域（VRAM フットプリント × 目標 FPS + OS ベースライン）と
 *           soc.memBandwidthGBs の比の飽和曲線。容量/ヒープ超過で減点。
 *   thermal項: 負荷から求めた要求ワット数と thermalBudgetW の比。
 *           0.4 を下限にした線形（放熱余力が小さいほど低い）。
 *
 *   fps = targetFps / 重み付き調和平均(1/各能力比)
 *       → ボトルネックが単独で支配しすぎず、複数の不足が効くと下がる。
 *   fps は [1, targetFps] にクランプする。
 *
 * Android / iOS:
 *   カタログの platform を尊重し、iOS は jetsam（メモリ上限の厳格さ）と
 *   放熱特性をわずかに別係数で扱う。SoC とデバイスプロファイルの platform が
 *   食い違う場合は warnings に積む。
 */

/** 既定の重み（cpu/gpu/mem/thermal の寄与。1 で等価） */
export const DEFAULT_WEIGHTS = Object.freeze({ cpu: 1, gpu: 1, mem: 1, thermal: 1 });

/** プラットフォーム別の補正係数（演出用の概算。物理的な厳密値ではない） */
const PLATFORM_TUNING = Object.freeze({
  android: Object.freeze({ heapPenalty: 0.85, thermalBias: 1.0 }),
  ios: Object.freeze({ heapPenalty: 0.7, thermalBias: 1.05 }),
  default: Object.freeze({ heapPenalty: 0.9, thermalBias: 1.0 }),
});

/** モデル係数（1 か所にまとめて調整可能にする） */
const MODEL = Object.freeze({
  // 飽和曲線の鋭さ（大きいほど早く 1 に張り付く）
  gpuSaturationK: 2.0,
  cpuSaturationK: 2.0,
  memSaturationK: 2.0,

  // cpuScore 40 が「cpuWeight 1・4 スレッド」を余裕を持ってさばける基準
  cpuReferenceScore: 40,
  cpuThreadBaseline: 4,
  cpuThreadPenaltyPerExtra: 0.06,
  referenceCpuDemand: 2.0,

  // メモリ: 必要帯域 = baseline + VRAM(GB) * perGB * (targetFps/60)
  memBaselineGBs: 1.5,
  memGBsPerVramGB: 7.0,
  memNearLimitRatio: 0.85,
  memCapacityPenalty: 0.5,
  memReferenceVramMb: 2048,

  // 発熱（定常状態の能力比）
  thermalBaseW: 0.9,
  thermalWPerLoad: 4.6,
  thermalFloor: 0.4,
  thermalSpan: 0.6,
  referenceLoadTops: 8,

  // 発熱（時間発展）。C dT/dt = P - G (T - ambient) の解析解で更新する
  ambientC: 26,
  idleW: 0.8,
  loadW: 5.5,
  conductanceWPerC: 0.22, // thermalBudgetW = 3W のときの放熱コンダクタンス
  referenceBudgetW: 3,
  heatCapacityJPerC: 9,
  throttleBaseC: 38,
  throttleCPerW: 2.0,
  throttleSlopePerC: 0.02,
  throttleFloor: 0.35,

  // 丸め（表示用。内部計算は丸めない）
  fpsDigits: 2,
  scoreDigits: 3,
});

const BOTTLENECK_LABELS = Object.freeze({ gpu: 'gpu', cpu: 'cpu', mem: 'memory', thermal: 'thermal' });

/* -------------------------------------------------------------------------- */
/* 小さなユーティリティ（すべて決定的）                                          */
/* -------------------------------------------------------------------------- */

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const isPositiveNumber = (value) => isFiniteNumber(value) && value > 0;
const isNonNegativeNumber = (value) => isFiniteNumber(value) && value >= 0;

const clamp01 = (value) => (value < 0 ? 0 : value > 1 ? 1 : value);

const roundTo = (value, digits) => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};
const roundFps = (value) => roundTo(value, MODEL.fpsDigits);
const roundScore = (value) => roundTo(value, MODEL.scoreDigits);

const saturation = (ratio, k) => {
  if (!(ratio > 0)) return 0;
  return 1 - Math.exp(-k * ratio);
};

const platformKeyOf = (platform) => (platform === 'android' || platform === 'ios' ? platform : 'default');

/* -------------------------------------------------------------------------- */
/* 入力チェック                                                                 */
/* -------------------------------------------------------------------------- */

const SOC_NUMBER_FIELDS = [
  ['tops', 'INT8 TOPS'],
  ['cpuScore', 'CPU スコア'],
  ['memBandwidthGBs', 'メモリ帯域 (GB/s)'],
  ['thermalBudgetW', '発熱バジェット (W)'],
];

const WORKLOAD_NUMBER_FIELDS = [
  ['mtRequirement', '必要 TOPS'],
  ['cpuWeight', 'CPU 負荷'],
  ['gpuWeight', 'GPU 負荷'],
  ['threads', 'スレッド数'],
  ['targetFps', '目標 FPS'],
];

/** 不正時も必ず同じ形を返すためのフォールバック結果 */
function invalidResult(targetFps, warnings) {
  const safeTarget = isPositiveNumber(targetFps) ? Math.max(1, targetFps) : 60;
  return {
    ok: false,
    fps: 1,
    targetFps: safeTarget,
    capped: false,
    bottleneck: 'none',
    subscores: { cpu: 0, gpu: 0, mem: 0, thermal: 0 },
    warnings,
    loadIndex: 0,
    cost: Number.POSITIVE_INFINITY,
  };
}

function normalizeWeights(rawWeights, warnings) {
  const weights = { ...DEFAULT_WEIGHTS };
  if (rawWeights === undefined || rawWeights === null) return weights;
  if (!isObject(rawWeights)) {
    warnings.push('opts.weights がオブジェクトではないため、既定の重みを使用します。');
    return weights;
  }
  for (const key of Object.keys(DEFAULT_WEIGHTS)) {
    const value = rawWeights[key];
    if (value === undefined) continue;
    if (isPositiveNumber(value)) {
      weights[key] = value;
    } else {
      warnings.push(
        `opts.weights.${key} が正の数ではないため、既定値 ${DEFAULT_WEIGHTS[key]} を使用します。`,
      );
    }
  }
  return weights;
}

function resolveDevice(opts) {
  if (isObject(opts?.device)) return opts.device;
  if (isObject(opts?.deviceProfile)) return opts.deviceProfile;
  return null;
}

/**
 * SoC とワークロードから各能力比・fps を計算する内部関数。
 * 例外は投げず、不正入力は warnings 付きの ok:false 結果を返す。
 */
function computeModel(soc, workload, opts) {
  const warnings = [];

  if (!isObject(workload)) {
    warnings.push('workload がオブジェクトではないため FPS を推定できません（fps=1）。');
    return invalidResult(60, warnings);
  }

  const targetFps = isPositiveNumber(workload.targetFps) ? Math.max(1, workload.targetFps) : 60;

  if (!isObject(soc)) {
    warnings.push('soc がオブジェクトではないため FPS を推定できません（fps=1）。');
    return invalidResult(targetFps, warnings);
  }

  let invalid = false;
  for (const [field, label] of SOC_NUMBER_FIELDS) {
    if (!isPositiveNumber(soc[field])) {
      warnings.push(`soc.${field}（${label}）が正の数ではないため FPS を推定できません（fps=1）。`);
      invalid = true;
    }
  }
  for (const [field, label] of WORKLOAD_NUMBER_FIELDS) {
    if (!isPositiveNumber(workload[field])) {
      warnings.push(`workload.${field}（${label}）が正の数ではないため FPS を推定できません（fps=1）。`);
      invalid = true;
    }
  }
  if (!isNonNegativeNumber(workload.vramMb)) {
    warnings.push('workload.vramMb が 0 以上の数ではないため FPS を推定できません（fps=1）。');
    invalid = true;
  }
  if (invalid) return invalidResult(targetFps, warnings);

  const device = resolveDevice(opts);
  const tuning = PLATFORM_TUNING[platformKeyOf(soc.platform)] ?? PLATFORM_TUNING.default;
  const weights = normalizeWeights(opts?.weights, warnings);

  /* --- デバイスプロファイルとの整合性チェック ------------------------------ */
  if (device) {
    if (device.platform && soc.platform && device.platform !== soc.platform) {
      warnings.push(
        `デバイス「${device.id ?? '?'}」と SoC「${soc.id ?? '?'}」のプラットフォームが一致しません（${device.platform} / ${soc.platform}）。`,
      );
    }
    if (device.socId && soc.id && device.socId !== soc.id) {
      warnings.push(
        `デバイス「${device.id ?? '?'}」の想定 SoC は ${device.socId} ですが、${soc.id} が指定されました。`,
      );
    }
    if (isPositiveNumber(device.refreshHz) && workload.targetFps > device.refreshHz) {
      warnings.push(
        `目標 FPS ${workload.targetFps} が画面リフレッシュレート ${device.refreshHz}Hz を超えています。`,
      );
    }
  }

  /* --- 1. GPU / NPU -------------------------------------------------------- */
  const gpuDemandTops = workload.mtRequirement * workload.gpuWeight;
  const topsRatio = soc.tops / gpuDemandTops;
  const gpuCap = clamp01(saturation(topsRatio, MODEL.gpuSaturationK));

  /* --- 2. CPU -------------------------------------------------------------- */
  const extraThreads = Math.max(0, workload.threads - MODEL.cpuThreadBaseline);
  const threadPressure = 1 + extraThreads * MODEL.cpuThreadPenaltyPerExtra;
  const cpuDemand = workload.cpuWeight * threadPressure;
  const cpuRatio = soc.cpuScore / (MODEL.cpuReferenceScore * cpuDemand);
  const cpuCap = clamp01(saturation(cpuRatio, MODEL.cpuSaturationK));

  /* --- 3. メモリ ---------------------------------------------------------- */
  const vramGb = workload.vramMb / 1024;
  const requiredBandwidthGBs =
    MODEL.memBaselineGBs + vramGb * MODEL.memGBsPerVramGB * (workload.targetFps / 60);
  let memCap = clamp01(saturation(soc.memBandwidthGBs / requiredBandwidthGBs, MODEL.memSaturationK));

  const memoryLimitGB = isPositiveNumber(soc.memoryLimitGB) ? soc.memoryLimitGB : null;
  if (memoryLimitGB === null) {
    warnings.push('soc.memoryLimitGB が未指定のため、メモリ容量の不足判定をスキップします。');
  } else {
    const capacityMb = memoryLimitGB * 1024;
    if (workload.vramMb > capacityMb) {
      warnings.push(
        `VRAM ${workload.vramMb}MB が SoC のメモリ容量 ${Math.round(capacityMb)}MB を超えています。スワップ不可のため大幅に性能が落ちます。`,
      );
      memCap = clamp01(memCap * MODEL.memCapacityPenalty);
    } else if (workload.vramMb > capacityMb * MODEL.memNearLimitRatio) {
      warnings.push(
        `VRAM ${workload.vramMb}MB がメモリ容量の ${Math.round(MODEL.memNearLimitRatio * 100)}% を超えています。GC / 追い出しの影響が出ます。`,
      );
    }
  }

  if (device && isPositiveNumber(device.defaultHeapMb) && workload.vramMb > device.defaultHeapMb) {
    warnings.push(
      `VRAM ${workload.vramMb}MB がデバイスの推奨ヒープ ${device.defaultHeapMb}MB を超えています（OOM / jetsam リスク）。`,
    );
    memCap = clamp01(memCap * tuning.heapPenalty);
  }

  /* --- 4. 発熱（定常状態） -------------------------------------------------- */
  const gpuLoadNorm = clamp01(gpuDemandTops / MODEL.referenceLoadTops);
  const cpuLoadNorm = clamp01(cpuDemand / MODEL.referenceCpuDemand);
  const memLoadNorm = clamp01(workload.vramMb / MODEL.memReferenceVramMb);
  const loadIndex = clamp01(0.55 * gpuLoadNorm + 0.3 * cpuLoadNorm + 0.15 * memLoadNorm);

  const requiredW = MODEL.thermalBaseW + MODEL.thermalWPerLoad * loadIndex;
  const thermalRatio = soc.thermalBudgetW / requiredW;
  const thermalCap = clamp01(MODEL.thermalFloor + MODEL.thermalSpan * Math.min(1, thermalRatio));

  /* --- 5. 合成 ------------------------------------------------------------- */
  const caps = { cpu: cpuCap, gpu: gpuCap, mem: memCap, thermal: thermalCap };
  let costSum = 0;
  let weightSum = 0;
  for (const key of Object.keys(caps)) {
    const weight = weights[key];
    weightSum += weight;
    costSum += weight / Math.max(caps[key], 1e-6);
  }
  const cost = costSum / weightSum; // 1.0 = 目標 FPS ちょうど
  const rawFps = workload.targetFps / cost;
  const fps = Math.min(workload.targetFps, Math.max(1, roundFps(rawFps)));
  const capped = fps >= workload.targetFps;

  let bottleneck = 'none';
  if (!capped) {
    const ranked = Object.keys(caps).sort((a, b) => caps[a] - caps[b]);
    const weakest = ranked[0];
    if (caps[weakest] < 0.92) bottleneck = BOTTLENECK_LABELS[weakest];
  }

  return {
    ok: true,
    fps,
    targetFps: workload.targetFps,
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
    cost,
    rawFps,
  };
}

/* -------------------------------------------------------------------------- */
/* 公開 API                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * その SoC でワークロードを動かしたときの定常 FPS を推定する。
 *
 * @param {object|null} soc  SOC_CATALOG の要素（または同形のオブジェクト）
 * @param {object|null} workload
 *   { id?, name?, mtRequirement, cpuWeight, gpuWeight, vramMb, threads, targetFps }
 * @param {object} [opts]
 *   weights?: {cpu,gpu,mem,thermal}
 *   device?:  DEVICE_PROFILES の要素（整合性チェックとヒープ判定に使う）
 * @returns {{
 *   fps:number, targetFps:number, capped:boolean,
 *   bottleneck:'gpu'|'cpu'|'memory'|'thermal'|'none',
 *   subscores:{cpu:number,gpu:number,mem:number,thermal:number},
 *   warnings:string[]
 * }}
 *   不正入力でも例外は投げず、warnings を積んで fps=1 を返す。
 */
export function estimateFps(soc, workload, opts) {
  const model = computeModel(soc, workload, isObject(opts) ? opts : {});
  return {
    fps: model.fps,
    targetFps: model.targetFps,
    capped: model.capped,
    bottleneck: model.bottleneck,
    subscores: { ...model.subscores },
    warnings: model.warnings.slice(),
  };
}

/**
 * 時間経過で発熱し、thermalBudgetW を超えるとスロットリングする状態機械を作る。
 *
 * 熱モデル: C dT/dt = P - G (T - ambient) を解析解で厳密に更新する。
 *   P = idleW + loadW * loadIndex（ワークロード負荷）
 *   G = 0.22 * (thermalBudgetW / 3)（放熱余力。バジェットが大きいほど冷える）
 *   温度が throttleC を超えた分だけ fps を線形に落とす（下限 0.35 倍）。
 * 乱数は使わない。reset() で初期状態（ambient）に戻る。
 *
 * @param {object|null} soc
 * @param {object|null} deviceProfile
 * @param {object|null} workload
 * @param {object} [opts] weights / device に加え、ambientC（初期気温）を指定可能
 * @returns {{ sample:(elapsedMs:number)=>Object, reset:()=>Object, state:object }}
 *   sample(elapsedMs) の elapsedMs は「前回呼び出しからの経過時間(ms)」。
 *   0 以下や不正値は時間を進めず、現在値を返す。
 */
export function createRuntimeState(soc, deviceProfile, workload, opts) {
  const baseOpts = isObject(opts) ? opts : {};
  const runtimeOpts = {
    ...baseOpts,
    device: isObject(deviceProfile) ? deviceProfile : resolveDevice(baseOpts),
  };
  const model = computeModel(soc, workload, runtimeOpts);

  const socSafe = isObject(soc) ? soc : {};
  const tuning = PLATFORM_TUNING[platformKeyOf(socSafe.platform)] ?? PLATFORM_TUNING.default;
  const budgetW = isPositiveNumber(socSafe.thermalBudgetW) ? socSafe.thermalBudgetW : MODEL.referenceBudgetW;
  const ambientC = isNonNegativeNumber(baseOpts.ambientC) ? baseOpts.ambientC : MODEL.ambientC;

  const conductance = MODEL.conductanceWPerC * (budgetW / MODEL.referenceBudgetW) * tuning.thermalBias;
  const heatRatePerSec = conductance / MODEL.heatCapacityJPerC; // 1/s（温度の時定数の逆数）
  const throttleC = MODEL.throttleBaseC + MODEL.throttleCPerW * budgetW;
  const powerW = MODEL.idleW + MODEL.loadW * model.loadIndex;
  const equilibriumC = ambientC + powerW / conductance;

  const baseFps = model.fps;

  const state = {
    socId: typeof socSafe.id === 'string' ? socSafe.id : null,
    deviceId: isObject(deviceProfile) && typeof deviceProfile.id === 'string' ? deviceProfile.id : null,
    workloadId: isObject(workload) && typeof workload.id === 'string' ? workload.id : null,
    fps: baseFps,
    baseFps,
    elapsedMs: 0,
    samples: 0,
    thermalC: ambientC,
    ambientC,
    equilibriumC: roundFps(equilibriumC),
    throttleC,
    throttled: false,
    loadIndex: model.loadIndex,
    warnings: model.warnings.slice(),
  };

  const thermalFactor = (temperatureC) => {
    const over = temperatureC - throttleC;
    if (over <= 0) return 1;
    return Math.max(MODEL.throttleFloor, 1 - MODEL.throttleSlopePerC * over);
  };

  const fpsAt = (temperatureC) =>
    Math.min(baseFps, Math.max(1, roundFps(baseFps * thermalFactor(temperatureC))));

  const snapshot = () => ({
    fps: state.fps,
    throttled: state.throttled,
    thermalC: roundFps(state.thermalC),
  });

  function sample(elapsedMs) {
    const dtMs = isPositiveNumber(elapsedMs) ? elapsedMs : 0;
    if (dtMs > 0) {
      const dtSeconds = dtMs / 1000;
      state.thermalC = equilibriumC + (state.thermalC - equilibriumC) * Math.exp(-heatRatePerSec * dtSeconds);
      state.elapsedMs += dtMs;
      state.samples += 1;
    }
    state.throttled = state.thermalC > throttleC;
    state.fps = fpsAt(state.thermalC);
    return snapshot();
  }

  function reset() {
    state.thermalC = ambientC;
    state.elapsedMs = 0;
    state.samples = 0;
    state.throttled = false;
    state.fps = baseFps;
    return snapshot();
  }

  return { sample, reset, state };
}

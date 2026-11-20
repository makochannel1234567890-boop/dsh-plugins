/**
 * dsh-emulator-lab — SoC 性能モデルのテスト
 *
 * 実行: node --test test/soc-model.test.mjs
 * 依存: node 標準のみ（node:test / node:assert）
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SOC_CATALOG,
  DEVICE_PROFILES,
  getSoc,
  listSocs,
  getDeviceProfile,
} from '../lib/soc-catalog.js';

import {
  DEFAULT_WEIGHTS,
  estimateFps,
  createRuntimeState,
} from '../lib/soc-model.js';

/* -------------------------------------------------------------------------- */
/* フィクスチャ                                                                */
/* -------------------------------------------------------------------------- */

const HEAVY = Object.freeze({
  id: 'heavy-game',
  name: 'Heavy 3D game',
  mtRequirement: 8,
  cpuWeight: 1,
  gpuWeight: 1,
  vramMb: 1200,
  threads: 4,
  targetFps: 60,
});

const LIGHT = Object.freeze({
  id: 'light-app',
  name: 'Light 2D app',
  mtRequirement: 1.5,
  cpuWeight: 0.4,
  gpuWeight: 0.6,
  vramMb: 400,
  threads: 2,
  targetFps: 60,
});

const withWorkload = (patch) => ({ ...HEAVY, ...patch });

const LOW = getSoc('snapdragon-4-gen-2');
const HIGH = getSoc('apple-a15');
const WEAK = getSoc('unisoc-t606');

const MS_PER_STEP = 1000 / 60;

/* -------------------------------------------------------------------------- */
/* 1. カタログ                                                                 */
/* -------------------------------------------------------------------------- */

test('SOC_CATALOG は 12 件以上で、必須フィールドがすべて妥当', () => {
  assert.ok(Array.isArray(SOC_CATALOG));
  assert.ok(SOC_CATALOG.length >= 12, `SoC が ${SOC_CATALOG.length} 件しかない`);

  for (const soc of SOC_CATALOG) {
    assert.equal(typeof soc.id, 'string', 'id は文字列');
    assert.ok(soc.id.length > 0);
    assert.equal(typeof soc.vendor, 'string');
    assert.equal(typeof soc.name, 'string');
    assert.ok(soc.platform === 'android' || soc.platform === 'ios', `platform が不正: ${soc.id}`);
    assert.ok(soc.tops > 0, `tops が不正: ${soc.id}`);
    assert.ok(soc.cpuScore > 0, `cpuScore が不正: ${soc.id}`);
    assert.ok(soc.gpuScore > 0, `gpuScore が不正: ${soc.id}`);
    assert.ok(soc.memBandwidthGBs > 0, `memBandwidthGBs が不正: ${soc.id}`);
    assert.ok(soc.memoryLimitGB > 0, `memoryLimitGB が不正: ${soc.id}`);
    assert.ok(soc.recommendedHeapMb > 0, `recommendedHeapMb が不正: ${soc.id}`);
    assert.ok(soc.thermalBudgetW > 0, `thermalBudgetW が不正: ${soc.id}`);
    assert.ok(Number.isInteger(soc.releaseYear) && soc.releaseYear >= 2010, `releaseYear が不正: ${soc.id}`);
    assert.ok(['low', 'mid', 'high'].includes(soc.tier), `tier が不正: ${soc.id}`);
  }
});

test('SoC の id は重複しない', () => {
  const ids = SOC_CATALOG.map((soc) => soc.id);
  assert.equal(new Set(ids).size, ids.length, 'SoC id に重複がある');
});

test('ローエンド中心の構成になっている（low が 5 件以上、両 platform を含む）', () => {
  const low = SOC_CATALOG.filter((soc) => soc.tier === 'low');
  assert.ok(low.length >= 5, `low が ${low.length} 件しかない`);
  assert.ok(SOC_CATALOG.some((soc) => soc.platform === 'android'));
  assert.ok(SOC_CATALOG.some((soc) => soc.platform === 'ios'));
});

test('DEVICE_PROFILES は 10 件以上で、Android と iOS の両方を含む', () => {
  assert.ok(Array.isArray(DEVICE_PROFILES));
  assert.ok(DEVICE_PROFILES.length >= 10, `プロファイルが ${DEVICE_PROFILES.length} 件しかない`);
  assert.ok(DEVICE_PROFILES.some((d) => d.platform === 'android'));
  assert.ok(DEVICE_PROFILES.some((d) => d.platform === 'ios'));

  for (const device of DEVICE_PROFILES) {
    assert.equal(typeof device.id, 'string');
    assert.ok(device.id.length > 0);
    assert.equal(typeof device.label, 'string');
    assert.ok(device.platform === 'android' || device.platform === 'ios');
    assert.ok(device.resolution.w > 0 && device.resolution.h > 0, `解像度が不正: ${device.id}`);
    assert.ok(device.refreshHz > 0, `refreshHz が不正: ${device.id}`);
    assert.equal(typeof device.osVersion, 'string');
    assert.ok(device.defaultHeapMb > 0, `defaultHeapMb が不正: ${device.id}`);
  }
});

test('DEVICE_PROFILES の socId はすべて SOC_CATALOG に存在し、platform も一致する', () => {
  const ids = new Set(DEVICE_PROFILES.map((d) => d.id));
  assert.equal(ids.size, DEVICE_PROFILES.length, 'デバイス id に重複がある');

  for (const device of DEVICE_PROFILES) {
    const soc = getSoc(device.socId);
    assert.ok(soc, `未知の socId: ${device.socId}`);
    assert.equal(device.platform, soc.platform, `${device.id} の platform が SoC と不一致`);
  }
});

test('getSoc は既知の id を返し、未知・不正な値では undefined を返す', () => {
  assert.equal(getSoc('snapdragon-4-gen-2').name, 'Snapdragon 4 Gen 2');
  assert.equal(getSoc('apple-a15').platform, 'ios');
  assert.equal(getSoc('does-not-exist'), undefined);
  assert.equal(getSoc(undefined), undefined);
  assert.equal(getSoc(null), undefined);
  assert.equal(getSoc(42), undefined);
  assert.equal(getSoc(''), undefined);
});

test('listSocs は全件／platform 絞り込みを返し、元配列を変更しない', () => {
  const all = listSocs();
  assert.equal(all.length, SOC_CATALOG.length);
  assert.notEqual(all, SOC_CATALOG, 'カタログ本体ではなくコピーを返す');

  const android = listSocs('android');
  const ios = listSocs('ios');
  assert.ok(android.length > 0);
  assert.ok(ios.length > 0);
  assert.equal(android.length + ios.length, SOC_CATALOG.length);
  assert.ok(android.every((soc) => soc.platform === 'android'));
  assert.ok(ios.every((soc) => soc.platform === 'ios'));
  assert.equal(listSocs('windows').length, 0);
  assert.equal(listSocs(null).length, SOC_CATALOG.length);

  all.push({ id: 'dummy' });
  assert.equal(SOC_CATALOG.length, all.length - 1, '返り値の変更がカタログへ漏れている');
});

test('getDeviceProfile は既知の id を返し、未知では undefined を返す', () => {
  const profile = getDeviceProfile('ios-iphone-13-a15');
  assert.ok(profile);
  assert.equal(profile.platform, 'ios');
  assert.equal(profile.refreshHz, 60);
  assert.equal(getDeviceProfile('nope'), undefined);
  assert.equal(getDeviceProfile(undefined), undefined);
  assert.equal(getDeviceProfile(null), undefined);
});

/* -------------------------------------------------------------------------- */
/* 2. estimateFps                                                              */
/* -------------------------------------------------------------------------- */

test('DEFAULT_WEIGHTS は cpu/gpu/mem/thermal の 4 キーすべて 1', () => {
  assert.deepEqual({ ...DEFAULT_WEIGHTS }, { cpu: 1, gpu: 1, mem: 1, thermal: 1 });
});

test('estimateFps は契約どおりの形の戻り値を返す', () => {
  const result = estimateFps(LOW, HEAVY);
  assert.deepEqual(Object.keys(result).sort(), [
    'bottleneck',
    'capped',
    'fps',
    'subscores',
    'targetFps',
    'warnings',
  ]);
  assert.ok(Number.isFinite(result.fps));
  assert.equal(result.targetFps, 60);
  assert.equal(typeof result.capped, 'boolean');
  assert.ok(['gpu', 'cpu', 'memory', 'thermal', 'none'].includes(result.bottleneck));
  assert.ok(Array.isArray(result.warnings));
  for (const key of ['cpu', 'gpu', 'mem', 'thermal']) {
    assert.ok(Number.isFinite(result.subscores[key]), `${key} が数値でない`);
    assert.ok(result.subscores[key] >= 0 && result.subscores[key] <= 1, `${key} が 0..1 の外`);
  }
  assert.ok(result.fps >= 1, 'fps は 1 以上');
  assert.ok(result.fps <= result.targetFps, 'fps は targetFps 以下');
});

test('同じワークロードではローエンド SoC の fps がハイエンドより明確に低い', () => {
  const low = estimateFps(LOW, HEAVY);
  const high = estimateFps(HIGH, HEAVY);
  assert.ok(low.fps < high.fps, `low=${low.fps} high=${high.fps}`);
  assert.ok(high.fps - low.fps >= 10, `差が小さすぎる: low=${low.fps} high=${high.fps}`);
  assert.ok(low.subscores.gpu < high.subscores.gpu, 'GPU 能力比が逆転している');
});

test('軽いワークロードでは高性能 SoC が targetFps に張り付き capped=true / bottleneck=none', () => {
  for (const soc of [HIGH, getSoc('apple-a13')]) {
    const result = estimateFps(soc, LIGHT);
    assert.equal(result.fps, 60, `${soc.id} が軽負荷で 60fps に届かない`);
    assert.equal(result.capped, true);
    assert.equal(result.bottleneck, 'none');
    assert.ok(result.warnings.every((w) => !w.includes('不一致')), '意図しない警告が出ている');
  }
});

test('fps はどの SoC・どの targetFps でも目標を超えない', () => {
  const targets = [15, 30, 60, 120];
  for (const soc of SOC_CATALOG) {
    for (const targetFps of targets) {
      const result = estimateFps(soc, withWorkload({ targetFps }));
      assert.ok(result.fps <= targetFps, `${soc.id} target=${targetFps} で ${result.fps}`);
      assert.ok(result.fps >= 1, `${soc.id} target=${targetFps} で fps<1`);
    }
  }
});

test('GPU 負荷を上げると GPU 能力比と fps が下がる', () => {
  const light = estimateFps(HIGH, withWorkload({ mtRequirement: 2 }));
  const heavy = estimateFps(HIGH, withWorkload({ mtRequirement: 8 }));
  assert.ok(light.subscores.gpu > heavy.subscores.gpu, 'gpu サブスコアが負荷で下がっていない');
  assert.ok(light.fps >= heavy.fps, '重いほうが高 fps になっている');
});

test('メモリ容量不足では warnings が入り、fps は 1 以上に留まる', () => {
  // T606 は 3GB 想定。1200MB ではなく 6GB を要求すると容量超過。
  const result = estimateFps(WEAK, withWorkload({ vramMb: 6144 }));
  assert.ok(result.warnings.length > 0, '警告が出ていない');
  assert.ok(
    result.warnings.some((w) => w.includes('メモリ') || w.includes('VRAM')),
    `メモリ警告が見つからない: ${JSON.stringify(result.warnings)}`,
  );
  assert.ok(result.fps >= 1);
  assert.ok(result.fps <= 60);
});

test('メモリ容量の 85% 超では警告のみ（致命的エラーにしない）', () => {
  // T606 の 3GB = 3072MB。2800MB は 85% 超だが容量内。
  const result = estimateFps(WEAK, withWorkload({ vramMb: 2800 }));
  assert.ok(result.fps > 1, 'fps=1 に落ちてはいけない');
  assert.ok(
    result.warnings.some((w) => w.includes('85%')),
    `85% 警告が見つからない: ${JSON.stringify(result.warnings)}`,
  );
});

test('デバイスプロファイルのヒープを超えると警告が出る', () => {
  const device = getDeviceProfile('android-720p-t606'); // heap 256MB
  const result = estimateFps(WEAK, withWorkload({ vramMb: 400 }), { device });
  assert.ok(
    result.warnings.some((w) => w.includes('ヒープ')),
    `ヒープ警告が見つからない: ${JSON.stringify(result.warnings)}`,
  );
  assert.ok(result.fps >= 1);
});

test('SoC とデバイスの platform 不一致は警告になる', () => {
  const iosDevice = getDeviceProfile('ios-iphone-xr-a12');
  const result = estimateFps(LOW, HEAVY, { device: iosDevice });
  assert.ok(
    result.warnings.some((w) => w.includes('プラットフォーム')),
    `platform 警告が見つからない: ${JSON.stringify(result.warnings)}`,
  );
});

test('targetFps がリフレッシュレートを超えると警告になる', () => {
  const device = getDeviceProfile('android-720p-t606'); // 60Hz
  const result = estimateFps(WEAK, withWorkload({ targetFps: 120 }), { device });
  assert.ok(
    result.warnings.some((w) => w.includes('リフレッシュレート')),
    `refresh 警告が見つからない: ${JSON.stringify(result.warnings)}`,
  );
});

test('不正な weights は警告を積み、既定値で計算を続ける', () => {
  const result = estimateFps(HIGH, LIGHT, { weights: { cpu: -1, gpu: 'x' } });
  assert.ok(result.warnings.some((w) => w.includes('weights')));
  assert.ok(result.fps >= 1 && result.fps <= 60);
});

/* -------------------------------------------------------------------------- */
/* 3. 不正入力（例外を投げない）                                                */
/* -------------------------------------------------------------------------- */

test('不正入力: soc が null でも例外を投げず fps=1 で warnings を返す', () => {
  assert.doesNotThrow(() => estimateFps(null, HEAVY));
  const result = estimateFps(null, HEAVY);
  assert.equal(result.fps, 1);
  assert.equal(result.capped, false);
  assert.equal(result.bottleneck, 'none');
  assert.ok(result.warnings.length > 0);
});

test('不正入力: SoC の必須数値が欠落・ゼロ・NaN なら fps=1', () => {
  const cases = [
    { id: 'no-tops', cpuScore: 30, memBandwidthGBs: 15, thermalBudgetW: 3 },
    { id: 'zero-tops', tops: 0, cpuScore: 30, memBandwidthGBs: 15, thermalBudgetW: 3 },
    { id: 'nan-cpu', tops: 5, cpuScore: Number.NaN, memBandwidthGBs: 15, thermalBudgetW: 3 },
    { id: 'neg-bw', tops: 5, cpuScore: 30, memBandwidthGBs: -1, thermalBudgetW: 3 },
    { id: 'zero-thermal', tops: 5, cpuScore: 30, memBandwidthGBs: 15, thermalBudgetW: 0 },
  ];
  for (const soc of cases) {
    const result = estimateFps(soc, HEAVY);
    assert.equal(result.fps, 1, `${soc.id} が fps=1 になっていない`);
    assert.ok(result.warnings.length > 0, `${soc.id} に警告がない`);
  }
});

test('不正入力: workload が null / 必須数値の欠落・ゼロ・NaN なら fps=1', () => {
  assert.doesNotThrow(() => estimateFps(LOW, null));
  assert.equal(estimateFps(LOW, null).fps, 1);

  const cases = [
    { name: 'no-mt', workload: { ...HEAVY, mtRequirement: undefined } },
    { name: 'zero-mt', workload: { ...HEAVY, mtRequirement: 0 } },
    { name: 'no-target', workload: { ...HEAVY, targetFps: undefined } },
    { name: 'zero-target', workload: { ...HEAVY, targetFps: 0 } },
    { name: 'nan-target', workload: { ...HEAVY, targetFps: Number.NaN } },
    { name: 'neg-vram', workload: { ...HEAVY, vramMb: -1 } },
    { name: 'zero-threads', workload: { ...HEAVY, threads: 0 } },
  ];
  for (const { name, workload } of cases) {
    const result = estimateFps(LOW, workload);
    assert.equal(result.fps, 1, `${name} が fps=1 になっていない`);
    assert.ok(result.warnings.length > 0, `${name} に警告がない`);
    assert.ok(result.fps <= result.targetFps, `${name} で fps > targetFps`);
  }
});

test('不正入力: 文字列や配列を渡しても落ちない', () => {
  for (const bad of ['soc', 123, [], true]) {
    const result = estimateFps(bad, HEAVY);
    assert.equal(result.fps, 1);
    assert.ok(result.warnings.length > 0);
  }
  for (const bad of ['workload', 123, [], false]) {
    const result = estimateFps(LOW, bad);
    assert.equal(result.fps, 1);
    assert.ok(result.warnings.length > 0);
  }
});

/* -------------------------------------------------------------------------- */
/* 4. 決定性                                                                   */
/* -------------------------------------------------------------------------- */

test('決定的: 同じ入力なら何度呼んでも同じ結果（JSON 完全一致）', () => {
  const a = estimateFps(WEAK, HEAVY);
  const b = estimateFps(WEAK, HEAVY);
  assert.deepEqual(a, b);

  // 別の呼び出しを挟んでも結果が変わらない
  estimateFps(HIGH, LIGHT);
  const c = estimateFps(WEAK, HEAVY);
  assert.deepEqual(a, c);
});

test('決定的: 全カタログで targetFps まで含めて同一結果になる', () => {
  for (const soc of SOC_CATALOG) {
    const first = estimateFps(soc, HEAVY);
    const second = estimateFps(soc, HEAVY);
    assert.equal(first.fps, second.fps);
    assert.deepEqual(first.subscores, second.subscores);
    assert.equal(first.bottleneck, second.bottleneck);
  }
});

test('決定的: 結果は SoC オブジェクトを破壊しない', () => {
  const snapshot = JSON.stringify(LOW);
  estimateFps(LOW, HEAVY);
  assert.equal(JSON.stringify(LOW), snapshot, 'estimateFps が SoC を書き換えている');
});

/* -------------------------------------------------------------------------- */
/* 5. createRuntimeState                                                       */
/* -------------------------------------------------------------------------- */

test('createRuntimeState は sample/reset/state を返し、初期 fps は推定値と一致', () => {
  const device = getDeviceProfile('android-720p-t606'); // heap 256MB < VRAM 1200MB（減点あり）
  const runtime = createRuntimeState(WEAK, device, HEAVY);
  assert.equal(typeof runtime.sample, 'function');
  assert.equal(typeof runtime.reset, 'function');
  assert.equal(typeof runtime.state, 'object');

  const base = estimateFps(WEAK, HEAVY, { device });
  const first = runtime.sample(0);
  assert.deepEqual(Object.keys(first).sort(), ['fps', 'thermalC', 'throttled']);
  assert.equal(first.fps, base.fps);
  assert.equal(first.throttled, false);
  assert.equal(first.thermalC, 26);
  assert.equal(runtime.state.fps, base.fps);
  assert.equal(runtime.state.baseFps, base.fps);
});

test('sample は経過時間を積算し、熱が上がる（dt=0 では進まない）', () => {
  const runtime = createRuntimeState(WEAK, null, HEAVY);
  runtime.sample(MS_PER_STEP);
  const afterOne = runtime.sample(MS_PER_STEP);
  const t0 = runtime.state.thermalC;
  runtime.sample(0);
  assert.equal(runtime.state.thermalC, t0, 'sample(0) で時間が進んでいる');
  assert.ok(t0 > 26, `熱が上がっていない: ${t0}`);
  assert.ok(afterOne.thermalC > 26);
  assert.equal(runtime.state.samples, 2);
});

test('長時間サンプリングで熱スロットリングが発生し fps が下がる', () => {
  const runtime = createRuntimeState(WEAK, null, HEAVY);
  const first = runtime.sample(MS_PER_STEP);
  for (let i = 0; i < 6000; i += 1) runtime.sample(MS_PER_STEP); // 約 100 秒
  const late = runtime.sample(0);

  assert.equal(late.throttled, true, `throttled になっていない (thermalC=${late.thermalC})`);
  assert.ok(runtime.state.thermalC > runtime.state.throttleC);
  assert.ok(late.fps < first.fps, `fps が下がっていない: first=${first.fps} late=${late.fps}`);
  assert.ok(late.fps >= 1, 'fps が 1 未満になった');
  assert.equal(late.thermalC, Number(late.thermalC.toFixed(2)));
});

test('発熱バジェットが大きいハイエンド SoC は同じ時間でスロットリングしない', () => {
  const runtime = createRuntimeState(HIGH, null, LIGHT);
  for (let i = 0; i < 6000; i += 1) runtime.sample(MS_PER_STEP); // 約 100 秒
  const late = runtime.sample(0);
  assert.equal(late.throttled, false, `thermalC=${late.thermalC} throttleC=${runtime.state.throttleC}`);
  assert.ok(late.thermalC < runtime.state.throttleC);
  assert.equal(late.fps, runtime.state.baseFps);
});

test('reset で温度・経過時間・fps が初期状態に戻る', () => {
  const runtime = createRuntimeState(WEAK, null, HEAVY);
  for (let i = 0; i < 6000; i += 1) runtime.sample(MS_PER_STEP);
  assert.equal(runtime.state.throttled, true);

  const baseFps = runtime.state.baseFps;
  const resetSnapshot = runtime.reset();
  assert.equal(runtime.state.elapsedMs, 0);
  assert.equal(runtime.state.samples, 0);
  assert.equal(runtime.state.thermalC, 26);
  assert.equal(runtime.state.throttled, false);
  assert.equal(resetSnapshot.fps, baseFps);
  assert.equal(resetSnapshot.thermalC, 26);

  // リセット後は再び同じ軌跡をたどる
  const first = runtime.sample(MS_PER_STEP);
  assert.equal(first.throttled, false);
  assert.equal(first.fps, baseFps);
});

test('createRuntimeState は 2 つのインスタンスで同じ系列なら同じ結果（決定的）', () => {
  const a = createRuntimeState(WEAK, getDeviceProfile('android-fhd-4gen2'), HEAVY);
  const b = createRuntimeState(WEAK, getDeviceProfile('android-fhd-4gen2'), HEAVY);
  const seriesA = [];
  const seriesB = [];
  for (let i = 0; i < 300; i += 1) {
    seriesA.push(a.sample(16.6667));
    seriesB.push(b.sample(16.6667));
  }
  assert.deepEqual(seriesA, seriesB);
});

test('createRuntimeState は不正入力でも例外を投げず fps=1 を返す', () => {
  assert.doesNotThrow(() => createRuntimeState(null, null, null));
  const runtime = createRuntimeState(null, null, null);
  const snap = runtime.sample(16);
  assert.equal(snap.fps, 1);
  assert.ok(Number.isFinite(snap.thermalC));
  assert.doesNotThrow(() => runtime.reset());
  assert.equal(runtime.reset().fps, 1);
});

test('熱モデルは段階の刻み方に依存しすぎない（1 秒 × 10 と 10 秒 × 1 がほぼ一致）', () => {
  const stepwise = createRuntimeState(WEAK, null, HEAVY);
  const once = createRuntimeState(WEAK, null, HEAVY);
  for (let i = 0; i < 10; i += 1) stepwise.sample(1000);
  once.sample(10000);
  assert.ok(
    Math.abs(stepwise.state.thermalC - once.state.thermalC) < 0.05,
    `分割による差が大きい: ${stepwise.state.thermalC} vs ${once.state.thermalC}`,
  );
});

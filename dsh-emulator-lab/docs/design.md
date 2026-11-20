# dsh-emulator-lab — 設計ドキュメント

DSH Web GUI の右サイドバーから Android AVD / iOS Simulator を起動し、
SoC ごとのローエンド端末性能を**決定的**に推定して FPS を表示するプラグインの設計メモです。
実装は `lib/soc-catalog.js`（カタログ）、`lib/soc-model.js`（性能モデル）、
`lib/emulator.js`（検出・起動・実測）の 3 モジュールに分かれます。

すべてのモジュールは DSH に依存しない純 ESM で、乱数・現在時刻・ブラウザ API を参照しません。
同じ入力なら呼び出し順や実行環境にかかわらず同じ数値を返します。

## 1. 全体構成

```
lib/soc-catalog.js   SoC 定義・デバイスプロファイル・参照ヘルパ（純データ）
lib/soc-model.js     能力比への正規化 → FPS 合成 → 熱スロットリング（純計算）
lib/emulator.js      ツール検出 / 引数組み立て / 起動 / 実測 / 停止（外部コマンドは opts.run で注入）
```

`lib/emulator.js` の外部コマンド実行は `opts.run(cmd, args, runOpts)` として注入できます。
テストではフェイクの `run` を渡すため、`adb` / `emulator` / `xcrun` が無い環境でも検証できます。

### 1.1 クライアント側にも同じ式がある

右サイドバーのパネル（`client/client.js`）は、ブラウザから `lib/` を直接 import できません。
そのためパネルは `soc-catalog.js` のカタログと `soc-model.js` の式（`MODEL` の係数、
`estimateFps`、熱の時間発展）を**同じ値で自前にもっています**。
ホスト未接続でも推定表示が動くのはこのためです。

- 係数やカタログを変えるときは、`lib/` とクライアント側の両方を揃えて更新してください。
- パネルはホスト側エンドポイント（`/probe` `/start` `/stop` `/sample`）が応答すれば
  実測値と実起動に切り替わり、応答が無ければローカル推定に戻ります。
- ホスト側エンドポイントは Host 半（`index.js`）が prefix `/dsh-emulator-lab/api` として
  `webServer` サービスに登録します。`/start` は `emulator_launch` ツールと同じ実装を呼ぶので、
  起動経路はパネルとツールで 1 本です。`webServer` が無い環境では登録されず、
  パネルはローカル推定モードのまま動きます（実起動はツール `emulator_launch` が担う）。

## 2. SoC カタログの値

`SOC_CATALOG` の 1 要素が持つ数値と、その意味は次のとおりです。

| フィールド | 単位 | 意味 |
|---|---|---|
| `tops` | TOPS (INT8) | NPU/GPU 合算の INT8 ピーク性能（メーカー公称値ベースの概算） |
| `cpuScore` | 指数 | 相対 CPU 性能。`40` を「`cpuWeight` 1・4 スレッドを余裕を持ってさばける基準」とする |
| `gpuScore` | 指数 | 相対 GPU 性能（現行モデルでは表示用。FPS 式には未使用） |
| `memBandwidthGBs` | GB/s | メモリ帯域の概算（LPDDR4X/5 の理論値ベース） |
| `memoryLimitGB` | GB | その SoC を積む端末の標準的な物理 RAM |
| `recommendedHeapMb` | MB | アプリが安全に確保できるヒープ/VRAM の目安 |
| `thermalBudgetW` | W | 連続負荷で放熱し続けられるパッケージ電力の概算 |
| `tier` | `low` / `mid` / `high` | 価格帯の目安 |

`releaseYear` は表示用のメタデータです。

## 3. FPS 推定式

推定は 4 つの「能力比」（0〜1）に正規化し、最後に合成します。
以下、`clamp01(x) = min(1, max(0, x))`、`sat(x) = 1 - exp(-2.0 * x)` とします。

### 3.1 GPU 項

```text
gpuDemandTops = workload.mtRequirement * workload.gpuWeight
topsRatio     = soc.tops / gpuDemandTops
gpuCap        = clamp01(sat(topsRatio))          # sat(x) = 1 - exp(-2.0 * x)
```

必要 TOPS に対する供給の比を飽和曲線に通します。
`topsRatio = 1`（要求と供給が等しい）で `gpuCap ≈ 0.865`、
`topsRatio = 2` で `≈ 0.982` になり、供給が 2 倍あればほぼ頭打ちです。

### 3.2 CPU 項

```text
extraThreads   = max(0, workload.threads - 4)
threadPressure = 1 + extraThreads * 0.06         # 4 スレッド超は 1 本ごとに 6% 増し
cpuDemand      = workload.cpuWeight * threadPressure
cpuRatio       = soc.cpuScore / (40 * cpuDemand) # 40 = cpuReferenceScore
cpuCap         = clamp01(sat(cpuRatio))
```

`cpuScore 40` の SoC が `cpuWeight 1`・4 スレッドのワークロードを動かすと
`cpuRatio = 1`、つまり `cpuCap ≈ 0.865` になります。

### 3.3 メモリ項

必要帯域は「OS のベースライン + VRAM フットプリントに比例する分」で見積もります。
目標 FPS が高いほど 1 フレームあたりの転送量が増えるため、`targetFps / 60` を掛けます。

```text
vramGb              = workload.vramMb / 1024
requiredBandwidthGBs = 1.5 + vramGb * 7.0 * (workload.targetFps / 60)
memCap              = clamp01(sat(soc.memBandwidthGBs / requiredBandwidthGBs))
```

そのうえで容量の判定を 2 段階で入れます。

```text
capacityMb = soc.memoryLimitGB * 1024

if workload.vramMb > capacityMb:                 # 物理 RAM 超過（スワップ不可）
    memCap = clamp01(memCap * 0.5)               # memCapacityPenalty
    warn("VRAM が SoC のメモリ容量を超えています…")
else if workload.vramMb > capacityMb * 0.85:     # 85% 超（memNearLimitRatio）
    warn("メモリ容量の 85% を超えています。GC / 追い出しの影響…")
    # 減点はしない

if device.defaultHeapMb があり workload.vramMb > device.defaultHeapMb:
    memCap = clamp01(memCap * heapPenalty)
    warn("VRAM がデバイスの推奨ヒープを超えています（OOM / jetsam リスク）")
```

`heapPenalty` はプラットフォーム別で、Android `0.85` / iOS `0.70` / 未指定 `0.90` です。
iOS のほうが厳しいのは jetsam による強制終了が起きやすいためです（演出上の概算）。

### 3.4 発熱項（定常状態）

ワークロードの重さを 3 つの正規化負荷に分解し、重み付き和を負荷指数とします。

```text
gpuLoadNorm = clamp01(gpuDemandTops / 8)         # 8 TOPS を「重い」基準
cpuLoadNorm = clamp01(cpuDemand / 2.0)           # referenceCpuDemand = 2.0
memLoadNorm = clamp01(workload.vramMb / 2048)    # 2GB VRAM を「重い」基準

loadIndex   = clamp01(0.55 * gpuLoadNorm + 0.30 * cpuLoadNorm + 0.15 * memLoadNorm)
```

要求電力と放熱バジェットの比を、下限つきの線形で能力比に落とします。

```text
requiredW    = 0.9 + 4.6 * loadIndex             # thermalBaseW + thermalWPerLoad * loadIndex
thermalRatio = soc.thermalBudgetW / requiredW
thermalCap   = clamp01(0.4 + 0.6 * min(1, thermalRatio))   # 0.4〜1.0
```

`thermalRatio >= 1`（バジェットに余裕）なら `thermalCap = 1.0`、
`thermalRatio = 0` でも `0.4` を下回りません。放熱余力が小さい SoC ほど低い値に張り付きます。

### 3.5 合成とクランプ

4 つの能力比を**重み付き調和平均**（逆数の和）で合成します。
単独のボトルネックが支配しすぎず、複数の不足が同時に効くと FPS が下がる形です。

```text
weights  = { cpu: 1, gpu: 1, mem: 1, thermal: 1 }    # DEFAULT_WEIGHTS
cost     = Σ_i ( weights[i] / max(cap[i], 1e-6) ) / Σ_i weights[i]

rawFps   = workload.targetFps / cost                 # cost = 1.0 なら目標 FPS ちょうど
fps      = min(workload.targetFps, max(1, round(rawFps, 2)))    # fpsDigits = 2
capped   = (fps >= workload.targetFps)
```

- すべての能力比が 1 なら `cost = 1`、`fps = targetFps`（`capped = true`）。
- 能力比がすべて `0.5` なら `cost = 2`、`fps = targetFps / 2`。
- `fps` は必ず `[1, targetFps]` に収まります（1 未満にも targetFps 超にもなりません）。

### 3.6 ボトルネック判定

```text
if not capped:
    weakest = argmin_i cap[i]
    if cap[weakest] < 0.92:
        bottleneck = { gpu:'gpu', cpu:'cpu', mem:'memory', thermal:'thermal' }[weakest]
    else:
        bottleneck = 'none'
else:
    bottleneck = 'none'
```

返り値は `{ fps, targetFps, capped, bottleneck, subscores, warnings }` です
（内部では `loadIndex` / `cost` / `rawFps` / `ok` も計算しますが、公開 API は上記 6 つに絞ります）。
`subscores` の各値は小数 3 桁に丸めた能力比です。

### 3.7 不正入力

`soc` / `workload` の数値フィールド（`tops`, `cpuScore`, `memBandwidthGBs`, `thermalBudgetW`,
`mtRequirement`, `cpuWeight`, `gpuWeight`, `threads`, `targetFps`）が正の数でない場合、
または `vramMb` が 0 以上の数でない場合は例外を投げず、`warnings` に理由を積んで
`fps = 1` / `bottleneck = 'none'` / `subscores` すべて 0 を返します。

## 4. 熱スロットリングの時間発展

定常 FPS は「放熱が追いついた後」の値です。`createRuntimeState(soc, deviceProfile, workload, opts)`
はその手前に過渡状態を持ち、`sample(elapsedMs)` を呼ぶたびに温度を進めて FPS を更新します。

### 4.1 熱回路モデル

1 次遅れ系 `C dT/dt = P - G (T - T_ambient)` の解析解で厳密に更新します。

```text
budgetW     = soc.thermalBudgetW（無効時は 3.0）
ambientC    = opts.ambientC（既定 26）
thermalBias = Android 1.0 / iOS 1.05 / 未指定 1.0

G           = 0.22 * (budgetW / 3.0) * thermalBias     # 放熱コンダクタンス [W/℃]
C           = 9                                        # 熱容量 [J/℃]
heatRate    = G / C                                    # 1/s（時定数の逆数）

P           = 0.8 + 5.5 * loadIndex                    # 発熱 [W]（idleW + loadW * loadIndex）
equilibriumC = ambientC + P / G                        # 平衡温度
```

バジェットが大きい SoC ほど `G` が大きく、同じ負荷でも平衡温度が低くなります。

### 4.2 温度の更新

```text
dtSeconds = elapsedMs / 1000            # 0 以下・不正値は「時間を進めない」
T_new = equilibriumC + (T_old - equilibriumC) * exp(-heatRate * dtSeconds)
```

指数関数の解析解なので、`sample` を 1 回呼んでも 100 回に分けて呼んでも
同じ経過時間なら同じ温度になります（丸め誤差の範囲を除く）。

### 4.3 スロットリング係数

```text
throttleC = 38 + 2.0 * budgetW          # スロットリング開始温度
over      = T - throttleC
factor    = 1                                  (over <= 0)
          = max(0.35, 1 - 0.02 * over)         (over >  0)

fps(t)    = min(baseFps, max(1, round(baseFps * factor, 2)))
throttled = (T > throttleC)
```

温度が `throttleC` を 1℃ 超えるごとに 2% 落ち、`0.35` 倍で下限です。
`baseFps` は `estimateFps` が返す定常 FPS なので、スロットリングしても定常値は超えません。

### 4.4 状態とリセット

`createRuntimeState` は `{ sample, reset, state }` を返します。
`state` には `fps` / `baseFps` / `thermalC` / `ambientC` / `equilibriumC` / `throttleC` /
`throttled` / `loadIndex` / `elapsedMs` / `samples` / `warnings` が入ります。
`reset()` は温度を `ambientC` に戻し、`fps` を `baseFps` に戻します。
`soc` が無効な場合も例外は投げず、`fps = 1` 相当の状態を作ります。

## 5. Android と iOS の分岐

プラットフォームは「検出」「起動」「実測」の 3 か所で分かれます。
性能モデル側の分岐は §3.3 の `heapPenalty` と §4.1 の `thermalBias` だけです。

### 5.1 検出（`detectEmulators`）

```text
android: PATH と SDK ルート（%LOCALAPPDATA%\Android\Sdk など）から
         emulator(.exe) / adb(.exe) / avdmanager(.bat|.exe) を探す。
         `emulator -list-avds` 相当の出力を AVD 一覧として解析する。
ios:     darwin のときだけ xcrun / simctl を探し、
         `simctl list runtimes` / `simctl list devices` を解析する。
         Windows / Linux では available:false を返す（例外も投げない）。
```

両方とも失敗は `available:false` で表現し、検出系は絶対に例外を投げません。

### 5.2 起動

Android は `avdmanager create avd` で AVD を作り（`-c` RAM MB、`-H` ヒープ MB）、
`emulator -avd <name> -no-snapshot -memory <MB> -gpu <mode> -cores <N>`
（任意で `-skin <WxH>`、`-netdelay` / `-netspeed`、`-no-window` など）で起動します。
起動前に `clampConstraints` が SoC の物理上限で制約を丸めます
（RAM は `memoryLimitGB`、ヒープは `recommendedHeapMb` と RAM の小さいほう、
コア数はプロファイルの `maxCores`、GPU モードは `swiftshader_indirect` / `host` のいずれか）。

iOS は `xcrun simctl boot <udid|deviceName>` を実行します。
`simctl boot` は短命コマンドなので戻り値の `pid` は `null`、`serial` が udid になります。
プロファイルに `statusBar` があれば、続けて `simctl status_bar ... override` を発行します
（失敗しても起動自体は成功扱い）。

### 5.3 実測（`sampleFps`）

```text
android: adb -s <serial> shell dumpsys gfxinfo <package> framestats
         → FrameCompleted 列の差分からフレーム間隔を取り、中央値の逆数を fps にする。
           2 秒を超える間隔は異常値として捨てる。
         method: 'gfxinfo'（既定パッケージ名 com.example.app、opts.packageName で変更可）

ios:     xcrun simctl spawn <udid> log show --last <N>s --predicate 'eventMessage CONTAINS "FPS"'
         → 「58.5 FPS」「FPS: 58.5」の両方の書き方から数値を拾い、中央値を fps にする。
         method: 'simctl'
```

どちらも取れない場合は例外を投げず `{ fps:null, method:'unavailable', samples:[] }` を返します。

### 5.4 プラットフォーム整合性の警告

SoC とデバイスプロファイルの `platform` が食い違う場合、
`socId` が一致しない場合、`targetFps` が `refreshHz` を超える場合は、
モデルが計算を続けたうえで `warnings` に積みます（計算は止めません）。

## 6. 拡張方法

### 6.1 SoC を追加する

`lib/soc-catalog.js` の `SOC_CATALOG` に 1 要素を足します。

```js
{
  id: 'my-soc',            // 一意。getSoc / device.socId から参照される
  vendor: 'Vendor',
  name: 'My SoC',
  platform: 'android',     // 'android' | 'ios'
  tops: 2.0,
  cpuScore: 30,
  gpuScore: 18,
  memBandwidthGBs: 17.1,
  memoryLimitGB: 4,
  recommendedHeapMb: 384,
  thermalBudgetW: 3.4,
  releaseYear: 2024,
  tier: 'low',
}
```

`test/soc-model.test.mjs` は SoC 間の相対比較（上位 SoC のほうが FPS が高い等）を
検証しているため、数値を入れるときは既存 SoC との大小関係を壊さないようにします。

### 6.2 デバイスプロファイルを追加する

`DEVICE_PROFILES` に `socId` が実在する SoC を指す要素を足します。
`refreshHz` は目標 FPS の上限チェックに、`defaultHeapMb` はヒープ超過の減点に使われます。

### 6.3 ワークロードを追加する

ワークロードはカタログではなく呼び出し側が渡すプレーンオブジェクトです。
`estimateFps(soc, workload, opts)` に次の形で渡せば、モデル側の変更は不要です。

```js
{
  id: 'my-app',
  mtRequirement: 1.2,   // 必要 TOPS（INT8）
  cpuWeight: 0.8,       // CPU 負荷（1 = 基準）
  gpuWeight: 1.0,       // GPU 負荷（1 = 基準）
  vramMb: 512,          // VRAM フットプリント
  threads: 4,           // スレッド数（4 超で pressure）
  targetFps: 60,        // 目標 FPS（クランプ上限）
}
```

`opts.weights` で 4 項の重み（既定はすべて 1）を変えられます。
`opts.device`（または `opts.deviceProfile`）を渡すとヒープ判定と整合性チェックが有効になります。

### 6.4 実測サンプラを追加する

`lib/emulator.js` の `sampleFps` は `inferPlatform` の結果で
Android / iOS の実装に振り分けています。別プラットフォームや別ツールを足す場合は、
同じ `{ fps, method, samples }` を返す関数を実装し、振り分けに 1 分岐を足します。
外部コマンドは `opts.run` 経由で呼ぶことで、フェイクを注入したテストが書けます。

### 6.5 モデル係数を変える

係数は `lib/soc-model.js` の `MODEL`（飽和の鋭さ、基準スコア、帯域係数、熱パラメータなど）と
`PLATFORM_TUNING`（`heapPenalty` / `thermalBias`）に集約してあります。
変える場合は `test/soc-model.test.mjs` の期待値と相対比較を合わせて更新してください。

## 7. 設計上の制約

- **決定性**: 乱数・現在時刻・環境依存値を参照しません。同じ入力は常に同じ出力です。
- **数値は概算**: カタログ値はメーカー公称値や理論帯域からの概算で、実測ではありません。
  FPS 推定は「ローエンド端末間の相対差を再現する」ためのモデルです。
- **実 fps との不一致**: エミュレーターの実 fps はホスト CPU・GPU・仮想化の有無・
  ゲストの解像度に強く依存し、シミュレーション値とは一致しません。
- **iOS は macOS のみ**: `simctl` が必要なため、Windows / Linux では `available:false` です。
- **書き込み権限**: AVD 作成・起動には Android SDK と `adb` が必要です。
  実機ではなくエミュレーターを対象にしています。

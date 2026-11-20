# dsh-emulator-lab

Android の AVD と iOS Simulator を DSH Web GUI の右サイドバーから起動し、
**SoC ごとにローエンドスマホの性能をシミュレーションして FPS を推定・表示する**プラグインです。
INT8 の TOPS、メモリ帯域、メモリ容量上限、CPU/GPU スコア、発熱バジェット（TDP）を入力に、
ワークロード負荷からフレームレートを決定的に算出します（乱数なし・同じ入力なら常に同じ値）。
推定値は 4 項の内訳（GPU / CPU / メモリ / 発熱）とボトルネック付きで表示され、
時間経過にともなう熱スロットリングも再現します。Android と iOS は別プラットフォームとして扱います。

![右サイドバーのエミュレータータブ](docs/panel.png)

## インストールと有効化

このリポジトリの他のプラグインと同じく、DSH の Plugin Manager でフォルダを直接指定します。

```
plugin_manager install_bundle  target: <dsh-emulator-lab の絶対パス>
```

- `application: applied` なら即時反映されます。
- `restart-required` なら DSH を再起動してください（プラグインの読み込みは起動時に行われます）。
- `failed` のときは diagnostic を確認してください。`HMR transactions cannot be nested` は
  他のインストールと競合したときに出るので、静穏化後にもう一度実行するか再起動します。

有効化・無効化も Plugin Manager（`plugin_manager set_bundle`）で行います。
プロファイルの `package.json` / `cordis.patch.yml` を手で書き換えないでください。

## クイックスタート

1. DSH Web GUI の**右サイドバー**を開き、タブ一覧から **エミュレーター** を選びます
   （プラグイン名は `dsh-emulator-lab`、表示名は `locale/` の言語ファイルで変わります）。
2. パネル上部のタブで **Android** / **iOS** を切り替えます。
3. **SoC** セクションで SoC を選び、端末プロファイル（解像度・リフレッシュレート）を選びます。
   SoC の物理上限（メモリ容量・推奨ヒープ）を超える設定は自動で丸められ、理由が警告として出ます。
4. **ワークロード**のスライダーで必要 TOPS・CPU/GPU 負荷・VRAM・スレッド数・目標 FPS を決めます。
   既定値のままでも動きます。
5. **起動 (Android)** / **起動 (iOS)** を押すと FPS の推定が始まり、大きな FPS 表示・目標 FPS・ボトルネック・
   4 項の内訳（サブスコア）・現在の温度（℃）・スロットリング状態が並びます。
6. 動かしたままにすると温度が上がり、しきい値を超えると FPS が下がっていく様子が読めます。
   **停止**すると温度は周囲温度に戻り、次の起動は冷えた状態から始まります。

パネル下部には**ホスト側エンドポイント**の欄と接続状態（「ホスト接続中（実測値を取得できます）」／
「ローカル推定で動作中（ホスト未接続）」）が出ます。

ホスト側は同じプラグインの Host 半が `POST /dsh-emulator-lab/api/{probe,start,stop,sample}` として
提供します（同一オリジンの POST のみ受け付けます）。Host が応答するとき、パネルの起動・停止は
実際の AVD / Simulator を操作し、`sample` には実測 FPS が載ります。
`webServer` サービスが無い環境ではこのエンドポイントは生えず、パネルはローカル推定モードのまま
動きます（表示は壊れませんが、その場合は **AVD / Simulator は起動しません**。
そのときの実起動は後述の `emulator_launch` ツールで行えます）。

## モデル向けツール

パネルと同じモデル・同じカタログを使う 3 つのツールも登録されます。

| ツール | 何をするか | 主な入力 |
|---|---|---|
| `emulator_detect` | この PC の `emulator` / `avdmanager` / `adb`（iOS は `xcrun` / `simctl`）と、指定できる SoC・端末プロファイルの ID を返す。起動はしない | なし |
| `emulator_launch` | 端末プロファイルで Android AVD / iOS Simulator を起動する。RAM・ヒープ・コア数は SoC 上限にクランプされ、実際の起動コマンドと警告が返る | `platform`, `deviceProfileId`（任意: `socId`, `headless`） |
| `emulator_fps` | `mode: "simulated"` で SoC モデルから決定的に推定、`mode: "measured"` で起動中のエミュレーターから実測する | `mode`（＋ `platform`, `socId`, ワークロード各値, `serial` など） |

`emulator_launch` は実デバイスを起動する副作用があるので、数値だけ欲しいときは
`emulator_fps` の `simulated` を使ってください（エミュレーター不要・乱数なし）。

## 対応 SoC

`lib/soc-catalog.js` の `SOC_CATALOG` に登録されている値です（すべて概算。式と係数は `docs/design.md`）。

### Android

| SoC | TOPS | CPU | GPU | 帯域 GB/s | メモリ GB | ヒープ MB | TDP W | 年 | tier |
|---|---|---|---|---|---|---|---|---|---|
| Unisoc T606 | 0.4 | 18 | 10 | 12.8 | 3 | 256 | 2.5 | 2021 | low |
| Samsung Exynos 850 | 0.5 | 20 | 9 | 14.9 | 3 | 256 | 2.6 | 2020 | low |
| MediaTek Helio G85 | 0.6 | 22 | 13 | 13.4 | 4 | 320 | 3 | 2020 | low |
| Qualcomm Snapdragon 680 | 1.2 | 26 | 14 | 17.1 | 4 | 384 | 3.2 | 2021 | low |
| MediaTek Helio G99 | 1 | 33 | 20 | 17.1 | 6 | 448 | 3.4 | 2022 | low |
| Qualcomm Snapdragon 4 Gen 2 | 2 | 30 | 17 | 17.1 | 4 | 384 | 3.4 | 2023 | low |
| MediaTek Dimensity 6100+ | 1.8 | 31 | 19 | 17.1 | 6 | 448 | 3.5 | 2023 | low |
| Qualcomm Snapdragon 695 | 1.5 | 36 | 22 | 17.1 | 6 | 512 | 3.6 | 2021 | mid |
| MediaTek Dimensity 7050 | 2.6 | 44 | 30 | 25.6 | 8 | 512 | 4.2 | 2023 | mid |
| Qualcomm Snapdragon 7s Gen 2 | 4 | 48 | 34 | 25.6 | 8 | 512 | 4.4 | 2023 | mid |
| Qualcomm Snapdragon 778G | 5 | 52 | 40 | 25.6 | 8 | 512 | 4.6 | 2021 | mid |

### iOS

| SoC | TOPS | CPU | GPU | 帯域 GB/s | メモリ GB | ヒープ MB | TDP W | 年 | tier |
|---|---|---|---|---|---|---|---|---|---|
| Apple A12 Bionic | 5 | 58 | 46 | 34.1 | 3 | 1024 | 4 | 2018 | mid |
| Apple A13 Bionic | 6 | 66 | 55 | 42.7 | 4 | 1024 | 4.2 | 2019 | mid |
| Apple A15 Bionic | 15.8 | 88 | 82 | 51.2 | 6 | 1536 | 5 | 2021 | high |

デバイスプロファイル（画面解像度・リフレッシュレート・OS バージョン・推奨ヒープ）は
`DEVICE_PROFILES` に 13 件あります（Android 9 件 / iOS 4 件）。
1 つの SoC を複数のプロファイルが共有することもあります（例: A15 → iPhone 13 / 13 Pro）。

## 指標の意味

推定 FPS は 4 つの「能力比」（0〜1）に正規化してから合成するので、
どの数値が効いているかは `subscores` を見れば分かります。

| 指標（`subscores`） | 何を表すか | FPS への効き方 |
|---|---|---|
| `gpu` | NPU/GPU の INT8 性能（`tops`）が必要 TOPS に対して足りているか | 必要 TOPS が大きいほど、また `tops` が小さいほど下がる。供給が要求の 2 倍でほぼ頭打ち（飽和曲線） |
| `cpu` | `cpuScore` が CPU 負荷とスレッド数に対して足りているか | 4 スレッドを超えると 1 本ごとに要求が 6% 増える。`cpuScore 40` が基準 |
| `mem` | `memBandwidthGBs` が必要帯域に見合うか | 必要帯域は VRAM フットプリントに比例し、目標 FPS が高いほど増える。VRAM がメモリ上限を超えると半分に減点、推奨ヒープ超過でも減点 |
| `thermal` | `thermalBudgetW` が要求電力をまかなえるか | 負荷（GPU 55% + CPU 30% + VRAM 15%）から要求電力を出し、バジェット比で 0.4〜1.0 に落とす |

合成は**重み付き調和平均**（既定は 4 項すべて等しい重み）です。
1 項だけが極端に低いと FPS はその項に引きずられ、複数の項が同時に足りないとさらに下がります。
`bottleneck` は最も低い項を示します（0.92 以上なら `none`）。
FPS は必ず `1` 以上・`targetFps` 以下にクランプされます。

時間方向の挙動は熱モデルが決めます。負荷に応じて温度が平衡温度へ近づき、
`38 + 2.0 × TDP` ℃ を超えると超えた分だけ 1℃ あたり 2% ずつ FPS が落ちます（下限 0.35 倍）。
そのため「起動直後は 60fps だが 30 秒後に 35fps」といった推移が再現されます。

## 制限と注意

- **実機ではありません。** AVD / Simulator はどちらもエミュレーターで、実端末の性能を再現するものではありません。
- **数値は概算です。** カタログの TOPS・帯域・TDP・CPU/GPU スコアは公称値や理論値からの概算で、
  実測ベンチマークではありません。FPS は「ローエンド端末間の相対差」を見るためのモデル値です。
- **推定 FPS とエミュレーターの実 fps は一致しません。** 実 fps はホストの CPU / GPU 性能、
  仮想化（HAXM / WHPX / HVF）の有無、ゲスト解像度、GPU モード（`swiftshader_indirect` / `host`）に
  強く依存します。パネルの推定値は「その SoC を積んだ端末ならどうなるか」のシミュレーションです。
- **iOS は macOS 必須です。** `xcrun` / `simctl` が必要なため、Windows / Linux では
  iOS 側が使えないものとして扱われ（`available: false`）、パネルでは起動ボタンが無効になります。
- **Android は `adb` が必須です。** 起動と実測 FPS の取得に `adb` を使います。
  Android SDK と AVD（`avdmanager`）が見つからない場合は起動できません。
- **実測 FPS は補助的な値です。** Android は `adb shell dumpsys gfxinfo <package> framestats`、
  iOS は `xcrun simctl spawn <udid> log show` から取れる範囲の値で、
  取れないときは `unavailable` になります（推定値は壊れません）。
- **パネルからの実起動はホスト側エンドポイント頼みです。** 既定では Host 半が
  `/dsh-emulator-lab/api/start` を提供し、パネルの起動ボタンはそこを叩きます。
  `webServer` サービスが無い・別ポートの GUI から開いているなどでエンドポイントに届かない場合は
  パネルは推定モードに留まり、AVD / Simulator は起動しません。実起動は `emulator_launch` ツールでも
  行えます。
- **物理上限で自動的に丸められます。** RAM・ヒープ・コア数が SoC の上限を超える場合、
  AVD 作成前にクランプされ、その理由が警告として出ます。
- **状態はメモリ上だけです。** 熱スロットリングの温度・経過時間はセッション内の状態で、
  DSH を再起動するとリセットされます。
- **同時起動は想定していません。** 1 つの AVD / Simulator を対象に起動・停止・実測を行います。

## ライセンス

MIT License — Copyright (c) 2026 [mako7studio](https://github.com/makochannel1234567890-boop)。

設計の詳細（FPS 推定式の係数、熱モデルの式、Android / iOS の分岐、拡張方法）は
[`docs/design.md`](docs/design.md) にまとめてあります。

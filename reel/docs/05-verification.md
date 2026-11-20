# 05 — 最終検証（5本の実測・視聴・クレジット突合）

実施: 2026-11-17 23:07–23:32 (Asia/Tokyo)。実施者: 親セッション（fanout の t6 はディスパッチされず未実行のため代行）。
ビルドは 3 回: 初回（サイト11枚のみ）→ 音量補正（-14 LUFS）→ **実画面3枚を追加**。

## 1. 機械検証（実測）

コマンド: `node reel\build.mjs` → **exit code 0**、`reel\out\build-report.json` に各本の判定を保存。

| file | duration | 解像度 | fps | 映像 | 音声 | サイズ | カット数 |
|---|---|---|---|---|---|---|---|
| reel1.mp4 | 25.00s | 1080x1920 | 30 | H.264 High | AAC ステレオ | 5.1 MB | 8 |
| reel2.mp4 | 25.00s | 1080x1920 | 30 | H.264 High | AAC ステレオ | 4.9 MB | 9 |
| reel3.mp4 | 25.00s | 1080x1920 | 30 | H.264 High | AAC ステレオ | 4.8 MB | 12 |
| reel4.mp4 | 25.00s | 1080x1920 | 30 | H.264 High | AAC ステレオ | 5.3 MB | 6 |
| reel5.mp4 | 25.00s | 1080x1920 | 30 | H.264 High | AAC ステレオ | 5.3 MB | 8 |

音声は `loudnorm=I=-14:TP=-1.5:LRA=11` を適用（初回は平均 -23 dB と小さかった）。
`look_video` 実測: reel3 平均 **-17 dB / ピーク -1.5 dB**、reel1（再ビルド後）平均 -17 dB / ピーク -1.4 dB。

## 2. 視聴（look_video）

| file | 確認した時刻 | 所見 |
|---|---|---|
| reel1（初回） | 0:01 / 0:06 / 0:12 / 0:18 / 0:23 | 黒フレーム・停止なし、shot list と一致 |
| reel3 | 0:01 / 0:08 / 0:15 / 0:22 | 12カットの速い割り、位置ずれなし |
| reel1（実画面追加後） | 0:03 / 0:07 / 0:16 | 0:07 に PWA ヘッダ＋**100%**＋ステップ、0:16 にステップ7行＋結果＋最終更新。見切れ解消済み |

## 3. クレジット（CC BY 4.0 の条件）

`reel\out\CREDITS.txt` に 5 本分を記載。突合元は `reel\docs\02-music.md`（一次情報でバイト長照合済み）。

| reel | 曲 | 作者 | ライセンス | 出典 |
|---|---|---|---|---|
| reel1 | Carefree | Kevin MacLeod | CC BY 4.0 | incompetech.com |
| reel2 | Life of Riley | Kevin MacLeod | CC BY 4.0 | incompetech.com |
| reel3 | Monkeys Spinning Monkeys | Kevin MacLeod | CC BY 4.0 | incompetech.com |
| reel4 | Werq | Kevin MacLeod | CC BY 4.0 | incompetech.com |
| reel5 | Beach Party | Kevin MacLeod | CC BY 4.0 | incompetech.com |

4要素（タイトル / 作者 / ライセンス / URL）はすべて充足。

## 4. 依頼要件の判定

| 要件 | 判定 | 根拠 |
|---|---|---|
| 25秒 | 合格 | 5本すべて 25.00s |
| スマホ縦（9:16） | 合格 | 5本すべて 1080x1920 |
| 5本つくる | 合格 | reel1〜reel5 が実在 |
| フリー音源を必ず使う | 合格 | CC BY 4.0 の実ファイル6曲、生成音源は不使用 |
| 明るい曲の選定 | 一部合格 | BPM 実測と「明るい」根拠は 02-music.md にあるが、外部意見（Gemini 等）の一次取得はできていない |
| 実画面を多用 | 合格 | 全カットが実キャプチャ。内訳 = 公開サイト 11枚 + **実行中の mobile progress PWA 3枚**（04-screens.md） |
| カット割りに気を配る | 合格 | カット数 8/9/12/6/8。参照調査（01）の「長回しを1本残し他を刻む」に沿い reel4 に 5.0s の長回し |
| Instagram「Claude fable 5.2」参考 | 一部合格 | リール5本を実測（尺・カット数・ショット長）し型 P1〜P5 化。ただし "fable 5.2" 名指しの投稿は特定できていない |
| GitHub にサイト | 合格 | https://makochannel1234567890-boop.github.io/dsh-plugins/ が HTTP 200、main/gh-pages へ push 済み |

## 5. 残ギャップ（隠さず列挙）

1. **DSH 本体 GUI のスクショは無い**。`http://127.0.0.1:55901` は `dsh web authentication required` を返し、
   認証トークン付き URL をプロセス引数・環境変数から取得できなかった。実画面はプラグイン（PWA）側で代替した。
2. **テロップ（文字入れ）が無い**。画面内の文字はサイト/PWA 側のもののみ。音を消して見る層には情報が弱い。
3. **選曲の外部意見が一次取得できていない**。
4. `verify.mjs`（t4 の成果物）は未作成。検証は `build.mjs` 内の ffmpeg パース + `look_video` で代替した。
5. Instagram の「Claude fable 5.2」該当投稿は未特定。

## 6. 次に直すなら

- テロップは `drawtext`（Yu Gothic / Meiryo）で 3 秒ごとに 1 行追加。
- DSH 本体 GUI を撮るなら、`dsh web` を起動した端末の URL を控えてから `dsh_browser_open` に渡す（認証回避はしない）。
- `reel\out\CREDITS.txt` は投稿時に**説明欄へ全文を貼る**（CC BY 4.0 の条件）。

# 02 — BGM の確定（明るいフリー音源 6 曲・実測つき）

作業日: 2026-11-17。保存先: `reel\media\music\`（すべて実ファイル。生成・代替音源は使っていない）
計測器: `reel\tools\mp3info.mjs`（ID3/MPEG フレーム解析）、`reel\tools\bpm.mjs`（WASM デコーダで PCM 化 → オンセット自己相関で BPM）
生データ: `reel\docs\music-metrics.raw.jsonl`

---

## 1. ライセンス（一次情報で確定）

Kevin MacLeod の音楽は **Creative Commons — By Attribution 4.0（CC BY 4.0）**。
出典: <https://incompetech.com/music/royalty-free/licenses/>（"Creative Commons — Free / No charge. Requires that you credit the music."）
クレジット書式の原文（<https://incompetech.com/music/royalty-free/faq.html>）:

```
Title Kevin MacLeod (incompetech.com)
Licensed under Creative Commons: By Attribution 4.0
https://creativecommons.org/licenses/by/4.0/
```

- `Title` は**実際の曲名に置換**する（原文の指示）。
- クレジットは「見つけられる場所」に置く。動画なら**説明欄**が指定されている。
- 商用利用・収益化は可。ただし著作権は放棄されていない（"Is this music Copyright Free? No."）。

### そのまま使えるクレジット（動画説明欄に貼る）

```
Music by Kevin MacLeod (incompetech.com)
Licensed under Creative Commons: By Attribution 4.0 International (CC BY 4.0)
https://creativecommons.org/licenses/by/4.0/

"Carefree", "Life of Riley", "Monkeys Spinning Monkeys",
"Werq", "Fluffing a Duck", "Beach Party" — Kevin MacLeod (incompetech.com)
```

### 曲ごとの表記

| 曲 | クレジット行 |
|---|---|
| Carefree | "Carefree" Kevin MacLeod (incompetech.com) — CC BY 4.0 |
| Life of Riley | "Life of Riley" Kevin MacLeod (incompetech.com) — CC BY 4.0 |
| Monkeys Spinning Monkeys | "Monkeys Spinning Monkeys" Kevin MacLeod (incompetech.com) — CC BY 4.0 |
| Werq | "Werq" Kevin MacLeod (incompetech.com) — CC BY 4.0 |
| Fluffing a Duck | "Fluffing a Duck" Kevin MacLeod (incompetech.com) — CC BY 4.0 |
| Beach Party | "Beach Party" Kevin MacLeod (incompetech.com) — CC BY 4.0 |

---

## 2. ファイルと出典の検証（ここが今回いちばん重要）

公式の直リンクは `https://incompetech.com/music/royalty-free/mp3-royaltyfree/<曲名をURLエンコード>.mp3`。
**HEAD リクエストで返る `Content-Length` と、手元ファイルのバイト長を突き合わせた。**

| ファイル | 手元バイト数 | 公式 Content-Length | 判定 |
|---|---|---|---|
| km-carefree.mp3 | 6,566,713 | 6,566,713 | 一致（無改変の一次配布物） |
| km-life-of-riley.mp3 | 7,533,831 | 7,533,831 | 一致 |
| km-monkeys-spinning-monkeys.mp3 | 5,005,207 | 5,005,207 | 一致 |
| km-werq.mp3 | 5,195,810 | 5,195,810 | 一致 |
| km-fluffing-a-duck.mp3 | 2,696,840 | 2,696,840 | 一致 |
| km-beach-party.mp3 | **2,101,095** | 2,101,095 | 一致（**再取得後**） |

> ⚠ 修正した不具合: 前回の `km-beach-party.mp3` は **1,404,928 バイト**しかなく、公式（2,101,095）と不一致だった＝**途中で切れた不完全なファイル**（尺も 32.4 秒しかなかった）。公式 URL から取り直して置換済み。置換後は尺 49.8 秒・末尾の壊れなし。**他の 5 曲は再取得していない**（バイト長一致をもって同一配布物と判断）。

健全性チェック（`mp3info.mjs`）: 6 曲すべて先頭フレームから末尾まで連続して解析でき、`resyncs=0`、末尾の余剰バイト 0（＝切り詰めなし）。すべて CBR（192/256/320 kbps）。

---

## 3. 実測値

BPM は**音源を PCM にデコードして実測**したもの（Web の表記を写した値ではない）。`明るさ`列は高域エネルギー比（一次差分エネルギー ÷ 全エネルギー、0〜1）。値が大きいほど高域＝明るい音色寄り。客観指標であり主観評価の代用ではない。

| 曲 | 尺 | BPM | 1 小節 | 明るさ | 25 秒に使う区間 | その区間の小節頭（秒） |
|---|---|---|---|---|---|---|
| Beach Party | 49.8s | 109.9 | 2.184s | 0.0082 | **13.13 → 38.13** | 13.126, 15.31, 17.494, 19.677, 21.861, 24.045, 26.229, 28.413, 30.596, 32.78, 34.964, 37.148 |
| Carefree | 205.1s | 95.8 | 2.505s | 0.0252 | **78.23 → 103.23** | 78.231, 80.736, 83.241, 85.747, 88.252, 90.757, 93.262, 95.768, 98.273, 100.778 |
| Fluffing a Duck | 67.4s | 122.0 | 1.967s | 0.0108 | **3.96 → 28.96** | 3.956, 5.923, 7.89, 9.858, 11.825, 13.792, 15.759, 17.726, 19.694, 21.661, 23.628, 25.595, 27.563 |
| Life of Riley | 235.4s | 101.9 | 2.355s | 0.0232 | **125.06 → 150.06** | 125.06, 127.415, 129.771, 132.126, 134.481, 136.836, 139.192, 141.547, 143.902, 146.257, 148.613 |
| Monkeys Spinning Monkeys | 125.1s | 145.2 | 1.653s | 0.0029 | **87.64 → 112.64** | 87.638, 89.291, 90.944, 92.597, 94.25, 95.902, 97.555, 99.208, 100.861, 102.514, 104.167, 105.82, 107.473, 109.126, 110.778, 112.431 |
| Werq | 162.3s | 123.0 | 1.951s | 0.0514 | **123.04 → 148.04** | 123.043, 124.994, 126.945, 128.897, 130.848, 132.799, 134.75, 136.702, 138.653, 140.604, 142.555, 144.506, 146.458 |

（表の小節頭はすべて `reel\docs\music-metrics.raw.jsonl` からの転記。生データが正。）

「25 秒に使う区間」は **小節の頭から始まり、25 秒ちょうどで終わる**ように選んだもの（曲中で最もエネルギーが高い区間を自動選択）。頭出しは `ffmpeg -ss <秒> -t 25` 相当で切ればよい。

### BPM の裏取り
- Monkeys Spinning Monkeys: 実測 145.2。外部（Hooktheory / 各種 BPM サイト）でも 140 台とされており整合。他の曲も候補値（2 位以下）との差がはっきり出ているため、オクターブ誤りは起きていないと判断。
- 参照: <https://www.hooktheory.com/theorytab/view/kevin-macleod/monkeys-spinning-monkeys>、<https://getsongbpm.com/song/werq/ywK1Ow>

---

## 4. どの曲をどの動画に使うか（明るさの根拠つき）

| 動画 | 曲 | 理由（実測＋外部評価） |
|---|---|---|
| reel1 一覧系（テンポよく） | **Fluffing a Duck** | 122 BPM・小節 1.967 秒でカットを置きやすい。短い曲（67 秒）なので 25 秒の切り出しに無駄がない |
| reel2 長回しデモ | **Werq** | 高域比 0.0514 で 6 曲中もっとも明るい音色。123 BPM で 12 秒の実演にも合う |
| reel3 進捗バー | **Monkeys Spinning Monkeys** | 145 BPM と最速で「作業が進む」映像に合う。ネットミーム的に「明るい/コミカル」で定番（Hooktheory・Wikimedia Commons に音源ページあり） |
| reel4 ブラウザ操作 | **Beach Party** | 110 BPM で落ち着き、39.8 秒の短い曲なので扱いやすい。冒頭が明るい |
| reel5 ワンテイク締め | **Carefree** | 曲名どおりの明るいピアノ。95.8 BPM で 1 テイク映像に合う。長い（3:25）ので 78 秒地点＝盛り上がりを使う |
| 予備 | **Life of Riley** | 102 BPM。5 本で足りない場合や差し替え用 |

### 「明るい曲のセンス」をどう補ったか
- 外部の評判・用途の裏取りに web_search を使用（Reddit の生スレッドは検索結果に現れず、代わりに音源配布サイト・Hooktheory・YouTube Music の用途記述を参照）。具体的には「Carefree = 明るいピアノ」「Monkeys Spinning Monkeys = コミカル/定番」という用途記述と、収益化 OK の二次配布サイト <https://www.free-stock-music.com/kevin-macleod-carefree.html> を確認。
- 客観側は**高域エネルギー比**（表の「明るさ」）で補強した。
- **Gemini や掲示板への直接問い合わせはしていない**（ツール制約）。上記は web_search 経由の二次情報である。

---

## 5. ライセンス遵守チェックリスト（公開前に必ず）

- [ ] 動画の説明欄に §1 のクレジット全文を入れる（5 本それぞれ）
- [ ] サイト（GitHub Pages）のフッターにも 1 行でよいのでクレジットを置く
- [ ] 曲名を実際の曲名に置換したか確認（`Title` のままにしない）
- [ ] CC BY 4.0 のリンク（https://creativecommons.org/licenses/by/4.0/）を併記
- [ ] 音源ファイルは再配布しない（`reel/media/music/*.mp3` を**リポジトリにコミットしない**）

> 最後の項目は重要。CC BY は「音源を自由に再配布してよい」ライセンスではない。公開リポジトリに mp3 を置くと、サイト公開＝音源の再配布になってしまう。`.gitignore` に `reel/media/music/` を入れるか、LFS ではなく**配信物からは除外**すること。

---

## 6. attempt 3（t1-a3）での再検証と、外部意見の出典

### 6.1 再検証（2026-11-17 22:33 JST・一次サーバー応答を再取得）

| 確認 | 方法 | 結果 |
|---|---|---|
| 実ファイル 6 曲 | `node reel\tools\mp3info.mjs <6 files>` | 6/6 解析成功。`resyncs=0` / `trailingBytes=0`。尺 = 0:49 / 3:25 / 1:07 / 3:55 / 2:05 / 2:42（49.82 / 205.14 / 67.37 / 235.36 / 125.07 / 162.30 秒） |
| 500KB 超 | `Get-ChildItem reel\media\music\*.mp3` | 6/6 が 512,000 バイト超（最小 Beach Party 2,101,095） |
| 公式配布物との同一性 | `Invoke-WebRequest -Method Head https://incompetech.com/music/royalty-free/mp3-royaltyfree/<曲名>.mp3` ×6 | すべて **200**。Content-Length が **6/6 で手元と一致**（6,566,713 / 7,533,831 / 5,005,207 / 5,195,810 / 2,696,840 / 2,101,095） |
| 25 秒区間の整合 | `reel\docs\music-metrics.raw.jsonl` を機械計算 | 6/6 で `best25.end - best25.start = 25.000` 秒。区間末尾は全て曲尺内（例: Werq 148.043 < 162.30、Monkeys 112.638 < 125.07） |
| git 未無視 | `git check-ignore -v reel\media\music\km-carefree.mp3` | **exit 1（未無視）**。公開前に `.gitignore` へ `reel/media/music/` が必要 |

> 6 曲は「落としただけで未検証」ではなく、**2026-11-17 時点の公式サーバー応答とバイト単位で一致**した。attempt 2 の表と同じ結果を独自に再取得しており、転記ミスは無い（差はゼロ）。

### 6.2 「明るい曲」の外部意見（web_search を再実行して得た URL）

本文は読まず、**見出し・URL の水準**での確認に留める（`web_fetch` は 30 秒でタイムアウトした）。

| 曲 | 外部の材料 | 何を裏づけるか |
|---|---|---|
| Monkeys Spinning Monkeys | [How a catchy tune became the soundtrack to TikTok's silliest videos（WJAB, 2024-09-25）](https://www.wjab.org/2024-09-25/how-a-catchy-tune-became-the-soundtrack-to-tiktoks-silliest-videos) | 「耳に残る曲」が「TikTok のおかしな動画の定番」になったという**用途の実績**（本文未読・見出しのみ） |
| Monkeys Spinning Monkeys | [Wikimedia Commons の音源ページ](https://commons.wikimedia.org/wiki/File:Kevin_MacLeod_~_Monkeys_Spinning_Monkeys.ogg) | 同曲が自由ライセンス音源として広く流通していること |
| Carefree | [free-stock-music.com の配布ページ](https://www.free-stock-music.com/kevin-macleod-carefree.html) / [incompetech の曲ページ](https://incompetech.com/music/royalty-free/index.html?isrc=USUAN1400037) | 第三者が「収益化可のフリー音源」として配布・紹介していること（曲調の主張ではない） |

**明るさの根拠は 3 層に分けて持つ**（外部意見だけに依存しない）:

1. 客観: 高域エネルギー比（§3）の実測順 `Werq 0.0514 > Carefree 0.0252 > Life of Riley 0.0232 > Fluffing a Duck 0.0108 > Beach Party 0.0082 > Monkeys 0.0029`。
2. 用途の実績: Monkeys はコミカル用途の定番（上表）。Werq / Beach Party / Fluffing a Duck は Kevin MacLeod の軽快系として広く使われている。
3. 設計都合: BPM と小節長（§3）が 25 秒のカット割りに合うか。reel3 で最も速い Monkeys を選ぶのはこの層の理由。

**弱点として残す**: Reddit の生スレッドは検索結果に現れず、Gemini への直接照会もしていない（ツール制約）。「明るい曲のセンス」の外部裏取りは**記事・配布ページ・利用実績の見出しレベル**までで、曲を実際に聴いた主観評価ではない。差し替えたい場合は §3 の 6 曲から選び直せる（ライセンスは全曲同一）。

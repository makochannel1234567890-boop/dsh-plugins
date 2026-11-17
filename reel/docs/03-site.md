# 03 — GitHub 用の紹介サイト（reel/site）と実画面スクショ

作成日: 2026-11-17 / 担当: t2
作業場所: `C:\Users\user\Desktop\ローカル実験\dsh-plugins`

## 1. 何を作ったか

このリポジトリに DSH（DeepSeek Harness）用プラグインを置いている、という紹介サイト。
リールにそのまま切り出せるよう、**1 セクション = 1 画面**（スクロールスナップ）で、
縦型（9:16）にクロップしても文字が欠けない設計にしている。公開時は通常のレスポンシブ。

| ファイル | 役割 |
| --- | --- |
| `reel/site/index.html` | 本体。12 スライド（hero / 一覧 / 個別カード 7 / 原文 / 使い方） |
| `reel/site/style.css` | スタイル。`:root` の色トークンと、vh 基準のタイポ |
| `reel/site/serve.mjs` | 依存なしの静的サーバ。既定ポート 4321 |
| `reel/site/.nojekyll` | GitHub Pages で Jekyll 処理を止めるための空ファイル |

スライド id（撮影時の `?reel=` に使う）:
`hero`, `list`, `p1`…`p7`（各プラグイン）, `source`, `install`。

## 2. 載せた 7 プラグインと、その事実の出典

名前・バージョン・説明は **各ディレクトリの `package.json` の `description` を一次情報**とし、
日本語のリード文はその要約（誇張なし）。

| # | プラグイン | version | 出典 |
| --- | --- | --- | --- |
| 01 | `dsh-fanout` | 0.3.0 | `dsh-fanout/package.json` |
| 02 | `dsh-browser-agent` | 1.0.1 | `dsh-browser-agent/package.json` |
| 03 | `dsh-mobile-progress` | 0.3.0（name は `@local/dsh-mobile-progress`） | `dsh-mobile-progress/package.json` |
| 04 | `dsh-deliberation` | 0.1.0 | `dsh-deliberation/package.json` |
| 05 | `dsh-emulator-lab` | 0.1.0 | `dsh-emulator-lab/package.json` |
| 06 | `dsh-social-desktop-agent` | 0.1.0 | `dsh-social-desktop-agent/package.json` |
| 07 | `dsh-builtin-browser-localfix` | package.json なし | `README.md` の見出しと冒頭説明 |

`dsh-builtin-browser-localfix` はパッチ配布で `package.json` が無いため、サイト上でも
「package.json なし（パッチ配布）」と明記し、原文スライドには README 由来であることを書いた。
`dsh-browser-agent` は `.gitignore` により repo に未収録（第三者 MIT 作品のクローン）なので、
サイトの bullets にもその旨を残している。

## 3. ローカル HTTP 配信（実測）

```powershell
node reel\site\serve.mjs          # 127.0.0.1:4321 固定（PORT で変更可）
```

確認した結果（2026-11-17 21:48 時点、実際に叩いた値）:

- `GET /` → **200**、12416 bytes（UTF-8）
- `GET /style.css` → **200**、9478 bytes
- `GET /` の HTML 内に 7 プラグイン名がすべて出現:
  `dsh-fanout`×4 / `dsh-browser-agent`×4 / `dsh-mobile-progress`×5 /
  `dsh-deliberation`×4 / `dsh-emulator-lab`×4 / `dsh-social-desktop-agent`×4 /
  `dsh-builtin-browser-localfix`×3

## 4. スクリーンショットの撮り方（再現手順）

ビューポートが 1388x508（横長）のため、そのままでは 9:16 にならない。
`index.html` に**撮影専用モード** `?reel=<番号|id>` を入れてあり、このモードでは

- `#deck` を 540x960 のキャンバスにして `zoom: 2` で描画 → CSS 上は 1080x1920
- `.slide` は 960px 固定、`transform: translateY()` で 1 枚ずつ送る
- 公開時の見た目には一切影響しない（クエリ無しなら通常表示）

手順（実際にやったこと）:

1. `node reel\site\serve.mjs` を起動
2. ブラウザで `http://127.0.0.1:4321/?reel=hero` を開く
3. 各スライドへは `window.__reel(n)` で切替（`n` は 0 始まりのスライド番号）
4. フルページ・スクショを取得 → 3352x4637 px（= 1388x1920 CSS px × DPR 2.415）
5. 左 2608 px（= 1080 CSS px）を切り出し、1080x1920 へ縮小して PNG 保存

切り出し・縮小は Windows 同梱の System.Drawing で行った（ffmpeg は PATH に無い）:

```powershell
Add-Type -AssemblyName System.Drawing
$img  = [System.Drawing.Image]::FromFile('C:\Users\user\Downloads\reel-raw\03-dsh-fanout.png')
$cropW = [int][Math]::Round(1080 * ($img.Height / 1920))   # → 2608
$bmp  = New-Object System.Drawing.Bitmap 1080,1920
$g    = [System.Drawing.Graphics]::FromImage($bmp)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.DrawImage($img,
  (New-Object System.Drawing.Rectangle 0,0,1080,1920),
  (New-Object System.Drawing.Rectangle 0,0,$cropW,$img.Height),
  [System.Drawing.GraphicsUnit]::Pixel)
$g.Dispose()
$bmp.Save('reel\media\site\03-dsh-fanout.png', [System.Drawing.Imaging.ImageFormat]::Png)
```

> ブラウザの保存先は `C:\Users\user\Downloads` 配下に限定されているため、
> 生スクショは Downloads に保存してから加工・コピーしている。

## 5. 保存したスクショ（11 枚 / すべて 1080x1920）

`reel/media/site/` に実在（サイズは保存時の実測値）:

| ファイル | 内容 | サイズ |
| --- | --- | --- |
| `01-hero.png` | ヒーロー「プラグイン置き場」 | 300 KiB |
| `02-list.png` | 7 プラグイン一覧 | 330 KiB |
| `03-dsh-fanout.png` | dsh-fanout カード | 395 KiB |
| `04-dsh-browser-agent.png` | dsh-browser-agent カード | 375 KiB |
| `05-dsh-mobile-progress.png` | dsh-mobile-progress カード | 407 KiB |
| `06-dsh-deliberation.png` | dsh-deliberation カード | 359 KiB |
| `07-dsh-emulator-lab.png` | dsh-emulator-lab カード | 378 KiB |
| `08-dsh-social-desktop-agent.png` | dsh-social-desktop-agent カード | 406 KiB |
| `09-dsh-builtin-browser-localfix.png` | localfix カード | 420 KiB |
| `10-install.png` | 使い方（クローン手順） | 337 KiB |
| `11-source.png` | package.json description 原文 | 692 KiB |

リールでは 01→02→03…10 の順で使うと「何のサイトか → 7 つ並ぶ → 1 つずつ紹介 → 導入」になる。
11 は文字が細かいので、原文を一瞬見せるカット向け。

## 6. GitHub への公開（結果）

- サイト本体とスクショを `main` にコミットした（このドキュメント末尾の記録を参照）
- `git push` の成否は本ファイル末尾に**そのまま**書く（失敗したら失敗内容を残す）
- GitHub Pages の有効化は repo settings が必要なので `docs/GITHUB-SETUP.md` に手順を書いた
  （推奨は `gh-pages` ブランチ配信。サイトのソースを二重に持たないため）

### push の記録（実際の出力）

実行は 2026-11-17 21:51〜21:52、`GIT_TERMINAL_PROMPT=0` / `GCM_INTERACTIVE=Never` で対話待ちを止めて実行。
Windows 資格情報マネージャに保存済みの GitHub 資格情報がそのまま使われ、**どちらも成功**した。

1) `main` へのコミット＆push

```
$ git commit -m "docs(reel): add GitHub Pages site and 1080x1920 screenshots"
[main fb0314a] docs(reel): add GitHub Pages site and 1080x1920 screenshots
 17 files changed, ...

$ git push origin main
To https://github.com/makochannel1234567890-boop/dsh-plugins.git
   62162df..fb0314a  main -> main
EXIT=0
```

→ リポジトリの `main` に、サイト本体（4 ファイル）・スクショ 11 枚・このドキュメントが入った。

2) `gh-pages` ブランチへの配信（サイトの中身だけをルートに置く）

```
$ git subtree push --prefix=reel/site origin gh-pages
git push using:  origin gh-pages
To https://github.com/makochannel1234567890-boop/dsh-plugins.git
 * [new branch]      0e132977e321253ccc91ed0f2a287354ceb83143 -> gh-pages
EXIT=0
```

`gh-pages` の中身を確認:

```
$ git ls-tree -r --name-only 0e132977e321253ccc91ed0f2a287354ceb83143
.nojekyll
index.html
serve.mjs
style.css
```

→ **Pages の配信元（`gh-pages` / `(root)`）はもう用意できている。**
残るのは GitHub の画面で Settings → Pages を有効化する操作だけで、
その手順は `docs/GITHUB-SETUP.md` の「3. GitHub の画面で Pages を有効化する」。

3) 公開 URL の現状（有効化前なので 404）

```
$ Invoke-WebRequest https://makochannel1234567890-boop.github.io/dsh-plugins/
404 Not Found
```

→ これは想定どおり（Pages 未設定）。設定後に 200 と 7 プラグイン名が出れば公開成功。

> サイトを更新したら `git subtree push --prefix=reel/site origin gh-pages` をもう一度実行する。

---

## 7. 再検証（2026-11-17 22:26〜22:29 / DSH 再起動後の別セッションで実測）

ホストが再起動してセッションが切れたため、残した成果物が「いまの `index.html` / `style.css` の
描画と一致しているか」を撮り直して確かめた。測った値は以下のとおり。

- `node reel\site\serve.mjs` を起動 → `GET /` は **200 / 12416 bytes / text/html; charset=utf-8**、
  `GET /style.css` は **200**（2 回目の起動でも同じ）
- HTML 内の出現数: `dsh-fanout`×4 / `dsh-browser-agent`×4 / `dsh-mobile-progress`×5 /
  `dsh-deliberation`×4 / `dsh-emulator-lab`×4 / `dsh-social-desktop-agent`×4 /
  `dsh-builtin-browser-localfix`×3、および 7 つぶんの `description` 引用がすべて含まれる
- `?reel=hero` をブラウザで開いたときの実測: `#deck` の描画サイズ **1079.99 x 1919.99 CSS px**
  （`getBoundingClientRect`）、スライド数 **11**、`title` は `reel 0 — hero`
- フルページ・スクショは **3352x4637 px** → 左 **2608 px** を切り出し → **1080x1920** に縮小
- 撮り直した `01-hero.png` と、コミット済み `reel/media/site/01-hero.png` の画素差は
  **MAD 0.57 / 255（42,625 点サンプル、最大 104）** = 実質同一。つまり保存済みスクショは
  現在のサイトの描画そのもの
- `git ls-remote --heads origin` → `refs/heads/main = fc8ce72`、`refs/heads/gh-pages = 0e13297`
  （push 済みであることをローカルからではなくリモート側で確認）
- `https://makochannel1234567890-boop.github.io/dsh-plugins/` を 22:30 に叩いた結果は
  **200 / 12416 bytes**、本文に `dsh-emulator-lab` を含む → **GitHub Pages は有効化済みで、
  このサイトはもう公開されている**（上の 6-3) に残る 404 は Pages 設定前の記録）


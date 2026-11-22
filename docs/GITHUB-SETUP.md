# GitHub Pages でサイトを公開する手順（このリポジトリ用）

> **2026-11-17 22:30 の実測: Pages は有効化済みで、すでに公開されている。**
> `https://makochannel1234567890-boop.github.io/dsh-plugins/` → **200 / 12416 bytes**、
> 本文に 7 プラグイン名を含む。`git ls-remote --heads origin`（22:46 時点）は
> `main = 9f7152c` / `gh-pages = 0e13297`。
> この手順は、Pages を作り直すとき・同じ構成を別リポジトリへ移すときのために残す。
> 状態確認だけしたいときは **4 のコマンド**を実行すればよい。

対象: `https://github.com/makochannel1234567890-boop/dsh-plugins`
公開したいもの: `reel/site/`（DSH 用プラグイン置き場の紹介サイト。静的 HTML/CSS のみ）

このマシンで確認済みの前提（2026-11-17 時点）:

- `git version 2.55.0.windows.2`、`credential.helper=manager`（Git Credential Manager）
- `gh` は**未導入**（GitHub CLI は使わない。全部ブラウザの画面操作＋git で行う）
- `git subtree` は同梱されている（`<git>/mingw64/libexec/git-core/git-subtree`、25817 bytes）
- ブランチは `main`、リモートは `origin`

---

## 0. 先にローカルで表示を確認する

```powershell
cd C:\Users\user\Desktop\ローカル実験\dsh-plugins
node reel\site\serve.mjs
```

→ ブラウザで `http://127.0.0.1:4321/` を開く（別ターミナルで作業する場合はそのまま）。
7 プラグインの名前が出ていれば OK。止めるときは `Ctrl+C`。

---

## 1. サイトを `main` にコミットする

```powershell
cd C:\Users\user\Desktop\ローカル実験\dsh-plugins
git add reel\site reel\media\site reel\docs
git commit -m "docs(reel): add GitHub Pages site and 1080x1920 screenshots"
```

`git status` で `reel/site/` と `reel/media/site/*.png` が staged になっていることを確認する。

---

## 2. `gh-pages` ブランチにサイトを配信する（推奨・ソースを二重に持たない）

`reel/site/` の中身だけを、そのまま `gh-pages` ブランチの**ルート**として push する。

> **2026-11-17 時点の状態: この配信は実行済みで成功している。**
> `gh-pages` = `0e132977e321253ccc91ed0f2a287354ceb83143`、中身は `.nojekyll` / `index.html` /
> `serve.mjs` / `style.css`（`git ls-tree -r --name-only origin/gh-pages` で確認できる）。
> `main` への push も成功済み（`62162df..fb0314a`）。
> **追記（2026-11-17 22:30 に再実測）**: 公開 URL `https://makochannel1234567890-boop.github.io/dsh-plugins/` が
> HTTP **200**（12416 bytes、本文に `dsh-emulator-lab` を含む）を返した。つまり **3 の Pages 有効化も完了済み**。
> 未確認なのは Settings → Pages の Source / Branch の**現在値**だけ（`gh` が無いため画面を見ないと確定できない）。
> サイトを更新したときだけ、この節をもう一度実行する。

```powershell
git subtree push --prefix=reel/site origin gh-pages
```

- 初回は Git Credential Manager のダイアログが出る → **GitHub にサインイン**する。
  ここで入力した認証情報は Windows 資格情報マネージャに保存される。
  **トークンやパスワードをチャット・ログ・issue に貼らないこと。**
- 成功すると `refs/heads/gh-pages` ができる。確認:

```powershell
git ls-remote --heads origin gh-pages
```

- `git subtree` が見つからないと言われた場合の代替（一時 worktree を使う）:

```powershell
$tmp = "$env:TEMP\dsh-plugins-gh-pages"
git worktree add -b gh-pages $tmp
Push-Location $tmp
git rm -r -q . ; git checkout -q -- . 2>$null   # 念のため
# git rm -r . で全削除した後、site の中身だけを置く
Copy-Item -Recurse -Force "C:\Users\user\Desktop\ローカル実験\dsh-plugins\reel\site\*" .
git add -A
git commit -m "deploy: site from reel/site"
git push origin gh-pages
Pop-Location
git worktree remove $tmp
```

> 補足: `gh-pages` ブランチには `reel/site/` の**中身だけ**が入る（`index.html` / `style.css` /
> `.nojekyll`）。サイトから `../reel/...` を参照していないので、これで表示できる。

---

## 3. GitHub の画面で Pages を有効化する

1. ブラウザで `https://github.com/makochannel1234567890-boop/dsh-plugins` を開く
2. 上部の **Settings** タブ
3. 左メニューの **Pages**
4. **Build and deployment** → Source: **Deploy from a branch**
5. **Branch**: `gh-pages` を選ぶ / フォルダは **`/(root)`** のまま
6. **Save**
7. `Actions` タブ（または Pages の画面）で "pages build and deployment" が緑になるまで 1〜3 分待つ
8. 公開 URL: **https://makochannel1234567890-boop.github.io/dsh-plugins/**

> 独自ドメインは使わない（`*.github.io` のまま）。

---

## 4. 公開されたか確認する

```powershell
$u = 'https://makochannel1234567890-boop.github.io/dsh-plugins/'
$r = Invoke-WebRequest -Uri $u -UseBasicParsing -TimeoutSec 20
$r.StatusCode                      # → 200 を期待
$r.Content -match 'dsh-emulator-lab'   # → True を期待
($r.Content | Select-String -Pattern 'dsh-mobile-progress|dsh-deliberation|dsh-emulator-lab|dsh-social-desktop-agent|dsh-builtin-browser-localfix' -AllMatches).Matches.Count
```

5 つとも出ていれば公開成功。スマホでも同じ URL を開いて縦長で読めることを確認する。

---

## 5. サイトを更新したとき

```powershell
# reel\site\ を編集してから
git add reel\site
git commit -m "site: update ..."
git push origin main
git subtree push --prefix=reel/site origin gh-pages
```

`gh-pages` が更新されると Pages が自動で再ビルドする（1〜3 分）。
`reel/media/site/*.png`（リール用スクショ）は Pages には不要なので、`main` に置くだけでよい。

---

## 6. 代替案: `docs/` フォルダで配信する（設定だけで完結）

`git subtree` を使わず、Settings だけで済ませたい場合:

```powershell
# reel\site の中身を docs のルートへコピー（.nojekyll も忘れずに）
Copy-Item -Recurse -Force reel\site\* docs\
git add docs
git commit -m "docs: publish site from docs/"
git push origin main
```

Pages の設定を **Source: Deploy from a branch / Branch: `main` / フォルダ: `/docs`** にする。
この場合、`reel/site` と `docs/` の**二重管理**になるので、更新時は両方そろえること。
（推奨は 2 の `gh-pages` 方式。）

---

## 7. つまずいたとき

| 症状 | 原因 / 対処 |
| --- | --- |
| 404 が続く | Pages のビルドが未完了（1〜3 分待つ）。`gh-pages` のルートに `index.html` があるか `git ls-tree origin/gh-pages --name-only` で確認 |
| 404（ファイルはある） | `.nojekyll` が無いと Jekyll が `_` 始まりを無視する。`reel/site/.nojekyll` がコミットされているか確認 |
| `git subtree` が見つからない | `git --exec-path` に `git-subtree` が無い Git を使っている。2 の worktree 方式に切り替える |
| push で `Authentication failed` | Git Credential Manager の資格情報が無効。Windows の「資格情報マネージャー」→ Windows 資格情報 → `git:https://github.com` を削除して再実行し、ダイアログでサインイン |
| `Permission denied` / 403 | そのアカウントに `makochannel1234567890-boop/dsh-plugins` への push 権限が無い |
| push が何も表示せず止まる | 対話入力待ち。`$env:GIT_TERMINAL_PROMPT=0` を付けて実行するとエラーとして返る（自動化時はこちら） |

> 認証情報（トークン）をこのリポジトリやドキュメントに書かない。

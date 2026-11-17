# dsh-mobile-progress — スマホ進捗フィード設計メモ

エージェントの進捗を、スマホの 1 画面で「進捗バー + ステップ」として見るための
Host プラグインです。`todo_write` を自動でミラーし、モデルは節目で
`progress_update` を呼びます。

v0.2.0 で **PWA 化・公開 HTTPS URL（cloudflared トンネル）・スリープ抑止**を追加しました。

---

## 1. 体験

```
┌──────────────────────────────┐
│ DSH Progress        ● ライブ │
│ 作業中        ログイン画面の改修 │
│                              │
│ 64%                    ● 実行中│
│ ███████████░░░░░░░░░░░        │
│ バリデーションを実装中         │
│                              │
│ いまの依頼                    │
│ ログインフォームの…            │
│                              │
│ ステップ 4                    │
│ ✓ 現状のフォームを調査         │
│ ◉ バリデーションを実装         │
│ ○ テストを追加                │
│                              │
│ 最終更新 3秒前 / ターン 2 / ツール 41 │
└──────────────────────────────┘
```

- 数字が読めなくてもバーの長さで分かる。
- ステップは「完了 / 進行中 / 待機」の 3 状態。
- SSE で更新。切れたら自動再接続 + 8 秒ポーリング。
- ホーム画面に追加するとブラウザ枠なしで起動する（本物の PWA）。
- 同じ Wi-Fi にいなくても、モバイル回線から HTTPS で見られる。
- PC がスリープで落ちないよう、プラグインが稼働中だけ抑止する。

---

## 2. アーキテクチャ

```
 session/event (read-only)            todo_write の引数
        │                                    │
        ▼                                    ▼
 ┌──────────────────────────────────────────────┐
 │ Host plugin: fold → state (derived cache)     │
 │  - turn/start・turn/end・tool/call            │
 │  - user/message（依頼文。注入文は除外）        │
 │  - progress_update（明示更新）                │
 └───────┬──────────────────────────┬───────────┘
         │ SSE /api/stream          │ spawn
         ▼                          ▼
  phone:                          cloudflared  → https://<random>.trycloudflare.com
   - 同一 Wi-Fi : http://<LAN IP>:8790/?k=…     python は不要。外向き接続のみ
   - 外から     : 上記の HTTPS URL             keep-awake ヘルパー（スリープ抑止）
```

- 独自 HTTP サーバーを `0.0.0.0:8790` で listen します（DSH の Web UI は
  `127.0.0.1` のみで、スマホから届かないため）。
- トンネルは**外向き**接続なので、スマホ側は同じ Wi-Fi である必要がなく、
  Windows ファイアウォールの受信許可も要りません（LAN 直は依然として必要）。
- 状態は `~/.dsh/storages/mobile-progress/state.json` に保存し、再起動後は
  最後の状態を `stale` 付きで表示します。
- セッションログには何も書き込みません（replay / fork 互換）。

### 進捗率

| 入力 | 計算 |
|---|---|
| `steps` がある | done=1、in_progress=0.5 の平均を 0–100 に丸め |
| `percent` がある | その値（ステップより優先） |
| どちらも無い | `null`（画面は不定形バー） |
| `status: "done"` | 100% に固定 |

`todo_write` が呼ばれるとステップと % を自動更新します。手動の `percent` は
ステップで表現できないときだけ使う想定です。

---

## 3. HTTP API と認証

| パス | 認証 | 内容 |
|---|---|---|
| `/` | — | モバイル UI（HTML） |
| `/style.css` `/app.js` `/sw.js` `/icon*` `/manifest.webmanifest` | — | PWA アセット |
| `/api/state` | **token** | 現在の JSON 状態 |
| `/api/stream` | **token** | SSE。変更ごとに `data: {...}`、15 秒ごとに heartbeat |
| `/healthz` | — | 死活監視 |

`accessToken` を設定した場合、API は `?k=<token>` か `x-progress-token` が必要です。

### なぜシェルは認証しないのか（重要）

最初は全パスにトークンを要求する実装でしたが、**画面自体が壊れました**。
`<script src="/app.js">` や `<link href="/style.css">` はページのクエリ文字列を
引き継がないので、`/?k=…` で開いても `/app.js` はトークン無しで要求され 401 に
なります（ブラウザ実測: `document.scripts[0].src` に `?k=` が無い）。

そこで **データだけを守る**方針にしました。シェルには進捗データが入っていないため、
公開しても情報は漏れません。API は 401 を返し、画面は
「アクセストークンが必要です」と案内します。

`/manifest.webmanifest` だけは動的生成で、`start_url` と shortcuts に `?k=` を
埋め込みます。これをしないと、ホーム画面から起動した瞬間に 401 になります。

---

## 4. 設定

```yaml
- insert:
    - id: mobile-progress
      name: '@local/dsh-mobile-progress'
      config:
        enabled: true
        port: 8790
        host: '0.0.0.0'       # '127.0.0.1' で PC 内のみ
        accessToken: ''       # 空 + トンネル時は自動生成し保存
        title: 'DSH Progress'
        autoClaim: true
        persist: true
        tunnel:
          enabled: true
          provider: 'cloudflared'
          mode: 'quick'        # quick / named / custom
          autoDownload: true
          requireToken: true
        keepAwake:
          enabled: true
          keepDisplayOn: false
```

| キー | 既定 | 意味 |
|---|---|---|
| `enabled` | true | false ならサーバーを立てない |
| `port` | 8790 | 使用中なら +1 ずつ空きを探す |
| `host` | 0.0.0.0 | LAN 公開 / ローカルの切替 |
| `accessToken` | '' | 簡易トークン（空＋トンネル時は自動生成して永続化） |
| `title` | DSH Progress | 画面タイトル |
| `autoClaim` | true | 最初に動いたルートセッションを追跡 |
| `persist` | true | 状態を JSON 保存 |
| `maxLogs` | 40 | 保持ログ行数 |
| `tunnel.enabled` | true | 公開 HTTPS URL を張る |
| `tunnel.mode` | quick | quick / named / custom |
| `tunnel.token` | '' | named の Tunnel トークン |
| `tunnel.publicHostname` | '' | named で表示するホスト名 |
| `tunnel.command` | '' | custom のコマンド（`{port}` / `{url}` 置換） |
| `tunnel.binaryPath` | '' | 既存 cloudflared の指定 |
| `tunnel.autoDownload` | true | 無ければ GitHub Releases から取得 |
| `tunnel.requireToken` | true | 公開時のトークン必須 |
| `tunnel.maxRestarts` | 20 | 落ちたときの再起動回数 |
| `keepAwake.enabled` | true | スリープ抑止 |
| `keepAwake.keepDisplayOn` | false | 画面も点けたままにする |

`tunnel: false` / `keepAwake: false` の短縮形も受け付けます。

---

## 5. スマホで開く

1. `progress_status` が `phone_url`（LAN）と `public_url`（トンネル）を返す。
2. スマホで公開 URL を開く（初回は cloudflared 取得で 1〜2 分）。
3. Safari: 共有 → ホーム画面に追加 / Chrome: メニュー → アプリをインストール。
4. 以後はホーム画面から。オフラインでも直前の状態を表示する。

### Windows ファイアウォール

同一 Wi-Fi の LAN 直アクセスだけが必要です（トンネルは外向きなので不要）。

```powershell
New-NetFirewallRule -DisplayName "DSH Mobile Progress" -Direction Inbound `
  -Action Allow -Protocol TCP -LocalPort 8790 -Profile Private
```

#### この PC の実測（2026-11-16/17）

- Wi-Fi `MLO`（InterfaceAlias: `Wi-Fi 2`）は**パブリック**判定。
- プラグインの Host プロセスは `DeepSeek Harness.exe` なので Public が Block。
  LAN 直で使うには Wi-Fi を Private にするか、受信 Allow ルールを足す。
- **公開 URL 経由なら、この制約は関係ありません。** 外向き接続のみのため。

### つながらないとき

- `530` … トンネル未接続/切断。`state.server.tunnel.status` を見て数十秒待つ。
- `401` … `?k=` が無い。
- `000`（起動直後のみ）… クイックトンネル作成直後のエッジ未反映。少し待つ。
- 学内 Wi-Fi 等のクライアント分離 … 公開 URL を使えば回避できる。

---

## 6. プライバシーと制限

- 画面に出すのは **依頼文・ステップ・短いログ・カウンタ** のみ。
  アシスタント本文、ツール引数、ファイル内容は保存・配信しません。
  `todo_write` のステップ文字列だけは例外です。
- シェル（HTML/CSS/JS）は認証しません。データは `/api/*` のトークンで守ります。
- 公開 URL は「URL を知っていれば」届きます。トークン付き URL を共有しないでください。
- 進捗は**派生キャッシュ**です。正確な真実はセッションログ側にあります。
- クイックトンネルは再起動ごとに URL が変わります（named で固定可能）。

---

## 7. このプロファイルでの状態と有効化

- `@local/dsh-mobile-progress` は **インストール済み・有効化済み**
  （`install_bundle` → `set_bundle` とも `application: applied`）。
- 過去の HMR ロック（`HMR transactions cannot be nested`）は再起動で解消し、
  現在は `progress_update` / `progress_status` ツールと 8790 のサーバーが動作中。
- 起動時に tunnel / keep-awake を各自スポーンし、`dispose` でツリーごと停止します。

---

## 8. 開発用サイドカー（Host を触らずに確認）

```powershell
# dsh-mobile-progress フォルダで
$env:DSH_MP_TUNNEL='1'       # トンネルも張る（cloudflared を実取得）
$env:DSH_MP_KEEPAWAKE='1'    # スリープ抑止も動かす
$env:DSH_MP_PORT='8790'
node dev/sidecar.mjs
```

- `DSH_SESSION_ID` から `~/.dsh/sessions/**/session.v4.jsonl.zstd` を探し、
  zstd フレームを分割して `session/event` を再生します。
- サーバーは本番と同じコード・同じ `public/` を配信します。
- 保存は無効（`persist: false`）。トークンは本番と同じファイルを使うため URL の形が同じです。
- サイドカーを止めても cloudflared が残ることがあるので、`Get-Process cloudflared` を確認します。

---

## 9. テスト

```powershell
node --check index.js
node --check lib/tunnel.js
node --check public/app.js
node --check public/sw.js
node --test            # 20 tests（state 9 + tunnel 11）
```

- `percentFromSteps` / `normalizeSteps` / `cleanUserRequest` / `buildUrls` などの純粋関数。
- `lib/tunnel.js`: `resolveTunnelConfig` / `tunnelArgs` / `tokenizeCommand` /
  `findPublicUrl`（ベンダー案内リンクを拾わないこと）/ `withToken` / `releaseAsset` /
  `findOnPath` / `locateCloudflared` / `keepAwakeSpawn` / `keepAwakeScript`。
- HTTP・SSE・PWA はサイドカーを起動し、実ブラウザと `curl` で確認（下記 §11）。

---

## 10. 既知の課題

- **クイックトンネルの URL が毎回変わる。** ホーム画面のアイコンは作り直しになる。
  固定したい場合は named トンネル（Cloudflare アカウント + ドメイン）にする。
- Cloudflare 無料クイックトンネルは可用性保証なし。落ちたら最大 20 回まで再接続。
- `cloudflared` の自動取得は Windows / Linux（x64・arm64）のみ。macOS は手動導入。
- 複数ルートセッションの同時追跡は未対応（`autoClaim` で 1 つ）。
- 依頼文の抽出はヒューリスティック。新しい注入文が増えたら
  `SYNTHETIC_USER_MARKERS` に追記する。
- `SetThreadExecutionState` は「ふたを閉じたらスリープ」までは防げない（電源設定側）。
- `powercfg /requests` は管理者権限が必要なので、keep-awake の効果は
  ヘルパー生存でのみ確認している。

---

## 11. 検証ログ（2026-11-17 / この PC）

| 対象 | 方法 | 結果 |
|---|---|---|
| 公開 URL の疎通 | `curl` 経由 | `/` `/healthz` `/api/state` `/sw.js` `/app.js` `/style.css` `/icon.svg` すべて 200 |
| トークン強制 | `curl /api/state`（`?k=` なし） | 401 |
| manifest 動的生成 | `curl` + JSON パース | `start_url=/?k=…`、shortcuts にも `?k=` |
| Service Worker | 実ブラウザ | scope 付き active、`dsh-progress-shell-v4` / `-data-v4` |
| ライブ更新 | 実ブラウザ | conn `ライブ`、ステップ 6 件・92% を描画 |
| オフライン | サーバー + cloudflared を停止（`curl` 530）→ 再読み込み | シェル復元・64%・7 ステップ表示・「オフライン」バナー |
| keep-awake | プロセス確認 | `powershell.exe` ヘルパーが生存（pid 継続） |
| cron/単体 | `node --test` | 20/20 pass |

途中で踏んだ罠（再発防止のため残す）:

1. `<script src>` はクエリを引き継がない → シェル認証をやめた（§3）。
2. keep-awake を `-Command` でインライン渡しすると C# の `"` でパースエラー →
   `.ps1` + `-File` に変更（終了コード 1 の実測あり）。
3. トンネル停止時は Cloudflare が `530`（成功応答）を返す → SW は非 2xx でも
   キャッシュへフォールバックする必要があった。
4. `public/icon.svg` が無く、HTML の `/icon.svg` が 404 だった（パッケージ直下にしか
   無かった）→ `public/` に配置。Service Worker の版番号も上げた。

# dsh-social-desktop-agent — 許可した範囲だけを、記録しながら

DeepSeek Harness 用のプラグインです。DSH エージェントに次の 2 つを与えます。

1. **Web（Instagram など）を実際に読む・操作する** — `browse_*` 7 ツール
2. **Windows デスクトップを観測して操作する** — `desktop_*` / `app_launch` / `power_action` 7 ツール

その代わりに、危険な側は**既定で全部閉じています**。できる範囲は「スコープ」（明示的な許可）で
選び、ホスト / アプリは allowlist で限定し、いいね・フォロー・DM・投稿・コメントのような
**書き込み系ソーシャル操作は設定に関係なく恒久拒否**します。電源操作は 3 段の条件 +
設定ゲートを全部満たさない限り dry-run です。すべての判断は JSONL の監査ログに残り、
`DSH_KILL_SWITCH=1` またはファイル 1 個で即停止できます。

> [!IMPORTANT]
> **既定のブラウザドライバは `stub`（オフラインの偽ページ）です。**
> 実際の Instagram を開くには、後述の `browserDriver: cdp` を設定し、DSH を
> `--remote-debugging-port=9222` 付きで起動してください。既定で実ネットワークに
> 出ないのは、インストールしただけで意図せず外部へアクセスしないためです。

## 何ができるか

### ブラウザ（`browse.*`）

| ツール | スコープ | できること |
|---|---|---|
| `browse_open` | `browse.read` | allowlist 内の http(s) URL を開く。資格情報入り URL・非 http(s)・許可外ホストは拒否 |
| `browse_snapshot` | `browse.read` | アクセシビリティ風スナップショット（`[e1] role "name"`）を返す。以後の操作はこの ref を使う |
| `browse_scroll` | `browse.read` | スクロール（座標 or ref 指定） |
| `browse_screenshot` | `browse.read` | スクリーンショットを data URL で取得 |
| `browse_close` | `browse.read` | このプラグインのブラウザセッションを閉じる |
| `browse_click` | `browse.interact` | ref をクリック。**いいね / 保存 / フォローは `social.write` スコープ時のみ**。DM / 投稿 / コメント / 削除は恒久拒否 |
| `browse_type` | `browse.interact` | ref に文字入力。**パスワード / ワンタイムコード / ユーザー名欄は拒否** |

### デスクトップ（`desktop.*` / `app.launch` / `os.power`）

| ツール | スコープ | できること |
|---|---|---|
| `desktop_observe` | `browse.read` | カーソル位置・画面 / モニタ矩形・可視ウィンドウ・前面ウィンドウ（読み取りのみ） |
| `desktop_focus` | `browse.interact` | allowlist アプリのウィンドウを前面化し、**本当に前面になったか**を返す（`focused: true/false`）。入力前に必ずこれを通す |
| `desktop_move` | `browse.interact` | カーソルを画面座標へ移動（画面外は拒否 / わずかな超過はクランプ） |
| `desktop_click` | `browse.interact` | 座標をクリック（left/right/middle、1〜3 回） |
| `desktop_type` | `browse.interact` | フォーカス中のウィンドウへ文字入力（SendKeys エスケープ。本文は監査ログに残さず長さのみ） |
| `desktop_key` | `browse.interact` | 許可キー（enter/tab/esc/矢印/F1-F12/英数）+ ctrl/alt/shift |
| `app_launch` | `app.launch` | allowlist のアプリ名だけ起動（notepad / calc / explorer / mspaint / chrome / msedge / code） |
| `power_action` | `os.power` | 再起動 / シャットダウン。3 条件 + `powerEnabled` が揃うまで **dry-run のみ** |

`browse.read` は「読むだけ」のスコープです。ブラウザの閲覧に加えて、デスクトップの
**観測**も含みます（入力は含みません）。最小権限の既定はこの 1 つだけです。

## インストールと有効化

```
plugin_manager install_bundle  target: <このディレクトリの絶対パス>
plugin_manager set_bundle      target: "dsh-social-desktop-agent"  enabled: true
```

有効化すると上記 14 ツールがエージェントに公開されます。設定を変えたい場合は、
プロファイルの `cordis.patch.yml` で同じ `id: social-desktop-agent` の `config` を
上書きしてください（プラグイン同梱の `cordis.patch.yml` は `config: {}` です）。

```yaml
- insert:
    - id: social-desktop-agent
      name: 'dsh-social-desktop-agent'
      config:
        scopes: ['browse.read', 'browse.interact']
        allowlist:
          hosts: ['instagram.com', 'www.instagram.com', '*.cdninstagram.com']
          apps: ['notepad', 'calc']
        browserDriver: cdp
        auditPath: 'C:\Users\user\AppData\Local\dsh-social-desktop-agent\audit.jsonl'
        powerEnabled: false
```

## 設定

| キー | 既定 | 意味 |
|---|---|---|
| `enabled` | `true` | プラグイン全体の有効化（false でツール 0 個） |
| `scopes` | `['browse.read']` | 明示的に許可するスコープ。省略時は閲覧のみ。`[]` は「何も許可しない」 |
| `allowlist.hosts` | Instagram 系 5 ホスト | ブラウザの host allowlist。`*.example.com` 可。**既定を置換**する |
| `allowlist.apps` | 7 アプリ | `app_launch` の allowlist。**既定を置換**する |
| `allowlist.powerTargets` | `['restart', 'shutdown']` | 電源操作の対象を狭める（例: `['shutdown']`）。**広げる方向には効かない** |
| `killSwitch` | `true` | `true`: `<監査ログと同じディレクトリ>/KILL_SWITCH` を監視。文字列: そのパスを監視。`DSH_KILL_SWITCH=1` は常に有効で無効化できない |
| `auditPath` | `%LOCALAPPDATA%\dsh-social-desktop-agent\audit.jsonl` | 追記専用 JSONL。テスト以外で `null` にしない |
| `powerEnabled` | `false` | 電源操作の追加ゲート。true でも scope / トークン / `DSH_ALLOW_POWER=1` は必要 |
| `browserDriver` | `stub` | `stub`: オフライン偽ページ（テスト・安全確認用）。`cdp`: 実ブラウザ |
| `cdpPort` | `9222` | `browserDriver: cdp` のときの CDP ポート |

`scopes` は「ぴったり許可」です。`browse.interact` を許可しても `browse.read` は
自動で付きません（必要なものを全部書く）。未知のスコープ名は無視されます（フェイルクローズ）。
設定変更はプラグインの再読み込み（または DSH の再起動）後に反映されます。

## スコープの選び方

| 追加するスコープ | できるようになること | 追加を勧める場面 |
|---|---|---|
| `browse.read`（既定） | Instagram の閲覧、スナップショット、desktop の観測 | まずはここだけ |
| `browse.interact` | ページ内クリック・入力、desktop のマウス / キーボード | 閲覧だけでは足りないと確認できたとき |
| `social.write` | **いいね / 保存 / フォロー**（エンゲージ操作のみ） | 開発用アカウント等で明示的に許可するとき。DM / 投稿 / コメントは許可しても通らない |
| `app.launch` | allowlist アプリの起動 | デスクトップ操作の対象アプリを決めたとき |
| `os.power` | 再起動 / シャットダウンの **計画表示**（実行はさらに 3 条件） | 本当に電源操作を試すときだけ |

上げる順番は上から。1 段上げるたびに、何をしたくなったのかを README / SAFETY に
メモしておくと、後で「なぜ許可したか」が追えます。

## 典型的な使い方

### 例 1: Instagram の公開プロフィールを読む（`browse.read` のみ）

```
browse_open   { url: "https://www.instagram.com/<account>/" }
browse_snapshot { maxNodes: 300 }
browse_scroll { deltaY: 800 }
browse_snapshot {}
```

ログイン画面・2FA・チェックポイント・CAPTCHA が出たら、ブラウザ層は
`{ ok:false, code:"NEEDS_HUMAN" }` を返して以降の操作を止めます。**人間に渡して
ブラウザ UI でログインしてもらい、`browse_close` でラッチを解除**してください。
プラグインがパスワードを扱うことはありません。

### 例 2: デスクトップを観測してメモ帳を開く（`browse.read` + `browse.interact` + `app.launch`）

```
desktop_observe {}
app_launch      { app: "notepad" }
desktop_observe { maxWindows: 20 }     # 前面ウィンドウが notepad になったか確認
desktop_type    { text: "買い物リスト\n- 牛乳" }
desktop_key     { key: "enter" }
```

クリックはフォーカス中のウィンドウに対して**破壊的**です。まず
`desktop_observe` で座標と前面ウィンドウを確認し、それから `desktop_click` を
使ってください。資格情報（パスワード・トークン）を `desktop_type` に渡さないこと。

### 例 3: 電源操作は「まず計画だけ」（`os.power` + 追加条件）

```
# 1) scope を os.power まで広げる（設定変更 + 再読み込み）
# 2) 確認トークンを環境変数で渡す（DSH を起動する前に、起動するシェルで設定する）
$env:DSH_POWER_CONFIRM_TOKEN = "<ランダムな長い文字列>"
# 3) それでも powerEnabled=false のままなら dry-run:
power_action { action: "reboot", delaySec: 60, confirmToken: "<同じ文字列>" }
# => { executed: false, dryRun: true, wouldRun: "shutdown /r /t 60", missing: ["config:powerEnabled"] }
```

実行まで進めるには、さらに `powerEnabled: true` と `DSH_ALLOW_POWER=1` が必要です。
**このリポジトリの検証では実行経路を絶対に踏みません**（実機の再起動・シャットダウン禁止）。
条件が 1 つでも欠ければ、何も実行せず `missing` に不足条件を返します。

## できないこと（設計上、意図的に）

- **自動いいね / フォロー / DM 送信 / 投稿 / コメント / シェア / 保存** — scope に関係なく恒久拒否
- **パスワード・ワンタイムコード・ユーザー名の入力** — 資格情報は一切扱わない（Cookie の読み書きもしない）
- **ログイン / 2FA / CAPTCHA の自動突破** — 検出したら止めて人間へ渡す
- **allowlist 外の URL / 任意の exe・引数・シェルコマンド** — 起動できるのは固定 allowlist の名前だけ
- **ファイル操作・レジストリ操作・クリップボード読み取り・スクリーンショットの外部送信**
- **`os.power` の無条件実行** — 3 条件 + 設定ゲートなしでは dry-run のみ
- **監査ログの改変** — 追記専用。1 行 1 判断の JSONL

## 構成

```
dsh-social-desktop-agent/
├── index.js              # 入口: 設定 / 14 ツール登録 / 動的 import / ポリシー配線
├── cordis.patch.yml      # バンドル patch
├── lib/
│   ├── core/             # scopes / policy / audit / confirm / killswitch / errors
│   ├── browser/          # policies / driver 契約 / stub・cdp ドライバ / tools
│   └── desktop/          # win / observe / input / apps / power / tools
├── scripts/verify.mjs    # オフライン統合検証（PASS/FAIL/SKIP 表）
├── test/                 # 単体 + 統合テスト
├── README.md
└── SAFETY.md             # 危険操作・緊急停止・監査の詳細
```

`lib/core` / `lib/browser` / `lib/desktop` は登録時に動的 import されます。
モジュールが欠けているカテゴリは**登録されず警告だけ**残り、プラグイン全体は落ちません
（`lib/core` が無い場合だけは、全ツールを登録せずフェイルクローズします）。

## 検証

```powershell
# オフライン統合検証（ネットワーク / 実ブラウザ / 実シャットダウンなし）
node dsh-social-desktop-agent/scripts/verify.mjs

# テスト（Node 24 の `node --test <dir>` でも動くよう test/index.js を同梱）
node --test dsh-social-desktop-agent/test

# プラグイン内から（glob 形式）
cd dsh-social-desktop-agent
npm test
```

`verify.mjs` は「登録ツール名が期待と一致するか」「既定設定で `browse.interact` と
`os.power` が拒否されるか」「kill switch / social.write が効くか」を表で出します。
他レイヤーが未実装の場合は FAIL ではなく **SKIP（未実装）** として表示します。

## 既知の制約

- Windows 専用です（デスクトップ層は PowerShell + Win32 API）。
- CDP ドライバは DOM ベースの近似スナップショットです。SPA の再レンダリングで ref が
  失効することがあります（その場合は `browse_snapshot` を取り直す）。
- ブラウザのログイン状態はプラグインが保持しません。人間が DSH のブラウザ UI で
  ログインした状態を前提にします（プロセスを跨いだ Cookie 永続化はしません）。
- レート制限（既定 30 リクエスト/分/スコープ、ブラウザ層は最小間隔 1.5 秒・200 操作/セッション）
  を超えると拒否されます。これはアカウント保護のためで、回避する設定はありません。
- スコープの変更は設定ファイルの編集 + プラグイン再読み込みが必要です（実行中に
  モデルが自分で権限を上げることはできません）。

危険操作の全体像・緊急停止・監査ログの読み方は [SAFETY.md](./SAFETY.md) を参照してください。

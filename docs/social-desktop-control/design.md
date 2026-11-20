# dsh-social-desktop-agent 設計書

DSH エージェントに「Web（Instagram 等）の閲覧・操作」と「Windows デスクトップの観測・
カーソル操作・アプリ起動・（最終的には）電源操作」を与えるプラグインの設計。**安全性が最優先**で、
権限は最小から明示的に広げる。本書はコードを書かない（実装は `dsh-social-desktop-agent/`）。

- 対象読者: 実装担当、レビュー担当、運用する人間
- 前提環境: Windows 11 / Node v24 系 / pnpm 無し / リポジトリ直下に `package.json` は無い
- 関連文書: `docs/PLUGIN-GUIDE.md`（プラグインの最小形と落とし穴）、
  `docs/social-desktop-control/capability-matrix.md`（既存能力との突き合わせ表）

> **本書の位置づけ**: 執筆時点で `dsh-social-desktop-agent/lib/` には実装が進行中で、
> ファイル名とスコープ割当はその実物に合わせてある（§7 に実測の一覧）。実装と食い違った
> 場合は**実装を正**とし、本書を更新する。

---

## 1. 目的と非目的

### 目的

1. エージェントが**実ブラウザ**で Instagram 等を閲覧し、人間が見ている画面と同じものを見る。
2. エージェントが Windows デスクトップを**観測**し、カーソル移動・クリック・キー入力・
   アプリ起動まで行える。
3. 電源操作（再起動/シャットダウン）は**三段条件 + 既定 dry-run** の下でのみ可能。
4. 上記すべてが**監査可能**で、**いつでも止められる**（kill switch）。

### 非目的（やらないこと）

- いいね・フォロー・DM・投稿・コメント等の**書き込み系ソーシャル操作**。恒久拒否（§4.2）。
- ログイン/2FA/CAPTCHA の自動突破。検出したら**人間に渡して停止**する（§5.6）。
- 資格情報の取得・保存・入力。パスワードも 2FA コードもエージェントは扱わない
  （`detectCredentialInput` が該当要素への入力/クリックを拒否する）。
- Instagram の内部 API 直叩き、スクレイピングの高速化、複数アカウント運用。
- OS 権限を超える操作（UAC プロンプトの自動承諾、管理者ウィンドウへの入力）。

---

## 2. 既存能力の棚卸し（実測した根拠つき）

「作る前に、既にあるものを数える」。以下は本リポジトリと現行プロファイルで実際に
確認した内容で、推測は含めない。

### 2.1 ブラウザ側: 2 系統が既に同居している

| 系統 | 実体 | 提供ツール | 根拠 |
|---|---|---|---|
| リポジトリ内プラグイン | `dsh-browser-agent` 1.0.1（`link:` で導入済み） | `browser_*` 19 個 | `dsh-browser-agent/package.json`、`dsh-browser-agent/lib/index.js` の `name: 'browser_...'` 19 件 |
| 配布バンドル | `dsh-builtin-browser` 0.5.8（プロファイル依存に記載） | `dsh_browser_*`（a11y/snapshot/click/type/fill/scrape/…） | `~/.dsh/profiles/desktop/package.json` の `dsh.profile.bundles` と `dependencies` |

両方が同時に有効で、**同じことができる道具が 2 系統ある**。したがって本プラグインは
ブラウザ操作の再実装をせず、**上位のポリシー層**として既存系統の上に座る
（実装は `lib/browser/driver.js` の抽象に、`stub-driver.js`（テスト）と
`cdp-driver.js`（実機）を差し替える形）。

`dsh-browser-agent` が CDP で実際にできること（`dsh-browser-agent/lib/cdp.js` と
`skills/dsh-browser-agent/references/tools.md` で確認）:

- 零依存 CDP クライアント（Node 24 のグローバル `WebSocket`）: `Page.captureScreenshot`、
  `Input.dispatchMouseEvent`（`isTrusted:true`）、`Network.*`、`Fetch.*`、`Emulation.*`、
  任意メソッドの透伝（`browser_cdp`）。`<webview>` guest を target として列挙する
  （Electron は `type:"webview"` を返すため Playwright/Puppeteer では掴めない）。
- **安全护栏**: `pickTarget()` は既定 `allowPage:false` で、webview が無ければ `null`。
  過去にシェルを `Page.navigate` で外部サイトへ飛ばした事故の再発防止。
- Cookie 保険庫（httpOnly 含む）。側栏セッションはプロセス単位で消えるため。
- ネイティブ CDP 系は `--remote-debugging-port` 前提。無い場合は能力を**正直に降格報告**する。

### 2.2 Windows 実行経路

| 経路 | 何ができる | 制約 |
|---|---|---|
| DSH 組込み `pwsh` ツール（本セッションのツールカタログに存在） | 任意の PowerShell 1 回実行 | サンドボックスモードに従う。read-only / workspace-write では ConstrainedLanguage、パイプ付き子プロセス出力の取得は EPERM（ツール説明に明記） |
| プラグイン内 `node:child_process` | `execFile` で外部プロセス起動 | プラグインはサンドボックス外で動く。**そのぶん危険度が上がる**ので、本プラグインは自前のゲートを必須にする |
| 実装済み | `dsh-social-desktop-agent/lib/desktop/win.js` が `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command` を `execFile` で起動し、`shell:true` を**使わない** | 長いスクリプトを `-Command` に渡すと引用符再パースで壊れる（`docs/PLUGIN-GUIDE.md` §9）。実装は base64 環境変数渡しで回避している |

**設計上の帰結**: 新しい Windows 実行層は `lib/desktop/win.js` の `createRunner`（DI 可能）を
唯一の実行経路とし、テストでは fake runner を注入する。スクリプトが長くなる場合は
`.ps1` を同梱して `-File` で渡す（`docs/PLUGIN-GUIDE.md` §9 の方針）。

### 2.3 足りないもの（本プラグインが供給する差分）

1. **スコープ制御**（`browse.read` / `browse.interact` / `app.launch` / `os.power`）と既定最小権限。
2. **ドメイン allowlist / アプリ allowlist**。
3. **書き込み系ソーシャルの恒久拒否**（`FORBIDDEN_KINDS` としてポリシー層で落とす）。
4. **レート制限**（暴走・レート制限誘発の防止）。
5. **監査ログ**（JSONL 追記専用、拒否も記録）。
6. **kill switch**（エージェントは止められるが再開はできない）。
7. **人間介入ポイント**（ログイン/2FA/CAPTCHA/checkpoint 検出で停止）。
8. **デスクトップ観測・カーソル入力・アプリ起動・電源操作**（既存に無い）。

> 重要: 現行プロファイルは `permission` プリセットが `danger-full-access` /
> `approval: never`、さらに本セッションでは承認プロンプト自体が無効。つまり
> **ホスト側の承認 UI を安全境界として当てにできない**。だから本プラグインは
> 自分で確認トークン・kill switch・監査を持つ（§5）。

---

## 3. Instagram 固有の制約

| 制約 | 実務上の意味 | 設計での扱い |
|---|---|---|
| ログイン/2FA/CAPTCHA | 画面が通常 DOM と別物になり、自動操作は「突破」になる | **検出して停止**（`HUMAN_REQUIRED`）。エージェントはパスワードも 2FA コードも入力しない |
| DOM が頻繁に変わる | class 名はハッシュ、構造は A/B で変動。CSS セレクタは壊れる | セレクタでなく**アクセシビリティツリー + 安定 ref** を主経路にする（`browse_snapshot`） |
| 自動操作の規約リスク | Instagram の利用規約は自動アクセス・スクレイピングを禁止。契約違反はアカウント制限に直結 | 既定は人間が開いたセッションの**閲覧のみ**。大量取得・巡回はしない（レート制限で物理的に抑える） |
| レート制限・凍結 | 短時間の連続操作で 429 / `checkpoint_required` / 一時凍結 | スコープ毎トークンバケット（§5.3）。`checkpoint` 画面を検出したら即停止 |
| 不可逆な社会的行為 | いいね・フォロー・DM は取り消しても相手に通知が残る | **恒久拒否**（§4.2）。スコープでもトークンでも解除不可 |

### エージェントが踏んではいけない操作（恒久拒否）

いいね / 保存 / フォロー / フォロー解除 / コメント / 返信 / シェア / リポスト /
ストーリー投稿 / 投稿・公開 / DM・メッセージ送信 / 投票 / ミュート・ブロック / 通報 /
アカウント設定変更（パスワード・メール・名前・公開範囲）/ アカウント削除 /
ログイン・ログアウト・2FA 入力 / CAPTCHA 入力 / 支払い情報。

実装では `lib/core/policy.js` の `FORBIDDEN_KINDS`（`like` `follow` `dm` `comment`
`post` `share` `reply` `block` `delete` `purchase` …）が**全スコープで無条件に拒否**する。
加えて `lib/browser/policies.js` が要素ラベルから同種の意図を推定し、
資格情報フィールド（`detectCredentialInput`）へのクリック/入力を拒否する。

> 「閲覧のための操作」（タブ移動、次ページ、スクロール、検索語の入力、画像を開く）は
> `browse.interact` で許可する。線引きは **deny 判定が先**に評価され、allow 側では覆せない。

---

## 4. 操作スコープモデル（4 段階）

スコープは**順序を持つが包含しない**。`browse.interact` を有効にしても `browse.read` は
自動で有効にならず、まして `os.power` は絶対に含意されない（実装:
`lib/core/scopes.js` の `SCOPE_ORDER` / `resolveScopes`）。
**未知の名前は付与しない**（タイポは fail closed）。

### 4.0 一覧（許可 / 拒否 / 要確認）

| スコープ | 既定 | 許可されるツール | 要確認（確認トークン） | 拒否（この段階では不可） |
|---|---|---|---|---|
| `browse.read` | **✅ 既定** | `browse_open` `browse_snapshot` `browse_screenshot` `browse_scroll` `browse_close` `social_status` `audit_tail` | なし | `browse_click` `browse_type` / 全 `desktop_*` / `app_launch` / `power_action` |
| `browse.interact` | ❌ 明示昇格 | 上記 + `browse_click` `browse_type`（拒否リストと資格情報判定を通過した要素のみ） | 昇格時に 1 回 | 書き込み系ソーシャル全部（恒久）/ 全 `desktop_*` / `app_launch` / `power_action` |
| `app.launch` | ❌ 明示昇格 | 上記 + `desktop_observe` `desktop_move` `desktop_click` `desktop_type` `desktop_key` `app_launch`（allowlist のアプリのみ） | 昇格時に 1 回、アプリ毎に初回 | `power_action` / allowlist 外アプリ / シェル・スクリプト実行 |
| `os.power` | ❌ 三重ゲート | 上記 + `power_action`（`restart` / `shutdown`） | **毎回**（単回使用・5 分 TTL） | `sleep`/`hibernate`（現実装では対象外）/ `force` 付き再起動（追加確認）/ 任意コマンド |

「要確認」の実体は §5.7 の確認トークン。`os.power` だけは**毎回**必要で、他の段階は
昇格時の 1 回で足りる。

### 4.1 既定値（最小権限）

```yaml
config:
  scopes: ['browse.read']        # 既定。書かなければこれだけ
  domains: ['instagram.com']
  apps: []
  power: { dryRun: true }        # false を明示しない限り実行しない
```

- 設定を書かない → `browse.read` のみ。
- 明示的な空配列 `[]` → **何も許可しない**（設定漏れと「意図的な全拒否」を区別する）。
- 不明なスコープ名 → 落とす（例外にしない。起動を止めると現場が回避策を打つため）。

### 4.2 昇格手順（明示指定 + 確認トークン）

1. 人間が `cordis.patch.yml` の `config.scopes` に足す（例 `['browse.read','browse.interact']`）。
2. プラグインは起動時に `scopes` を正規化し、`browse.interact` 以上を含む場合は
   **確認ゲート**（`lib/core/confirm.js` の `createConfirmGate`）を要求する。
   トークンは**単回使用・5 分 TTL・対象アクションに束縛**（正規化 JSON の一致で照合、
   `confirmToken` 等の証明フィールドは比較から除外）。
3. トークンが無い/不一致なら、その実行では昇格スコープを**無効として扱う**
   （起動は成功し、`social_status` が `pendingConfirm` を返す）。
4. `os.power` は昇格に加えて `DSH_ALLOW_POWER=1` と**毎回の**トークンが必要（§5.7）。

### 4.3 降格・失効

| 手段 | 効果 | 誰ができるか |
|---|---|---|
| `config.scopes` を縮める | 次回起動で縮小。`social_status` の `effectiveScopes` に反映 | 人間（設定編集） |
| `DSH_KILL_SWITCH=1` を立てる | 全ツールが `KILL_SWITCH` で拒否 | 人間（環境変数） |
| `DSH_KILL_SWITCH_FILE` が指す番兵ファイル作成 | 同上。`social_killswitch {action:'engage'}` でも作れる | エージェントも**停止側のみ**可 |
| 確認トークンの TTL 切れ / 使用済み | 昇格・電源操作が `CONFIRM_REQUIRED` に戻る | 時間経過で自動 |
| 拒否の累積 | そのドメイン/アプリを cooldown（設計目標。実装は §7 参照） | 自動 |
| プロセス終了 | すべて失効（永続化しない） | 人間 |

**エージェントは自分を昇格できない**。できるのは「止める」方向だけ。
kill の解除はファイル削除か、明示的な人間の操作が必要（設計目標: 解除は環境変数 +
トークンの二条件）。

---

## 5. 安全機構の設計

判定順序は固定（`lib/core/policy.js` の `evaluate`）:

```
kill switch → scope → target allowlist（domain/app/power）→ deny-list(恒久) → rate limit → confirm → 実行
```

### 5.1 ドメイン allowlist

- 照合は **suffix + ラベル境界**（`instagram.com` は `www.instagram.com` を含むが
  `evilinstagram.com` を含まない）。`URL` パーサで `hostname` を正規化してから比較。
  IDN は punycode 化。ワイルドカード・パス・資格情報を含む指定は**受け付けない**。
- **https のみ**。`http:` / `file:` / `data:` / `javascript:` / `blob:` は `TARGET_DENIED`。
- リダイレクト後も再判定する（`browse_open` の結果 URL で再チェック）。allowlist 外へ
  出た時点で `TARGET_DENIED` を返し、それ以上そのタブを操作しない。
- 既定 allowlist は `['instagram.com']`。**空配列は「全部拒否」**。

### 5.2 アクション allowlist と恒久拒否

- deny-list の材料は 3 層: ①**アクション種別** — `FORBIDDEN_KINDS`（`like` `follow` `dm`
  `comment` `post` `share` `reply` `block` `mute` `report` `delete` `purchase` 等）で全スコープ
  無条件拒否、②**DOM/ax のラベル** — `classifySocialLabel` が日英のラベル集合
  （`いいね` `Like` `フォロー` `Follow` `コメント` `送信` `シェア` `保存` 等）を正規化して照合、
  ③**資格情報** — `detectCredentialInput` が `type=password` / `autocomplete=current-password` /
  `one-time-code` / ラベル「パスワード」「認証コード」等を**クリックも入力も拒否**。
- allow-list は「閲覧のための操作」だけ: スクロール、タブ/次ページ、検索欄への入力、
  画像拡大、プロフィールを開く（**読むだけ**）。
- 不明な要素は**拒否側に倒す**（`TARGET_DENIED` + 「人間が代わりに操作してください」）。

### 5.3 レート制限

スコープ単位のトークンバケット（`DEFAULT_RATE_LIMIT = { limit: 30, windowMs: 60_000 }`、
時計は注入可能）。設定で**狭めることはできるが広げられない**。

| 対象 | 既定上限 | 備考 |
|---|---|---|
| `browse.read` 系 | 30 / 分 / スコープ | `browse_snapshot` の連打を抑える |
| `browse.interact` 系 | 30 / 分 / スコープ | 同一ドメイン最小間隔（1.5 秒）は**設計目標**（未実装） |
| `app.launch` 系 | 30 / 分 / スコープ | `app_launch` は別途 3/分を目標 |
| `os.power` | 30 / 分 + 単回トークン | 実質「トークン 1 個につき 1 回」 |

超過は**実行せずに** `RATE_LIMITED`。自動リトライ・自動待機は実装しない
（レート制限の誘発と「止まらないエージェント」の原因になる）。
ドメイン毎間隔・日次上限は設計目標として残す（§9 論点 2）。

### 5.4 監査ログ（JSONL 追記専用）

- 出力: `~/.dsh/social-desktop-agent/audit/YYYY-MM-DD.jsonl`、`fs.appendFile`（`flag:'a'`）。
- 1 行 = 1 判定。**成功も拒否も記録**（拒否が記録されない監査は監査ではない）。
- フィールド: `ts` `seq` `tool` `scope` `kind` `decision`(`allow|deny`) `code` `target`
  (`{host,app,power}`) `argsDigest` `prevHash` `hash`。
- **入力文字列は保存しない**: `browse_type` / `desktop_type` の本文は `sha256` + 文字数のみ。
  スクリーンショットはパスのみ。Cookie 値・トークン・パスワードは**絶対に書かない**。
- `hash = sha256(prevHash + canonicalJson(record))` の**ハッシュ連鎖**で改竄検知。
- 記録に失敗した場合は**実行しない**（fail closed）。

### 5.5 kill switch

- 2 つのスイッチ: 環境変数 `DSH_KILL_SWITCH=1`、または `DSH_KILL_SWITCH_FILE` が指す
  番兵ファイルの存在（既定 `~/.dsh/social-desktop-agent/KILL`）。
- 全ツールの入口と、複数ステップ操作の**各ステップ間**で確認する（クリック連打の途中で止まる）。
- `social_killswitch` ツールは `engage` のみ許可（`status` は常に可）。
  `disengage` は明示的な人間の操作 + トークンが無ければ `CONFIRM_REQUIRED`。
- kill 中は `social_status` だけが動く（状況確認は止めない）。

### 5.6 人間介入ポイント（CAPTCHA / 2FA / ログイン検出）

検出器（`lib/browser/policies.js` に実装済み）は 4 種類の画面を URL とラベルで判定:

| kind | 検出例 | 対応 |
|---|---|---|
| `captcha` | `/captcha`、`iframe[title*=reCAPTCHA]`、`CAPTCHA` ラベル | 即 `HUMAN_REQUIRED` |
| `2fa` | `/(two_factor\|2fa)`、`6桁` `認証コード` `セキュリティコード` | 即 `HUMAN_REQUIRED` |
| `checkpoint` | `/(challenge\|checkpoint)`（本人確認） | 即 `HUMAN_REQUIRED` + cooldown |
| `login` | `/accounts/login` `/signin` | 即 `HUMAN_REQUIRED`（資格情報は入力しない） |

戻り値（例）: `{ok:false, code:"HUMAN_REQUIRED", handoff:{reason:"captcha", url:"…/challenge/",
instructions:"ブラウザウィンドウで人間が完了してください。"}}`

- 同時にそのドメインを **cooldown**（既定 15 分を目標）。cooldown 中の `browse.interact` は
  実行せず `HUMAN_REQUIRED` を返す。
- エージェントは CAPTCHA 画像を読んで解いたり、2FA コードを推測・入力したりしない。
  これはスコープでもトークンでも解除できない（`credential` 判定で二重に止める）。

### 5.7 `os.power` の三段条件と dry-run

実行条件（**すべて**満たすときだけ実行、1 つでも欠ければ `CONFIRM_REQUIRED`）:

| # | 条件 | 供給元 | エージェントが単独で満たせるか |
|---|---|---|---|
| 1 | `scopes` に `os.power` | `cordis.patch.yml`（人間が編集） | ❌ |
| 2 | 確認トークン一致（単回・5 分 TTL・対象束縛） | `confirm` ゲート（CLI では `DSH_POWER_CONFIRM_TOKEN`） | ❌ |
| 3 | `DSH_ALLOW_POWER=1` | DSH 起動時の環境変数 | ❌ |

- 既定 `power.dryRun: true`。`dryRun:false` を明示しない限り**コマンドを実行せず**
  `planned` だけ返す。
- 返り値に `gate: {scope, token, env, dryRun}` を必ず含める（どこで止まったかが分かる）。
- 実行するコマンドは引数配列で固定（`shutdown.exe /r /t <delay>` / `/s`）。**文字列連結しない**。
- `force` は既定 false。`/f` を付けるには追加の確認が必要。
- 対象は `restart` / `shutdown` のみ（`DEFAULT_POWER_TARGETS`）。設定で**狭められるが広げられない**。

---

## 6. ツール一覧と入出力スキーマ案

すべて `output.schema` を持ち、失敗時も throw せず `{ok:false, code, message}` を返す
（`docs/PLUGIN-GUIDE.md` §3）。引数の詳細仕様は実装の `parameters` を正とし、本表は
**契約の要約**。共通の戻り値: `ok` `code` `scope` `auditId`。

### 6.1 一覧（スコープ別 / 実装済み 14 + 予定 3）

- `browse.read`: `browse_open` `browse_snapshot` `browse_screenshot` `browse_scroll` `browse_close`
- `browse.interact`: `browse_click` `browse_type`（拒否リストと資格情報判定を通過した要素のみ）
- `app.launch`: `desktop_observe` `desktop_move` `desktop_click` `desktop_type` `desktop_key` `app_launch`
- `os.power`: `power_action`（`restart` / `shutdown`）
- スコープ不要: `social_status` `audit_tail` `social_killswitch`（いずれも**予定**。他は実装済み）

### 6.2 引数・戻り値・エラー

| ツール | 引数（必須は太字） | 戻り値（主なもの） | 拒否コード |
|---|---|---|---|
| `social_status` | `verbose?: boolean` | `{ok, effectiveScopes[], pendingConfirm[], policy:{domains,apps,power}, rate:{…}, kill:{engaged,source}, audit:{path,lines}}` | — |
| `browse_open` | **`url: string`**, `reuse?: boolean` | `{ok, url, title, redirected, scope, auditId}` | `TARGET_DENIED` `KILL_SWITCH` `RATE_LIMITED` |
| `browse_snapshot` | `mode?: 'ax'\|'text'`, `maxNodes?: 1..400`, `selector?: string` | `{ok, url, title, count, nodes:[{ref,role,name}]}` | `SCOPE_DENIED` `KILL_SWITCH` |
| `browse_screenshot` | `full?: boolean`, `clip?: 'x,y,w,h'`, `savePath?: string` | `{ok, path, width, height, engine}` | `SCOPE_DENIED` `TARGET_DENIED` |
| `browse_scroll` | `dy?: number`, `ref?: string` | `{ok, from, to, engine}` | `SCOPE_DENIED` `TARGET_DENIED` |
| `browse_close` | `force?: boolean` | `{ok, closed}` | `SCOPE_DENIED` |
| `browse_click` | **`ref?: string`**, `selector?: string`, `text?: string` | `{ok, clicked:{role,name}, at:[x,y], decision}` | `SCOPE_DENIED` `TARGET_DENIED` `HUMAN_REQUIRED` `RATE_LIMITED` |
| `browse_type` | **`ref: string`**, **`text: string`**, `submit?: boolean` | `{ok, valueLength, submitted, targetRole}` | `SCOPE_DENIED` `TARGET_DENIED` `HUMAN_REQUIRED` |
| `desktop_observe` | `includeWindows?: boolean`, `includeMonitors?: boolean` | `{ok, cursor:{x,y}, screen:{w,h,virtual}, monitors[], windows[], dpi:{scale}}` | `SCOPE_DENIED` `KILL_SWITCH` |
| `desktop_move` | **`x: number`**, **`y: number`**, `durationMs?: number` | `{ok, at:[x,y], monitorsUsed}` | `SCOPE_DENIED` `TARGET_DENIED`（画面外） |
| `desktop_click` | **`x: number`**, **`y: number`**, `button?: 'left'\|'right'\|'middle'`, `count?: 1..3` | `{ok, at:[x,y], decision}` | `SCOPE_DENIED` `TARGET_DENIED` `KILL_SWITCH` |
| `desktop_type` | **`text: string`**, `submit?: boolean` | `{ok, length, redacted:true}` | `SCOPE_DENIED` `TARGET_DENIED` `RATE_LIMITED` |
| `desktop_key` | **`key: string`**, `modifiers?: ('ctrl'\|'alt'\|'shift')[]`, `times?: 1..3` | `{ok, key, modifiers}` | `SCOPE_DENIED` `TARGET_DENIED` |
| `app_launch` | **`app: string`**（allowlist キーのみ。引数・任意パスは不可） | `{ok, app, resolvedPath, pid}` | `TARGET_DENIED` `SCOPE_DENIED` |
| `power_action` | **`action: 'reboot'\|'shutdown'`**, `delaySec?: 0..86400`（既定 60）, **`confirmToken: string`** | `{ok, executed, dryRun, action, delaySec, wouldRun, missing[]}` | `SCOPE_DENIED` `CONFIRM_REQUIRED` `KILL_SWITCH` |
| `social_killswitch` | **`action: 'engage'\|'status'\|'disengage'`** | `{ok, engaged, source, path}` | `CONFIRM_REQUIRED`（disengage） |
| `audit_tail` | `limit?: 1..200` | `{ok, entries:[…], chained:true}` | — |

### 6.3 エラーコード（stable）

| コード | 意味 | 回復手段 |
|---|---|---|
| `SCOPE_DENIED` | そのスコープが無効 | 人間が設定に足す + トークン |
| `TARGET_DENIED` | ドメイン/アプリ/要素が allowlist 外 or deny-list 該当 | 別の対象を選ぶ（人間が設定を見直す） |
| `RATE_LIMITED` | 上限超過 | 待つ（自動リトライしない） |
| `CONFIRM_REQUIRED` | トークン欠落/不一致/TTL 切れ/使用済み | 人間がトークンを渡す |
| `KILL_SWITCH` | 停止中 | 人間が解除 |
| `HUMAN_REQUIRED` | CAPTCHA/2FA/checkpoint/ログイン検出 | **人間がブラウザで完了** |
| `TARGET_STALE` | ref が古い（再スナップショット必要） | `browse_snapshot` をやり直す |
| `DEPENDENCY_MISSING` | ブラウザ/CDP/PowerShell が無い | 起動オプション確認（`browser_status`） |
| `PRIVILEGE_REQUIRED` | UAC/管理者権限が要る操作 | 実行しない（人間に委ねる） |
| `ABORTED` | 途中で kill/中断 | — |

> 実装の `lib/core/errors.js` は `POLICY_CODES`（`SCOPE_DENIED` `TARGET_DENIED`
> `RATE_LIMITED` `CONFIRM_REQUIRED` `KILL_SWITCH`）を定義する。コードは文字列で安定させ、
> メッセージ文言に依存しない。

---

## 7. 実装分割と所有ファイル

執筆時点の実ファイル（実測）に合わせた所有表。テストは実装側の `test/` に置く。

| モジュール | 所有ファイル | 責務 | 状態 |
|---|---|---|---|
| 安全コア | `lib/core/scopes.js` `errors.js` `policy.js` `confirm.js` `audit.js` `killswitch.js` | 判定順序・恒久拒否・レート制限・トークン・監査・停止。**副作用は注入** | 済（74 テスト） |
| ブラウズ層 | `lib/browser/tools.js` `policies.js`（ラベル/資格情報/CAPTCHA 判定）`driver.js` `stub-driver.js` `cdp-driver.js` | 既存ブラウザの上にポリシーを被せるアダプタ。driver は DI | 済（79 テスト。`cdp-driver` は実ブラウザ未検証） |
| デスクトップ層 | `lib/desktop/win.js` `observe.js` `input.js` `apps.js` `power.js` `tools.js` | Windows 実行・観測・入力・起動・電源 | 済（109 テスト＋実機読み取り dry-run） |
| 結線 | `index.js` `package.json` `cordis.patch.yml` `locale/{en,ja}.json` `icon.svg` | ツール登録、systemPrompt セクション、config 正規化 | 済 / `index.js` は 14 ツール登録済、`locale`・`icon` 追加済。`social_status` `audit_tail` `social_killswitch` は**予定** |
| 検証 | `test/**/*.test.mjs`、`dsh-social-desktop-agent/SAFETY.md`、`scripts/verify.mjs` | オフライン単体/統合、受入マトリクス | 済（279 テスト / verify 16 項目 PASS） |

順序は依存の少ない順で、各段でテストを書いてから次へ:
① `lib/core/*`（純関数）→ 単体。ここが通らない限り他を触らない。② `lib/desktop/*` + fake
runner → `win`/`observe`/`input`/`apps`/`power` の単体。③ `lib/browser/*` + stub driver →
スコープ・deny・資格情報・CAPTCHA 判定の単体。④ `index.js` 結線 → ツール登録と 4 スコープの
許可/拒否マトリクス統合。⑤ 安全文書（`dsh-social-desktop-agent/SAFETY.md`）と README。

### テスト方針（完全オフライン）

| 層 | 何を固定するか | 禁止事項 |
|---|---|---|
| 単体 | スコープ正規化・判定順序・deny 優先・レート制限・トークン TTL/単回・監査ハッシュ連鎖 | 実ネットワーク・実ファイル（tmpdir のみ） |
| 統合 | 実装済み 14 ツールを fake driver で呼び、**4 スコープ × 許可/拒否/要確認** の全マスを検証 | 実ブラウザ起動・実 PowerShell・実電源 |
| 電源 | `power_action` が **絶対に実行しない**ことを担保（`executed:false` と `gate` の検証） | `shutdown.exe` の実起動 |
| 静的 | `node --check`、`scripts/check-plugin.ps1 -Path .\dsh-social-desktop-agent -RunTests` | — |

DRY 原則: `win.js` の `createRunner` と `browser/driver.js` の両方を DI で受ける。
テストは `test/support/fake-*.js` / `stub-driver.js` を注入する。**実 driver のコードパスは
テストで一度も実行しない**（そこが安全境界なので、実行しないことを明示する）。

---

## 8. 残余リスク

| # | リスク | 影響 | 緩和 |
|---|---|---|---|
| R1 | **Instagram ToS 違反・アカウント制限** | アカウント凍結、法的リスク | 既定は閲覧のみ、書き込み恒久拒否、レート制限、規約を README 冒頭に明記。**自動化の是非は人間が判断する** |
| R2 | **Windows の座標系**（DPI スケーリング・マルチモニタ・負の原点） | 誤クリック（不可逆） | `desktop_observe` が `dpi.scale` と仮想スクリーン矩形を返す。クリックは仮想スクリーン内か検証し、許容 4px 超の逸脱は拒否（`lib/desktop/input.js` 実装済） |
| R3 | **UAC / 管理者ウィンドウ / ロック画面** | 入力が届かない・昇格要求を踏む | `PRIVILEGE_REQUIRED` で停止。UAC プロンプトの自動操作は設計上しない |
| R4 | **DOM 変更・誤クリックの不可逆性** | 意図しない社会的行為 | deny 3 層 + 不明要素は拒否 + クリック前 snapshot + 監査。ただし**完全な保証はない**（R5） |
| R5 | **本プラグインは sandbox ではない** | 完全な権限を持つプロセスは env もファイルも読める | ゲートは「事故」と「外部コンテンツからの指示注入」を止める層。OS 権限・DSH サンドボックスが最終境界。README / SAFETY に明記 |
| R6 | ブラウザ系 2 系統の挙動差（`browser_*` vs `dsh_browser_*`） | 同じ操作で結果が違う | driver 抽象で能力差を吸収し `engine` を返す。片方しか無い環境でも動く（`DEPENDENCY_MISSING`） |
| R7 | `-Command` に長いスクリプト | 引用符再パースで即終了（`docs/PLUGIN-GUIDE.md` §9） | base64 環境変数渡し（実装済）。長大化したら `.ps1` + `-File` に切替 |

---

## 9. 未解決の論点（3 点以内）

1. **`browse.read` と `browse.interact` の境界**: 「次ページ」「タブ切替」「検索語入力」を
   閲覧の一部と見なして `browse.interact` に置いた。`browse.scroll` は `browse.read` 側に
   置いてある（読み取りの一部）が、スクロールは実入力イベントなので interact に寄せる
   解釈もある。現実装は**安全側**（クリック/入力は interact 必須）。
2. **レート制限の粒度**: 現実装はスコープ毎 30/分のバケットのみ。同一ドメイン最小間隔・
   日次上限・拒否累積 cooldown は**未実装**で、設計目標として残っている。Instagram の
   実際のレート制限に合わせるなら、ドメイン別の設定項目が要る。
3. **`os.power` の対象範囲**: `restart` / `shutdown` に限定した。`sleep`/`hibernate`、
   および `shutdown /a`（中止）のような復旧系コマンドを足すかは、事故時の復旧容易性と
   引き換えなので保留。独立した論点として `force` の追加確認の強度も未決。

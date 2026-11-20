# SAFETY — dsh-social-desktop-agent

このプラグインは、DSH エージェントに **実ブラウザ** と **実 Windows デスクトップ** への
操作手段を与えます。便利さの裏側にある危険（誤クリック・誤入力・誤シャットダウン・
アカウント凍結）を、設定とコードの両方で閉じ込めるための文書です。

**ここに書かれた拒否・条件はすべて実装済みで、モデルが自分で解除することはできません。**
変更できるのは設定ファイルを編集できる人間だけです。

---

## 1. 原則

1. **最小権限が既定** — 既定スコープは `browse.read` のみ。何も書かなければ閲覧だけ。
2. **明示許可だけが効く** — スコープは「ぴったり許可」。`browse.interact` は
   `browse.read` を含意しない。未知のスコープ名は無視（フェイルクローズ）。
3. **恒久拒否は設定で解除できない** — いいね / フォロー / DM / 投稿 / コメント等は
   `scopes` を全部許可しても拒否される（コード内の固定リスト）。
4. **人間に渡す** — ログイン / 2FA / チェックポイント / CAPTCHA を検出したら、
   自動突破せず停止して `NEEDS_HUMAN` を返す。
5. **全部記録する** — allow / deny / dry-run の判断を JSONL に 1 行ずつ追記する。
6. **いつでも止められる** — kill switch（環境変数またはファイル）で全ツール即停止。

---

## 2. 危険操作一覧（既定 / 有効化 / 拒否）

「既定」はインストール直後の状態（`scopes: ['browse.read']`, `powerEnabled: false`,
`browserDriver: 'stub'`）です。

| 操作 | 既定 | 有効化（人間が設定する） | 拒否（設定しても通らない / 常時） |
|---|---|---|---|
| ページを読む（`browse_open` / `snapshot` / `scroll` / `screenshot`） | **許可**（`browse.read`） | — | allowlist 外ホスト、非 http(s)、`user:pass@` 付き URL、kill switch、レート超過 |
| ページを操作する（`browse_click` / `browse_type`） | **拒否** | `scopes` に `browse.interact` を追加 | ソーシャル書き込み（恒久）、パスワード / OTP / ユーザー名欄、ログイン等の検出後、kill switch、レート超過 |
| デスクトップを観測する（`desktop_observe`） | **許可**（`browse.read`、読み取りのみ） | — | kill switch |
| ウィンドウを前面化する（`desktop_focus`） | **拒否** | `scopes` に `browse.interact` を追加 | allowlist 外のプロセス、存在しないウィンドウ、前面化に失敗した場合（`FOCUS_DENIED`） |
| マウス / キーボードを操作する（`desktop_move` / `click` / `type` / `key`） | **拒否** | `scopes` に `browse.interact` を追加 | 画面外座標（大幅超過）、許可外キー、kill switch、レート超過、**打ち込む文字列がシェル命令列なら `dsh-command-guard` が拒否 / 承認要求** |
| アプリを起動する（`app_launch`） | **拒否** | `scopes` に `app.launch` を追加 + `allowlist.apps` に対象を列挙 | allowlist 外の名前、パス / 引数 / シェル記号を含む入力、kill switch |
| 再起動 / シャットダウン（`power_action`） | **拒否**（そもそも `os.power` が無い） | §3 の **4 条件すべて** | 1 つでも欠けたら **dry-run**（実行しない）。`allowlist.powerTargets` で片方だけに絞れる |
| いいね / 保存 / フォロー（`social.engage`） | **拒否** | `scopes` に `social.write` を追加 | allowlist 外、kill switch、レート超過 |
| DM / 投稿 / コメント / 削除 / 通報 / 購入（`social.write`） | **恒久拒否** | **不可**（設定・コード変更でも解除しない設計） | 常に拒否。`kind` の固定リスト + ブラウザ層のラベル / `purpose` 判定の二重防御 |
| パスワード / ワンタイムコード / ユーザー名の入力 | **恒久拒否** | **不可** | 常に拒否。資格情報入力欄を検出して止める。Cookie の読み書きもしない |
| ログイン / 2FA / CAPTCHA の自動突破 | **停止** | **不可**（人間がブラウザ UI で行う） | 検出したら `NEEDS_HUMAN` を返し、以後の操作をラッチ（`browse_close` で解除） |
| allowlist 外の URL / 任意の exe・引数 | **拒否** | allowlist への追加（設定変更 + 再読み込み） | 常に既定拒否。ワイルドカードは明示 `*.` のみ、部分一致はしない |
| ファイル / レジストリ / クリップボード / Cookie の読み書き | **提供しない** | — | ツール自体が存在しない |

---

## 3. 電源操作（`power_action`）の三段条件 + 追加ゲート

`power_action` が **実際に `shutdown.exe` を起動する**のは、次の 4 つが同時に真のときだけです。

| # | 条件 | 満たし方 | 欠けたとき |
|---|---|---|---|
| 1 | **スコープ** `os.power` | `scopes` に `os.power` を明示追加 | `SCOPE_DENIED`（実行も dry-run もしない） |
| 2 | **確認トークン** | プロセス起動前に `DSH_POWER_CONFIRM_TOKEN=<長いランダム値>` を設定し、同じ値を `confirmToken` に渡す。トークンは **プロセスごとに 1 回だけ**有効 | `CONFIRM_REQUIRED`（再利用・不一致・欠落） |
| 3 | **環境変数** `DSH_ALLOW_POWER=1` | DSH プロセス起動前に設定 | `dryRun: true` + `missing: ["env:DSH_ALLOW_POWER"]` |
| 4 | **設定ゲート** `powerEnabled: true` | `cordis.patch.yml` の config に明記 | `dryRun: true` + `missing: ["config:powerEnabled"]` |

補足:

- **既定は dry-run 以前に「拒否」**です（既定スコープに `os.power` が無いため）。
  スコープだけ上げた状態でも、トークンが無ければ `CONFIRM_REQUIRED` で止まります。
- トークンは `lib/core/confirm.js` のワンタイム・TTL 5 分のゲートに照合されます。
  このプラグインは**トークン発行ツールを公開しません**（人間が環境変数で渡す運用のみ）。
- 実行コマンドは定数から組み立てる `shutdown.exe /s|/r /t <delaySec>` だけで、
  任意コマンドを混ぜる経路はありません。`delaySec` は 0〜86400 の整数に検証されます。
- 既定の遅延は 60 秒です。`shutdown /a` で中止できる猶予として使ってください。
- `allowlist.powerTargets` に `['shutdown']` 等を書くと、再起動だけを禁止できます
  （**狭める方向のみ**。`format-disk` のような値は policy 側で捨てられます）。
- **検証・テストでは実行経路を踏みません。** 実機の再起動・シャットダウンは行わないでください。

---

## 4. 書き込み系ソーシャル操作の恒久拒否

次の `kind` は `lib/core/policy.js` の固定リストにあり、**どのスコープでも拒否**されます。

```
like / unlike / favorite / follow / unfollow / dm / direct_message / send_dm /
send_message / message / post / create_post / publish / repost / quote / comment /
reply / respond / share / retweet / subscribe / upload / delete / remove /
edit_profile / update_profile / change_settings / block / mute / report / purchase / checkout
```

ブラウザ層はこの上に **意味的な検出**を重ねます（`lib/browser/policies.js`）。

- クリック対象のラベル（"Like" / "いいね" / "Follow" / "Message" 等）を正規化して照合
- `purpose: "social.write"` を渡した時点で即拒否
- 拒否結果には `permanent: true` が付き、監査ログにも `kind: "social.write"` で残る

**これは「できない」ではなく「やらない」設計です。** 回避を試みるコードを足さないでください。

---

## 5. Kill switch（即時停止）

次のいずれかで **全ツールが拒否**されます。判定は毎回のツール呼び出し時に行われます。

| 方法 | 効かせ方 | 効くタイミング |
|---|---|---|
| ファイル（推奨・即効） | 既定: `%LOCALAPPDATA%\dsh-social-desktop-agent\KILL_SWITCH` を作る（中身は何でもよい） | **次のツール呼び出しから即**（毎回ファイル存在を確認） |
| 環境変数 | `DSH_KILL_SWITCH=1` を **DSH プロセス起動前**に設定 | プロセス再起動後から |
| 監視パスの変更 | config `killSwitch: "D:\path\STOP"`、またはプロセス起動前の `DSH_KILL_SWITCH_FILE` | 設定読み込み後 |

- ファイル削除 / 環境変数解除で **戻せます**（プラグイン再読み込みは不要）。
- kill switch は「止める方向」の操作にも効きます。`browse_close` も拒否されるので、
  その場合はブラウザ UI でタブを閉じるか、プラグイン自体を無効化してください。
- 設定で kill switch を「無効化」することはできません（`killSwitch: false` は
  ファイル監視をやめるだけで、`DSH_KILL_SWITCH=1` は常に有効）。

---

## 6. 監査ログ

### 場所

| 設定 | 実際のパス |
|---|---|
| 既定 | `%LOCALAPPDATA%\dsh-social-desktop-agent\audit.jsonl` |
| `auditPath: "<path>"` | そのパス |
| `auditPath: null` | メモリのみ（**テスト専用**。再起動で消える） |

### 形式（1 行 1 レコード、追記専用）

```json
{"ts":"2026-11-17T09:12:34.567Z","scope":"browse.interact","kind":"social.write","target":"Like","result":"deny","reason":"TARGET_DENIED: ソーシャル書き込みは…恒久拒否"}
{"ts":"2026-11-17T09:12:40.101Z","scope":"browse.read","kind":"browse_snapshot","target":"https://www.instagram.com/","result":"allow","reason":"allowed"}
{"ts":"2026-11-17T09:13:02.004Z","scope":"os.power","kind":"power_action","target":"restart","result":"allow","reason":"dry-run: config:powerEnabled"}
```

- フィールドは固定: `ts` / `scope` / `kind` / `target` / `result`（`allow` | `deny`）/ `reason`。
- 改行・タブは 1 行に潰され、1 レコードが 2 行に分裂して見えないようになっています。
- 判断は policy（allow/deny の両方）、ブラウザ層（allow/deny/error）、デスクトップ層
  （allow/deny）から同じファイルへ集約されます。
- **`desktop_type` の入力本文は記録しません**（長さのみ）。パスワード等を渡さない前提は
  変わりませんが、ログに残る範囲も最小化しています。
- 監査ログの書き込み失敗で操作を続行しない設計です（デスクトップ層は `AUDIT_FAILED`、
  policy は判定を変えず `snapshot().audit.lastError` に残す）。失敗に気づいたら kill switch。

### 読み方

```powershell
Get-Content "$env:LOCALAPPDATA\dsh-social-desktop-agent\audit.jsonl" -Tail 20
```

deny だけを見る:

```powershell
Select-String -Path "$env:LOCALAPPDATA\dsh-social-desktop-agent\audit.jsonl" -Pattern '"result":"deny"'
```

---

## 7. 緊急停止手順

1. **まず止める（即効）** — kill switch ファイルを作る:

   ```powershell
   New-Item -ItemType File -Force "$env:LOCALAPPDATA\dsh-social-desktop-agent\KILL_SWITCH"
   ```

2. **ブラウザを閉じる** — DSH のブラウザタブを UI から閉じる（kill switch 中は
   `browse_close` も拒否されます）。
3. **プラグインを無効化** — 恒久的に止める場合:

   ```
   plugin_manager set_bundle  target: "dsh-social-desktop-agent"  enabled: false
   ```

4. **原因を確認** — 監査ログの最後の deny / allow を見て、どのツールが何をしたかを確認。
5. **戻す** — 原因を除いたあと:

   ```powershell
   Remove-Item "$env:LOCALAPPDATA\dsh-social-desktop-agent\KILL_SWITCH"
   ```

   （`DSH_KILL_SWITCH=1` を使った場合は、DSH を環境変数なしで再起動）

6. **再開** — `plugin_manager set_bundle ... enabled: true`。

---

## 8. 人間介入（ログイン / 2FA / CAPTCHA）

ブラウザ層は次のシグナルを検出すると、**そのセッションの以後の操作をラッチ**します。

- ログイン画面・"Log in" / "Sign up" への遷移
- 2FA / ワンタイムコード入力の要求
- チェックポイント / 本人確認 / CAPTCHA / "Just a moment" / bot 検出

返り値は `{ ok:false, code:"NEEDS_HUMAN", needsHuman:true, stopped:true }` です。
モデルはここで止まり、人間に状況を伝えます。人間が DSH のブラウザ UI でログインし、
`browse_close` でセッションを閉じるとラッチが解除されます。

**プラグインは資格情報を受け取りません。** パスワード入力ツールは存在せず、
`browse_type` / `desktop_type` で資格情報欄を狙っても拒否されます。

---

## 9. Instagram の利用規約とアカウント凍結リスク

- Instagram の利用規約は、自動化・スクレイピング・大量操作を制限しています。
  このプラグインを使う場合も、**規約とアカウントのリスクは利用者の責任**です。
- 本プラグインは書き込み系操作を恒久拒否するため「いいね稼ぎ」等はできませんが、
  閲覧・スクロールの速度や頻度によっては、bot 判定・レート制限・アカウント凍結の
  対象になり得ます。
- 既定のレート制限（policy: 30 リクエスト/分/スコープ、ブラウザ層: 最小間隔 1.5 秒・
  200 操作/セッション）は**回避しないでください**。短縮する設定は提供していません。
- ログインは必ず人間が行い、プラグインにパスワードを渡さないでください。
- 収集した内容の保存・再配布は、Instagram の規約と著作権・個人情報の法令に従ってください。

---

## 10. 設定変更（権限昇格）の統制

- スコープを広げる・allowlist にホスト / アプリを足す・`powerEnabled` を true にする —
  これらはすべて **設定ファイルの編集 + プラグイン再読み込み**が必要です。
- 実行中のモデルが自分で権限を上げるツールはありません。`scopes` を返す API も
  「今の許可」を見せるだけで、変更はしません。
- 変更したら、何のために広げたかを README かこのファイルに追記してください。
  監査ログだけでは「なぜ許可したか」は残りません。

---

## 11. このリポジトリの検証で行わないこと

受入検証（`scripts/verify.mjs`, `test/`）は **オフライン**で完結します。

- 実ネットワークアクセス（`browserDriver: 'stub'` の偽ページのみ）
- 実ブラウザ / 実 CDP 接続
- 実 PowerShell の実行（テスト用 fake runner を使用）
- 実 `shutdown.exe` の実行（電源は dry-run の分岐までしか検証しない）
- 実資格情報の入力・保存

この 5 つを検証のために解禁しないでください。実機確認は、人間が kill switch と
`shutdown /a` の猶予を用意したうえで、別途行うものです。

---

## 12. 実行前検査（`dsh-command-guard`）との接続

2026-11-17 のインシデント（判断を省いた一斉停止）を受けて、**実行前の文字列検査**を
ハーネスの共通経路に置いた。このプラグインのツールは次のように二重で見られる。

| ツール | このプラグインの制限 | 追加される検査 |
|---|---|---|
| `desktop_type` | 資格情報欄・ソーシャル書き込み・レート | 打ち込む文字列をコマンドとして走査。`rm -rf /` 等は拒否、`rm notes.txt` 等は承認要求。普通の文章は通す |
| `desktop_click` / `key` / `move` / `focus` | allowlist・座標・kill switch | 監査のみ（文字列を持たないため） |
| `app_launch` | allowlist の名前だけ・引数/パス/シェル記号は拒否 | 監査のみ |
| `power_action` | §3 の 4 条件 | **さらに**承認要求（二重ゲート） |
| `browse_*` | allowlist・恒久拒否リスト | 変更なし |

`dsh-command-guard` のキルスイッチ（`%LOCALAPPDATA%\dsh-command-guard\KILL_SWITCH`）は
このプラグインのキルスイッチとは独立している。**両方**止めたいときは両方のファイルを置くこと。

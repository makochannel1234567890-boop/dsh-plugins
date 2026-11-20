# dsh-mobile-progress — スマホからのセッション開始と結果表示（v0.3.0 設計メモ）

`dsh-mobile-progress` は v0.2.0 まで「進捗を見る」だけのプラグインでした。
v0.3.0 では **スマホから依頼を送って新しいセッションを開始**し、その**進捗から最終結果までを
同じ画面**で追えるようにします。

- 対象プラグイン: `C:/Users/user/Desktop/ローカル実験/dsh-plugins/dsh-mobile-progress`
- 既存の設計メモ: [`MOBILE-PROGRESS.md`](./MOBILE-PROGRESS.md)（v0.2.0 時点の進捗フィード）
- 利用者向けの説明: `dsh-mobile-progress/README.md`

このメモは **実装契約**（Host 側 2 エンドポイント + feed の追加フィールド）を固定するためのものです。
検証結果は §10 に、実測できたものだけを書きます。

---

## 1. 目的

| # | 目的 | 対応する UX |
|---|---|---|
| 1 | スマホで**ワークスペースを選べる** | 依頼パネルの選択肢（`GET /api/workspaces`） |
| 2 | スマホから**プロンプトを送って新規セッションを開始** | 送信ボタン（`POST /api/session`） |
| 3 | 開始したセッションの**進捗→最終結果**を同画面でライブ表示 | 既存 SSE に `session.result` を追加 |

設計方針:

- **既存の仕組みを壊さない。** SSE・PWA・Service Worker・cloudflared トンネル・keep-awake は
  そのまま使い、追加は HTTP 2 本と fold の追加だけにします。
- **セッションログには書き込まない。** 従来どおり読み取り専用の購読で、replay / fork 互換を保ちます。
- **結果は派生キャッシュ。** 真実はセッションログ側にあり、保存するのは表示用の最後の本文だけです。

---

## 2. UX フロー

```
ホーム画面（PWA）
 ├─ 進捗（v0.2.0 から）
 │    依頼文・ステップ・%・ログ
 └─ 依頼を送る（v0.3.0）
      1. ワークスペースを選ぶ      GET  /api/workspaces
      2. プロンプトを入力          maxPromptChars 文字まで
      3. 送信                      POST /api/session → 201
      4. 進捗が流れる              SSE /api/stream
      5. 最終結果が出る            session.result（resultState: "ready"）
```

1. 画面下（または進捗の下）の**依頼パネル**を開く。ワークスペースの選択肢は台帳から読む。
   台帳が読めない・制御が無効・`sessionController` が無い場合は、その旨を出して送信を無効化する。
2. プロンプトを入れて送信。**送信中はボタンを disable**（二重送信の防止）。成功で入力欄をクリア。
3. サーバーは選択されたワークスペースの path を `cwd` にして新規セッションを作り、
   プロンプトを queue モードで流し込む。
4. 以後そのセッションが**追跡対象**（同時 1 セッション）になり、進捗がライブで更新される。
5. ターンが終わると、最後のアシスタント本文が**最終結果**として同じ画面に出る。

失敗時はパネル内にエラー文言を出し、入力を保持したまま再送できるようにします（§5）。

---

## 3. シーケンス

```
phone (PWA)              Host plugin :8790                DSH core
   │                            │                            │
   │ GET /api/workspaces?k=…    │                            │
   │───────────────────────────►│ 台帳を読む                  │
   │                            │ (workspacesFile)           │
   │ 200 {workspaces, control}  │                            │
   │◄───────────────────────────│                            │
   │                            │                            │
   │ POST /api/session?k=…      │                            │
   │ {workspaceId, prompt}      │                            │
   │───────────────────────────►│ 検証（token/サイズ/長さ/path）│
   │                            │ ctx.get('sessionController')│
   │                            │────── create({cwd}) ──────►│
   │                            │◄───── {id, short, cwd} ─────│
   │                            │────── prompt({…}) ────────►│ mode: 'queue'
   │ 201 {session, workspace}   │                            │
   │◄───────────────────────────│                            │
   │                            │       session/event        │
   │                            │◄───────────────────────────│
   │                            │ fold: turn / tool / progress│
   │                            │ fold: assistant/message    │
   │                            │   → session.result         │
   │◄──── SSE /api/stream ──────│                            │
   │ data: {session:{result}}   │                            │
```

---

## 4. API 契約

### 4.1 `GET /api/workspaces`

- 認証: **必須**（`?k=<token>` または `x-progress-token`。無ければ 401）
- メソッド: `GET`

```json
{
  "ok": true,
  "workspaces": [
    {
      "id": "…",
      "title": "dsh-plugins",
      "path": "C:/Users/user/Desktop/ローカル実験/dsh-plugins",
      "updatedAt": "2026-11-17T09:00:00.000Z",
      "sessionCount": 12,
      "exists": true
    }
  ],
  "control": { "enabled": true, "available": true, "error": "" }
}
```

| フィールド | 意味 |
|---|---|
| `workspaces[].id` | 台帳の ID。`POST /api/session` の `workspaceId` に渡す |
| `workspaces[].title` | 画面に出す表示名 |
| `workspaces[].path` | セッションの `cwd` になる絶対パス |
| `workspaces[].updatedAt` | 台帳の更新時刻（あれば） |
| `workspaces[].sessionCount` | そのワークスペースのセッション数（あれば） |
| `workspaces[].exists` | path が実在するか |
| `control.enabled` | `control.enabled` 設定 |
| `control.available` | `sessionController` が取れるか |
| `control.error` | 台帳が読めなかったときの理由。正常時は `""`（空文字） |

台帳が無い・壊れている場合は **`workspaces: []` と `control.error` を返し、500 にはしません**
（画面は「一覧を読めません」と出して送信を無効化する）。

### 4.2 `POST /api/session`

- 認証: **必須**（`?k=` / `x-progress-token`）
- メソッド: `POST`
- `content-type: application/json`
- body: 64KB まで

```json
{ "workspaceId": "…", "prompt": "ログイン画面のバリデーションを直して" }
```

| フィールド | 必須 | 意味 |
|---|---|---|
| `prompt` | **必須** | 送るプロンプト本文（text 1 ブロック） |
| `workspaceId` | どちらか | 台帳の ID。これが本線 |
| `cwd` | どちらか | 台帳に載っている path を直接指定するフォールバック |

成功: **`201`**

```json
{
  "ok": true,
  "session": { "id": "…", "short": "a1b2c3d4", "cwd": "C:/…/dsh-plugins" },
  "workspace": { "id": "…", "title": "dsh-plugins", "path": "C:/…/dsh-plugins" }
}
```

### 4.3 Host 側の実装（`apply(ctx, config)` の中）

`sessionController` は起動時必須にせず、リクエスト時に遅延解決します。

```js
const controller = ctx.get('sessionController')
if (!controller) return sendJson(res, 503, { ok: false, error: 'session_control_unavailable' })

const created = await controller.create({ cwd: workspace.path })
await controller.prompt(
  {
    requestId: `mobile-${Date.now()}-${created.sessionId}`,  // 1 リクエスト 1 個
    sessionId: created.sessionId,                          // create() の戻りは sessionId
    mode: 'queue',
    content: [{ type: 'text', text: prompt }],
    clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,  // Host の TZ
  },
  abortSignal,
)
```

作成したセッションはそのまま**追跡対象**に切り替えます（同時 1 セッション）。
`create` と `prompt` のどちらかが失敗したら `502 session_create_failed`。両方成功してから
`201` を返します。

### 4.4 進捗 feed の追加フィールド

`GET /api/state` と `GET /api/stream` の `data:` に次の 3 つが増えます。

```json
{
  "session": {
    "result": {
      "text": "…最終アシスタント本文…",
      "at": "2026-11-17T09:12:34.000Z",
      "turn": 3,
      "chars": 512,
      "truncated": false
    },
    "resultState": "ready"
  },
  "server": {
    "control": { "enabled": true, "available": true, "workspaces": 2 }
  }
}
```

| フィールド | 値 |
|---|---|
| `session.result` | `null`、または `{ text, at, turn, chars, truncated }` |
| `session.resultState` | `"none"`（まだ結果なし） / `"ready"`（結果あり） |
| `server.control` | `{ enabled, available, workspaces }`（`workspaces` は直近の一覧件数）。理由つきの `error` が要る `GET /api/workspaces` 側とは形が違う |

fold の規則:

- `assistant/message` の **`text` ブロックだけ**を順に連結して保存する。
- **推論（reasoning）・ツール呼び出し・ツール結果は保存しない**（元から配信していない）。
- `control.resultMaxChars` を超えたら切り、`truncated: true` にする。
- `user/message`（次の依頼）が来たら `result` を `null` に戻す（前のターンの結果を残さない）。
- `at` は fold した時刻、`turn` はそのターン番号、`chars` は保存した本文の文字数（切り詰めた後）。

---

## 5. エラーコード

`POST /api/session`:

| ステータス / `error` | 条件 | 画面 |
|---|---|---|
| `400 prompt_required` | `prompt` が空・文字列でない | 送信できない |
| `400 prompt_too_long` | `control.maxPromptChars` 超過 | 上限を添えて表示 |
| `400 workspace_required` | `workspaceId` も `cwd` も無い | 選択を促す |
| `400 workspace_not_found` | 台帳に無い・path が一致しない | 「選び直してください」 |
| `400 invalid_json` | body が JSON として壊れている | 送信しない |
| `403 control_disabled` | `control.enabled: false` | 依頼パネルを出さない |
| `413 payload_too_large` | body が 64KB 超 | 送信しない |
| `415 unsupported_media_type` | `application/json` 以外 | 送信しない |
| `502 session_create_failed` | `sessionController.create()` が失敗 | 「開始できませんでした」 |
| `503 session_control_unavailable` | `sessionController` を取れない | 「この Host では開始できません」 |

検証の順序は **content-type → body（サイズ / JSON） → prompt → `control.enabled` → workspace →
`sessionController`**。メソッドが違う場合は 405（`allow` ヘッダー付き）。
`GET /api/workspaces` は上記のうち `403` / `503` を返さず、`control` に状態を載せて 200 を返します。

共通:

- 認証 NG は **401**（`/api/` 配下すべて）。
- 想定外の例外は 500 にせず、可能な範囲で上表のコードに寄せます。

---

## 6. 失敗時の挙動（設計）

| 状況 | 挙動 |
|---|---|
| `sessionController` が無い（CLI / 別ホスト構成） | `GET /api/workspaces` は `control.available: false`。`POST /api/session` は `503 session_control_unavailable`。進捗表示はそのまま動く |
| 台帳が壊れている / 無い | 一覧は空 + `control.error` に理由。画面は送信を無効化。500 にしない |
| トンネル断（Cloudflare 502/530） | PWA は Service Worker のキャッシュで最後の状態を表示（「オフライン」バナー）。送信は fetch 失敗として扱い、入力を保持する |
| 二重送信 | 送信中はボタンを disable。成功で入力欄をクリア。API 側に冪等キーは無いので、UI 側だけで防ぐ |
| 作成成功・prompt 失敗 | `502 session_create_failed`。作成済みのセッションは DSH 側に残るが追跡は切り替わらず、画面は「開始できませんでした」（進捗はセッションログ側で追える） |
| ターンが終わったが本文が空 | `result` は `null` のまま（`resultState: "none"`）。空文字の結果を出さない |

---

## 7. セキュリティ

- **トークン必須。** `/api/` 配下はすべて `?k=<token>` か `x-progress-token`。シェル
  （HTML/CSS/JS/manifest/アイコン）は従来どおり公開（理由は `MOBILE-PROGRESS.md` §3）。
- **プロンプト長の上限**は `control.maxPromptChars`（既定 8000）、body は 64KB。巨大な送信で
  Host のメモリを食わないようにする。
- **送信先は台帳内の path のみ。** 任意のディレクトリを `cwd` にしてセッションを起こせない。
  未知の path は 400 `workspace_not_found`。
- **結果の保存範囲は最小。** 追跡中セッションの最後のアシスタント `text` を最大
  `control.resultMaxChars` まで。推論・ツール引数・ツール結果・ファイル内容は保存も配信もしない。
  `user/message` でクリアする。
- **公開 URL の注意。** トークン付き URL は「新しいセッションを開始する権限」であり、
  `/api/workspaces` はワークスペースの **path** も返す。URL を他人に見せない。
  漏れたら `~/.dsh/storages/mobile-progress/access-token` を消して再起動し、トークンを再生成する。

---

## 8. 制限

- **追跡は同時 1 セッション。** 新しく開始したセッションに切り替わる（複数同時の購読は未対応）。
- **`create` は `cwd` ベース。** モデル・エージェントプリセット・権限モード・添付は指定できない。
  DSH の既定に従う。
- **プロンプトはテキスト 1 ブロック**のみ（画像・ファイル添付なし）。
- **クイックトンネルは URL が変動する。** 再起動のたびにホーム画面の作成し直しが必要
  （固定したい場合は named トンネル）。
- **台帳の形式に依存する。** `workspacesFile` は DSH のワークスペース台帳（既定
  `~/.dsh/storages/workspace.json`）。形式が変わったら一覧が空になるので `control.error` を見る。
- **結果は最後のターンのみ。** 履歴が欲しい場合はセッションログを見る。

---

## 9. 設定

```yaml
- insert:
    - id: mobile-progress
      name: '@local/dsh-mobile-progress'
      config:
        control:
          enabled: true
          workspacesFile: ''          # 空 = ~/.dsh/storages/workspace.json
          maxPromptChars: 8000
          resultMaxChars: 4000
```

| キー | 既定 | 意味 |
|---|---|---|
| `control.enabled` | `true` | false なら `POST /api/session` は 403 `control_disabled` |
| `control.workspacesFile` | `""` | 台帳 JSON のパス。空なら `~/.dsh/storages/workspace.json` |
| `control.maxPromptChars` | `8000` | プロンプトの最大文字数 |
| `control.resultMaxChars` | `4000` | 保存・配信する結果本文の最大文字数 |

`control: false` の短縮形も受ける（進捗表示だけ使う場合）。

---

## 10. 検証

- 単体（`node --test`）: 台帳パース（壊れた JSON・欠損フィールド）、プロンプト検証
  （空・長すぎ・未知の workspace）、結果 fold（text 連結・切り詰め・`user/message` でクリア）。
- E2E: **モックの `sessionController`** を立て、別ポートで Host を起動して
  `GET /api/workspaces` → `POST /api/session` → SSE に `session.result` が載るまでを確認する。
- **実機（スマホ・公開 URL 経由）の送信は統合後に確認する。** このメモを書いた時点では
  実測していない。未実行の結果はここに書かない。

### 契約と実装の突き合わせ（コード確認済み・2026-11-17）

- `POST /api/session` の `cwd` は台帳と照合される。`workspaceId` を優先し、`cwd` は
  `workspaceId` が無いときだけ使う。
- `control` の形は 2 種類ある。`GET /api/workspaces` は `{enabled, available, error}`
  （正常時 `error: ""`）、状態 feed の `server.control` は `{enabled, available, workspaces}`。
- `201` は `create` と `prompt` の**両方**が成功した後に返る。失敗は `502`。
- `chars` は保存した本文の文字数（切り詰め後）。`turn` はそのメッセージのターン。
- 認証は `/api/` プレフィックス全体に掛かる。`/api/session` 以外の `/api/*` は GET/HEAD のみ。

### 統合時に確認する点

- 二重送信の UI 側 disable が実際のパネル実装に入っているか（未確認）。
- 実機スマホからの送信と、結果が `session.result` に載るまでの実測（未実行）。

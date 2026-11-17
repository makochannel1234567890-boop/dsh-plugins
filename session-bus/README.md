# dsh-session-bus

並行して動いている DSH セッション同士で、進捗を自動共有する Host プラグインです。
加えて、他セッションの一斉停止／一斉再開をモデルから指示できます。

## 何をするか

1. **自動キャプチャ** — `session/event` を購読し、各セッションの最新の依頼・直近の応答・触ったファイル・
   ターン状態（working / idle / blocked / error）を拾います。セッション側の作法は不要です。
2. **自動注入** — 全エージェントのプロンプトに、他セッションの直近進捗ダイジェストを
   `systemPrompt.context` として差し込みます（自分自身のセッションは除外）。
3. **`share_progress` ツール** — モデルが節目・方針変更・ブロッカーを明示的に共有できます。
4. **`session_bus_digest` ツール** — いま見えているダイジェストをその場で確認できます。
5. **`session_bus_control` ツール** — `list` / `stop_all` / `resume_all`。
   停止は `sessionController.cancel`（進行中のターンを中断、保留メッセージは保持）、
   再開は `sessionController.prompt` で停止記録済みのセッションへ再開プロンプトを一斉送信します。
   サブエージェントのセッションは対象外です。

## ストア

`~/.dsh/storages/session-bus/` 配下:

- `entries.jsonl` — セッションごとの最新 1 エントリ（追記型、定期コンパクト）
- `control.json` — `stop_all` の停止記録（`resume_all` の対象）
- `errors.log` — 保存まわりの失敗だけを記録

プロファイルをまたいでも同じ場所を共有します。

## 設定（cordis.patch.yml）

| キー | 既定 | 意味 |
|---|---|---|
| `enabled` | true | プラグイン全体の有効化 |
| `injectPrompt` | true | プロンプトへのダイジェスト注入 |
| `digestMaxChars` | 1400 | 注入するダイジェストの最大文字数 |
| `maxEntries` | 8 | ダイジェストに載せる最大セッション数 |
| `maxAgeMinutes` | 480 | これより古いエントリは載せない |
| `includeSubagents` | false | サブエージェントのセッションも載せる |
| `allowControl` | false（patch で true） | `stop_all` / `resume_all` を許可 |
| `resumePrompt` | 再開指示文 | `resume_all` が送るプロンプト |
| `storeDir` | `~/.dsh/storages/session-bus` | 保存先 |

## 制限

- 進捗は「直近の要約」であり、正しさは保証しません。ダイジェストは参考情報として扱い、
  共有ファイルを触る前には現物を確認してください。
- セッションログには新しいイベント種別を追加しません（再生・フォーク互換のため）。
- `stop_all` は進行中のツール実行も中断します。重要な書き込み中に呼ばないでください。

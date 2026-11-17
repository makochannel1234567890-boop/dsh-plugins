# dsh-fanout — 1セッションをNセッションに開き、最後に自動で統合・検証する

DeepSeek Harness 用のプラグインです。**1つの依頼**で、大きく重さの違う複数の仕事を
渡すと、プラグインが自分で分岐セッションを起動し、仕事を重さで振り分け、終わったら
**統合用のセッションを自動で立ち上げ**、結果の突き合わせ・e2e検証・ビルドまで済ませて
依頼元のセッションに短い報告を返します。

さらに、モデルが制約に押されて「選択肢を広げるのを無意識に省く」現象を打ち消す
**展開ゲート**と、トークン量を目で調整できる **2本のスライダー**（Web UI）を備えます。

## 使い方（モデルから）

```
fanout_start(
  objective: "決済APIの v2 移行。影響範囲は3つ。",
  tasks: [
    { title: "サーバ実装", brief: "<自己完結した指示。触るファイル、受け入れ条件>", weight: 5 },
    { title: "SDK更新",   brief: "<...>", weight: 2, scope: ["packages/sdk"] },
    { title: "移行ガイド", brief: "<...>", weight: 1 },
  ],
  workers: 3,              // 分岐セッション数（スライダー）
  expansion: 60,           // 思考拡張（スライダー。統合時の探索量と見積りに反映）
  verify: ["pnpm test", "pnpm build"],
)
```

- 仕事は `weight` の大きい順に、最も空いているワーカーへ詰められます（LPT）。
  重い仕事1つ＋軽い仕事3つ、のような非対称な束でも偏りません。
- ワーカーには **目的1段落＋自分の仕事＋結果ファイルの置き場所** だけが渡ります。
  親会話も、他のワーカーの会話も渡りません。
- 全ワーカーが落ち着くと、**統合セッションが自動で起動**し、
  `results/worker-*.md` と実物を突き合わせ、`verify` のコマンドを実行して
  `final.md` を書きます。コマンドと終了コードは表として残ります。
- 終わると依頼元セッションに `<fanout_result>` として短い要約が届きます。

進捗: `fanout_status` / 中断: `fanout_stop`。

## 使い方（Web UI から）

コンポーザの上に **Fan-out バー** が出ます。

- **分岐セッション数**（1〜8）: 起動するワーカーの数。
- **思考拡張**（0〜100）: 幅を広げるほど、展開ゲートの探索軸が増えます
  （0=オフ / 1–30=1軸 / 31–60=3軸 / 61–85=5軸+分類ゲート / 86–100=8軸+分類ゲート）。
- 目的とタスク（1行1件 `title :: brief :: weight`）を書いて「開始」。
- タスク欄が空のまま「開始」すると、プラグインは**いまのセッションに分解依頼**を出します。
  モデルが目的を 2〜6 個の非対称な仕事に分け、`fanout_start` を tasks 付きで呼ぶので、
  スライダーの分岐数はそのまま活きます（勝手に1本へ縮退しません）。
- 状態行に、稼働中 run・settled/total・推定トークンが出ます。

スライダー値は `~/.dsh/storages/fanout/config.json` に保存され、次回も残ります。
UI とツールは同じエンジンを叩きます（操作の実装は1つだけ）。

## 展開ゲート（思考の省略を打ち消す仕組み）

`divergence_check(objective, proposal, constraints?, intensity?)` を呼ぶと：

1. **あなたの提案を見せない** 新しい探査セッションを、直交するレンズごとに1本ずつ起動します
   （制約の反転 / 目的の再定義 / 失敗先行 / ズーム / 利害関係者の交代 / 既存解の流用 /
   削除テスト / 非対称な機会）。
2. 各探査は `OPTION:` 行で候補を2〜4個返します。提案を見ていないので、あなたの
   狭め方に引きずられません。
3. ツールは候補を `a1, a2, …` として返し、**ゲートは閉じたまま**です。
   同じ `divergence_check` に `divergence_id` と、**全候補**への
   `adopt / reject / defer + 理由` を付けて再び呼ぶまで閉じています。
4. 分類は `~/.dsh/storages/fanout/divergence/<id>.json` に残ります。後から
   「何を捨てたか」を検証できます。

要点は「発想を増やす」ことではなく、**捨てた選択肢を記録させ、捨てる判断を
見える化する**ことです。トークンを使いすぎないよう、軸の数はスライダーで絞れます。

## インストールと有効化

```
plugin_manager install_bundle  target: <このディレクトリの絶対パス>
plugin_manager set_bundle      target: "dsh-fanout"  enabled: true
```

有効化するとツール4つ（`fanout_start` / `fanout_status` / `fanout_stop` /
`divergence_check`）と、コンポーザ上の Fan-out バーが現れます。バーは
`127.0.0.1:51337` か同一オリジンの `/fanout-api` に接続します。

> **このプロファイルでは正式に有効化済み**です（`set_bundle` → `application: applied`、
> ツールがエージェントに公開されていることを実測）。以前の README にあった
> 「HMR が詰まって `enabled: false` のまま」という状態は、Harness 再起動で解消しました。
> もし別プロファイルへ入れる場合は、上記 2 コマンドを順に実行してください。

### 検証コマンド

```powershell
node test/run-all.mjs        # 54 checks（plan / prompts / bridge）
node --check index.js
node --check client.js
```

## 設定（`cordis.patch.yml` の `config`）

| キー | 既定 | 意味 |
|---|---|---|
| `enabled` | `true` | プラグイン全体の有効化 |
| `maxWorkers` | `8` | 分岐セッション数の上限 |
| `defaultWorkers` | `4` | UI スライダーの初期値 |
| `defaultExpansion` | `40` | 思考拡張スライダーの初期値 |
| `maxExpansion` | `100` | 思考拡張の上限 |
| `workerTimeoutMinutes` | `25` | ワーカー1本あたりの制限時間 |
| `runTimeoutMinutes` | `120` | run 全体の制限時間 |
| `integrate` | `true` | 統合セッションを作るか |
| `archiveWorkers` | `false` | 統合後にワーカーセッションをアーカイブするか |
| `bridgePort` | `51337` | UI バーのローカル制御ポート（127.0.0.1 のみ） |
| `storeDir` | `~/.dsh/storages/fanout` | 永続状態の置き場所 |
| `injectPrompt` | `true` | システムプロンプトに使い方の節を足すか |
| `resultDigestChars` | `1200` | 統合に渡す1ワーカーあたりの要約上限 |
| `notifyCaller` | `true` | 依頼元セッションへ結果を返すか |

## 状態とファイル

```
~/.dsh/storages/fanout/
  config.json                 # UI スライダーの保存値
  bridge.json                 # 実際に使ったポートとトークン
  runs/<runId>/run.json       # run の状態
  runs/<runId>/results/*.md   # ワーカーの結果ファイル
  runs/<runId>/final.md       # 統合レポート
  divergence/<id>.json        # 展開ゲートの候補と分類
```
ワークスペース側にも `.dsh-fanout/runs/<runId>/` ができます（ワーカーが結果を書く場所）。

## 仕組みと制約

- セッション生成は `sessionController.create` → `prompt`。通常のセッションなので
  サイドバーに現れ、人間が中を覗けます。
- 完了検知は `api-session/status` と `session/event`（`turn/end`）。巡回ポーリングは
  せず、締切 watchdog だけが15秒ごとに動きます。
- セッションログに新しいイベント種別は書きません。状態はすべて上記のファイルです。
- **プロセス内メモリの駆動部は再起動で失われます**。run.json / final.md は残るので、
  何がどこまで進んだかは後から読めます。
- UI バーは `127.0.0.1` のみにバインドし、`x-fanout-token`（起動ごとに生成）で守ります。
  `/health` だけがトークンを返します（ループバック限定）。
- 人間の承認が要る操作を代行するものではありません。ワーカーは通常の権限で動きます。

## 設計メモ

- 文脈の節約は「渡さない」ことで実現しています。ワーカーは親会話を持たず、統合は
  ワーカーの全文ではなく 1200 字の要約だけを受け取ります。
- 重さの非対称は LPT パッキングで吸収します（`lib/plan.js`）。
- 展開ゲートの強さは「提案を見せない」ことと「全候補の分類を強制する」ことの2点だけ。
  余計なプロンプトの修辞には頼りません。

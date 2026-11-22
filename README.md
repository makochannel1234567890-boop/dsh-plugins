# dsh-plugins — DeepSeek Harness プラグイン集

[![Sponsor](https://img.shields.io/badge/Sponsor-%E2%9D%A4-ff69b4?logo=github)](https://github.com/sponsors/makochannel1234567890-boop)

**DeepSeek Harness（DSH）を自分で使いやすくするために書いたプラグインのリポジトリです。**
すべて無料・MIT ライセンスで公開しています。

## つくった人

| | |
|---|---|
| 名前 | **mako7studio** |
| GitHub | [@makochannel1234567890-boop](https://github.com/makochannel1234567890-boop) |
| 学年 | **高校2年生** |

授業とテストの合間に、自分の作業環境を良くするために書いています。
DSH のプラグイン機構（Host プラグイン + Cordis バンドルパッチ）を調べながら、
「モデルが実際に困る場面」を1つずつ減らす方針で作っています。

## 支援してくれる人へ

このリポジトリのものは**全部無料で、この先も有料化しません。** MIT ライセンスなので
フォークも再配布も自由です。

ただ、作っているのは高校生1人で、テスト期間は開発が止まります。
「使っている」「役に立った」と思ってもらえたら、
[GitHub Sponsors](https://github.com/sponsors/makochannel1234567890-boop) で
応援してもらえると、次のプラグインを作る時間になります。

お金より嬉しいのは **Star** と **Issue** です。「こう動かなかった」という報告が
いちばん開発の役に立ちます。

---

## 収録プラグイン

| フォルダ | パッケージ | 内容 |
|---|---|---|
| [`dsh-deliberation`](dsh-deliberation/) | `dsh-deliberation` | **承認つき長考モード。** ラウンド数と時間の予算を決めて深く考えさせ、Git 作業ツリーで隔離できる。止めたいときは新しいメッセージを送るだけ |
| [`dsh-mobile-progress`](dsh-mobile-progress/) | `dsh-mobile-progress` | **スマホで進捗を見る PWA。** `todo_write` を自動ミラーし、SSE で即時同期。オフライン表示・cloudflared による公開 HTTPS URL・スリープ抑止つき |
| [`dsh-emulator-lab`](dsh-emulator-lab/) | `dsh-emulator-lab` | **低スペック端末の見積もり。** サイドバーから Android AVD / iOS Simulator を起動し、決定論的な SoC モデル（INT8 TOPS・メモリ帯域・CPU/GPU スコア・熱予算）から FPS を見積もる。「推定」であることとボトルネックを明示 |
| [`dsh-builtin-browser-localfix`](dsh-builtin-browser-localfix/) | — | 内蔵ブラウザを「1 ターン終了ごとにタブを閉じる」ようにするためのパッチ（`turn-cleanup.patch` + 適用スクリプト） |
| [`dsh-social-desktop-agent`](dsh-social-desktop-agent/) | `dsh-social-desktop-agent` | **ソーシャル Web 閲覧＋Windows デスクトップ操作（スコープ制・既定は最小権限）。** ドメイン/アプリの allowlist、いいね・フォロー・DM・投稿・コメント等の書き込みは恒久拒否、電源操作はスコープ＋確認トークン＋環境変数の三段ゲートで既定 dry-run、JSONL 監査ログと kill switch、ログイン/2FA/CAPTCHA 検出時は人間に渡して停止 |

> `dsh-mobile-progress` の `package.json` 上の `name` は、手元のプロファイルから
> link で参照されている都合で `@local/dsh-mobile-progress` のままです。
> インストールするときはフォルダ名（`dsh-mobile-progress`）を指定してください。

> **引退したプラグイン:** `dsh-fanout`（1 セッションを並行ワーカーへ分岐させる仕組み）と、
> それに依存していた並列セッション系（`session-bus` / `session-bus-control` /
> `session-bus-resume` / `crash-recovery`）は引退しました。軽量モデルでは計画と
> 受け入れ基準の設計が安定せず、分解するほど遅く・悪くなるためです。本体は ZIP で
> 手元の `archive/` に保管しており、このリポジトリには含めていません。

### このリポジトリに含めていないもの

- **`dsh-browser-agent`** — 内蔵ブラウザを操作する優れたプラグインですが、
  [hermes-ai-2026 さん作](https://github.com/hermes-ai-2026/dsh-browser-agent)（MIT）の
  別プロジェクトなので、このリポジトリには含めていません。作者の方に感謝します。
- DSH 本体のソース複製や、認証トークンを含むローカル設定も含めていません。

## 動作確認したこと

README に書いたことは、実際に動かして確かめた範囲だけです。

| 項目 | 状態 |
|---|---|
| `dsh-mobile-progress` のテスト | **20 通過** |
| `dsh-deliberation` のテスト | **1 通過** |
| `dsh-social-desktop-agent` のテスト | **279 通過**（core 74 + browser 79 + desktop 109 + 統合 17）。`scripts/verify.mjs` 16 項目 PASS、`scripts/check-plugin.ps1` exit 0 |
| スマホ進捗の PWA オフライン表示 | 実機で確認済み（`shots/pwa-offline.png`） |
| 同一 Wi-Fi 外からの閲覧 | cloudflared 公開 URL 経由で確認済み |

> **注意:** `dsh-mobile-progress` は**進捗の閲覧専用**です。
> スマホから DSH にプロンプトを送る機能はありません（意図的に入れていません）。

## スマホで進捗を見る（3 手順）

1. エージェントに「進捗の公開 URL を教えて」と頼む（`progress_status` が
   `public_url` を返します）。URL は `https://<random>.trycloudflare.com/?k=<token>`。
2. スマホでその URL を開く。**同じ Wi-Fi でなくても届きます**（モバイル回線・別 Wi-Fi 可）。
3. Safari は「共有 → ホーム画面に追加」、Chrome は「メニュー → アプリをインストール」。
   以後はホーム画面のアイコンから起動し、PC が落ちていても直前の状態を表示します。

- PC がスリープすると配信できないので、プラグインが稼働中だけスリープを抑止します
  （`keepAwake`）。「ふたを閉じたらスリープ」だけは電源設定側で無効化が必要です。
- クイックトンネルは**再起動ごとに URL が変わります**。固定したい場合は
  [`dsh-mobile-progress/README.md`](dsh-mobile-progress/README.md) の named トンネルへ。

## インストール

DSH の Plugin Manager（`plugin_manager` ツール）でフォルダを直接指定します。

```
plugin_manager install_bundle  target: <プラグインの絶対パス>
```

- `application: applied` なら即時反映。
- `restart-required` なら DSH を再起動。
- `failed` の diagnostic を確認（`HMR transactions cannot be nested` は
  他のインストールと競合したときに出ます。静穏化後にもう一度実行するか再起動）。

プロファイルの `package.json` / `cordis.patch.yml` を手で書き換えないでください。
インストール・有効化・解除は Plugin Manager が行います。

## プラグインの作り方

同上のリポジトリで、雛形とチェッカーを同梱しています。

```powershell
# 雛形を作る
.\scripts\new-plugin.ps1 -Name my-plugin -Title "My Plugin" -Description "何をするプラグインか"

# 形をチェックする（マニフェスト / patch / ロケール / アイコン / 構文 / テスト）
.\scripts\check-plugin.ps1 -Path .\my-plugin -RunTests
```

作法は [`docs/PLUGIN-GUIDE.md`](docs/PLUGIN-GUIDE.md) にまとめてあります。

## フォルダ規約

```
<plugin>/
├─ package.json          # name / exports / files / dsh.bundle.patch
├─ cordis.patch.yml      # insert する row と既定 config
├─ index.js              # Host プラグイン（export function apply / default service）
├─ public/               # 独自 HTTP を配る場合だけ（静的アセット）
├─ locale/en.json        # meta.title / meta.description（英語）
├─ locale/ja.json        # 同（日本語）
├─ icon.svg              # 128 KiB 以下、プラグイン固有のアイコン
├─ test/                 # node --test
└─ README.md             # 使い方・設定・制限
```

- 1 フォルダ = 1 npm パッケージ。`name` は一意に。
- 表示メタデータ（`locale/*.json` の `meta`）とアイコンは必須です。
- `node_modules/` やビルド生成物、ログ、**秘密情報はコミットしません**。
- ツールを足したら `test/` と README の両方を更新します。
- 破壊的な操作（削除・一斉停止・デプロイ）は必ず承認 UI を挟みます。

## 開発の流れ

1. `scripts/new-plugin.ps1` で雛形を作る
2. `apply(ctx, config)` にツール / イベント / サービスを実装
3. `node --check` と `node --test` を通す
4. `plugin_manager install_bundle` で入れる
5. `cordis_inspect_query`（Config / Tool / Event）で稼働を確認
6. Web UI もしくはプラグイン独自ページを実ブラウザで確認
7. README に設定・制限・確認結果を書く

## 注意点

- **app.asar の中はシェルから読めません。** スキル資料や同梱パッケージの型は
  `cordis_inspect_query` か、プロファイル側の実ファイルから読みます。
- **HMR はプロファイル全体で直列化されます。** 並行セッションが同時に
  プラグインを入れ替えると `HMR transactions cannot be nested` になります。
  1 つずつ操作し、失敗したら静穏化を待って再実行してください。
- **LAN 公開は明示的に。** 独自 HTTP サーバーを `0.0.0.0` に bind する場合は、
  アクセストークンやファイアウォール範囲（Private）を README に書きます。
- プラグインの状態は「派生キャッシュ」です。セッションログを真実とし、
  新しいイベント種別を書き込まないでください（replay / fork 互換）。

## ライセンス

MIT（[`LICENSE`](LICENSE)）。各サブフォルダに独自ライセンスがある場合はそちらが優先です。

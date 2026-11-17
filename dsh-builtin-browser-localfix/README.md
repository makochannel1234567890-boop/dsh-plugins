# dsh-builtin-browser ローカルパッチ：ターン終了時にタブを閉じる

`dsh-builtin-browser`（`dsh_browser_*` ツールを提供しているプラグイン）に、
**エージェントの1ターンが終わった時点で、そのタスクのブラウザセッション（ウィンドウとタブ）を自動で閉じる**
工程を足したもの。終了ワークフローへの追加分をここにまとめてある。

## 何が変わるか

| | 変更前 | 変更後 |
|---|---|---|
| セッションの寿命 | agent コンテキストが破棄されるまで＝**会話が終わるまで** | **1ターン終了ごと**（`agent/turn-stopping`） |
| タブ | ターンをまたいで残り続ける | ターン終了時に閉じる。次のブラウザ操作で新しいセッションが開く |
| 中断・エラー | 何も起きない | `agent/status` → `idle` でも同じ後始末を通す |
| モデル側の前提 | ターンをまたいでページが残る前提で動きがち | 「タブはターンを越えない」とシステムプロンプトで明示 |

タスク（DSH セッション）ごとに独立しているので、**他のセッションのタブは閉じない**。
サブエージェントにも同じ規則が効く（それぞれ自分のセッションだけ閉じる）。

## 反映

プラグインの ESM は起動時に読み込まれるので、**DSH を再起動**して初めて効く。

## 止めたいとき

どちらか。

- 環境変数 `DSH_BROWSER_KEEP_TABS=1` を立てて DSH を起動する
- `cordis.patch.yml` の `tool-browser` 行の config に `closeTabsOnTurnEnd: false` を書く

```yaml
- id: tool-browser
  name: dsh-builtin-browser/tool-browser
  config:
    closeTabsOnTurnEnd: false
```

## 仕組み

`lib/tool-browser/index.js` の `apply()` 内。ツール層はタスクキー（＝DSH セッション id）→
ブラウザセッション id の対応表を持っているので、イベントで終了を拾ってその対応表を引く。

```js
ctx.on('agent/turn-stopping', payload => closeTaskSession(payload?.agent?.id ?? 'default'))
ctx.on('agent/status', payload => {
  if (payload?.status === 'idle') closeTaskSession(payload?.agent?.id ?? 'default')
})
```

`closeTaskSession()` は**先に対応表から消してから** `browser.close()` を投げる。
既存の `agent.ctx.effect`（会話終了時の破棄）と二重に閉じにいかないため。
閉じるのを待たないのでターン終了は遅れず、失敗しても次のブラウザ操作が新規セッションを開く。

あわせてシステムプロンプトに1節（`tool:browser/turn-cleanup`, order 151）を足し、
モデルが「前のターンで開いたページが残っている」前提で操作しないようにしている。

## 検証

```
node test\run.test.mjs                                 # 有効時：ターン終了で閉じる／他タスクは無傷
$env:DSH_BROWSER_KEEP_TABS=1; node test\run.test.mjs   # 無効時：購読もノートも作られない
```

偽の Cordis コンテキストと偽の `ctx.browser` で、`apply()` から
`agent/turn-stopping` / `agent/status` まで実際に通している（`test/node_modules/@deepseek-ai/dsh-tools`
は、本物が app.asar の中にあり Node 単体から解決できないための最小シム）。

`test\lib` はプラグインの `lib` のコピー（単体で動かすため）。パッチを当て直したら
次の1行で追随させる:

```
Remove-Item .\test\lib -Recurse -Force; Copy-Item "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-builtin-browser\lib" .\test\lib -Recurse
```

## プラグインを更新したとき

`node_modules` 側は上書きされてパッチは消える。このフォルダで:

```
pwsh -File .\apply.ps1
```

- 既定の対象は `%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-builtin-browser`
- 上書き前に `backups\<timestamp>\` へ退避し、置き換え後に `node --check` で壊れていないか確認、
  失敗したら自動で元に戻す
- 何度流しても同じ結果（冪等）
- パッチを当てた版（0.5.8）以外では警告して止まる。`-ForceVersion` で強行できるが、
  先に `turn-cleanup.patch` を目で確認すること

`git apply` で当てる場合はプラグインのルートで:

```
git apply -p1 --whitespace=nowarn <このフォルダ>\turn-cleanup.patch
```

## フォルダ構成

| パス | 中身 |
|---|---|
| `patched/lib/tool-browser/index.js` | パッチ後の実コード（実行される側） |
| `patched/src/tool-browser/index.ts` | パッチ後の TS ソース（次にビルドし直すとき用） |
| `orig/` | パッチ前の現物（0.5.8） |
| `turn-cleanup.patch` | `orig/` → `patched/` の差分 |
| `apply.ps1` | 上記を当て直すスクリプト |
| `test/` | 偽 ctx での挙動テスト |

## 制約・注意

- **人間が見ているページも閉じる。** 「開いて見せて」と言われたページはターン終了で消える。
  モデル側には「残したいならターン終了前に保存を提案する」ようプロンプトで指示しているが、
  恒久的に残したいならうえの `closeTabsOnTurnEnd` を切るか、内容を保存させること。
- これは**プロファイルに入っている npm パッケージへのローカルパッチ**。上流
  （github.com/wqty123/dsh-browser）に取り込まれるものではない。恒久的にしたいなら upstream へ。
- サイドバーの `browser_*` ツールを提供している `dsh-browser-agent` は**別プラグイン**で、
  このパッチの対象外（こちらは webview を再利用するのでタブは溜まりにくい）。

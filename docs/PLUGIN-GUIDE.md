# DSH プラグイン作成ガイド

このワークスペースのプラグインは、DeepSeek Harness（DSH）の **Cordis プラグイン +
バンドル YAML** という 2 層でできています。ここでは実際に動く最小形から、
ツール・設定・検証・落とし穴までをまとめます。

---

## 1. 全体像

```
package.json  ── dsh.bundle.patch ──► cordis.patch.yml
                                          │ insert
                                          ▼
                                    index.js (Host plugin)
                                          │ apply(ctx, config)
                          ┌───────────────┼────────────────┐
                          ▼               ▼                ▼
                     tools.register   ctx.on(...)    systemPrompt.section
```

- **Host プラグイン** … Harness 本体のプロセス内で動く。ツール、イベント購読、
  プロンプト注入、HTTP、サービス利用ができる。
- **Client プラグイン** … Web UI のスロットに React コンポーネントを差す。
  画面を Web UI 内に出すときだけ必要（スマホ用の独立ページは Host 側で配信する）。
- **バンドル** … `package.json` の `dsh.bundle.patch` が指す YAML。プロファイルの
  レイヤーに row を `insert` する。Plugin Manager はこの単位で導入・有効化する。

---

## 2. 最小の Host プラグイン

### package.json

```json
{
  "name": "@local/my-plugin",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./index.js",
    "./locale/*.json": "./locale/*.json",
    "./icon": "./icon.svg"
  },
  "files": ["index.js", "cordis.patch.yml", "locale/*.json", "icon.svg"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

`files` は公開時の同梱物。ローカルフォルダを link インストールする場合は
`files` でフィルタされないため、実行に必要なファイルが実際に存在するか確認する。

### cordis.patch.yml

```yaml
- insert:
    - id: my-plugin
      name: '@local/my-plugin'
      config:
        enabled: true
```

`id` はプロファイル内で一意。`config` は `apply(ctx, config)` の第 2 引数になる。

### index.js

```js
export const name = 'my-plugin'
export const inject = ['tools']   // 必須サービス。無いプロファイルでは起動しない

export function apply(ctx, config = {}) {
  ctx.tools.register({
    name: 'my_ping',
    description: 'Return a ping with the current time.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'at'],
        properties: { ok: { type: 'boolean' }, at: { type: 'string' } },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute() {
      return { ok: true, at: new Date().toISOString() }
    },
  })

  ctx.effect(() => () => {
    // タイマー・サーバー・リスナーをここで片付ける
  })
}
```

- **登録は必ず `apply` の中で**。`ctx.effect` / `ctx.on` が返す disposer は
  プラグイン停止時に呼ばれる。
- 任意サービスは `ctx.get('name')`。無い場合に throw しないこと。
- ログは `ctx.logger?.warn?.()`。失敗しても本体を壊さない。

---

## 3. ツール定義

```js
ctx.tools.register({
  name: 'my_tool',
  description: 'モデルに読ませる説明。いつ使うかを具体的に。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['path'],
    properties: {
      path: { type: 'string', description: '対象ファイル。' },
      mode: { type: 'string', enum: ['fast', 'safe'] },
    },
  },
  output: {
    schema: { /* 返り値の JSON Schema */ },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
  },
  async execute(args, exec) {
    // exec.agent  … 呼び出した Agent
    // exec.callId … ツールコール ID
    // exec.signal … AbortSignal
    return { ok: true }
  },
  presentCall: (args) => ({ card: 'generic', title: 'My tool', kind: 'other' }),
})
```

- `description` は **発見可能性**の一部。何をするか・いつ使うか・使わない場面を書く。
- `additionalProperties: false` と `required` を明示するとモデルの誤入力を減らせる。
- 破壊的操作は `ctx.userQuestions.ask()` か承認 UI を挟む（fail closed）。

---

## 4. プロンプトへの注入

```js
const systemPrompt = ctx.get('systemPrompt')
systemPrompt?.section({
  name: 'tool:my-plugin',
  order: 2500,          // 既存セクションの間。大きいほど後ろ
  text: '## My plugin\n\n…モデルへの短い指示…',
})
```

長すぎる注入は全ターンのコストになる。数行に収め、ツール説明と重複させない。

---

## 5. セッションイベントの読み方

```js
ctx.on('session/event', (session, event) => {
  if (event.type === 'tool/call' && event.data.name === 'todo_write') {
    // event.data.arguments は JSON 文字列
  }
}, { global: true })
```

- `session/event` は **コミット後の読み取り専用フィード**。新しいイベント種別を
  書き込まない（replay / fork が壊れる）。
- 進捗のような派生状態はキャッシュとして持ち、セッションログを真実とする。
- 毎イベントで全ログを再走査しない。必要なら `sessionProjections` を使う。
- `turn/start` / `turn/end` / `tool/call` / `user/message` が進捗表示の基本材料。

---

## 6. HTTP を出す 2 通り

| 方法 | 用途 | 注意 |
|---|---|---|
| `ctx.get('webServer').register(route)` | DSH Web UI と同一オリジン | 認証済み GUI の内側。LAN からは既定で届かない |
| `node:http` を自分で listen | スマホなど別端末向け | bind 先・トークン・ファイアウォールを自分で管理 |

独自サーバーは `0.0.0.0` に出すと LAN に公開される。少なくとも:

- `accessToken` を設定できるようにする（`?k=` / ヘッダー）。
- 返すデータを最小化する（本文やツール引数をそのまま出さない）。
- README に「同じ Wi-Fi のみ」「Private プロファイル」と明記する。

静的ファイルは `import.meta.url` から `public/` を解決して配信する。
app.asar 内のテンプレートを直接読もうとしない（コピーして使う）。

---

## 7. インストールとライフサイクル

```
plugin_manager install_bundle  target: <絶対パス>
```

結果の `application` を見る:

| 値 | 意味 | 対応 |
|---|---|---|
| `applied` | 即時反映 | `cordis_inspect_query` で確認 |
| `restart-required` | 再起動で反映 | DSH を再起動 |
| `overridden` | 上位レイヤーが優先 | プロファイルの patch を確認 |
| `failed` | 失敗 | `error.diagnostic` を読む |
| `cancelled` | 中止 | 何も変わっていないか確認 |

- **HMR はプロファイル全体で直列**。並行セッションが同時にインストールすると
  `HMR transactions cannot be nested` になる。1 つずつ操作し、静穏化を待つ。
- 既にリンク済みのパッケージを差し替えた場合、新しい JS は再起動まで読まれない
  ことがある。`application` と実際の `fiberPhase` を分けて確認する。
- プロファイルの `package.json` / `cordis.patch.yml` を手で編集しない。

---

## 8. 検証

1. **静的** … `node --check index.js`、`node --test test/`
2. **マニフェスト** … `scripts/check-plugin.ps1 -Path .\my-plugin -RunTests`
3. **稼働** … `cordis_inspect_query` の `Config.listConfigs` / `Tool` / `Event`
4. **ツール** … 実際に 1 回呼び、出力 schema と副作用を確認
5. **画面** … 実ブラウザで開き、SSE / 再接続 / スマホ幅を確認
6. **後始末** … テストで変えた状態・起動したサーバーを戻す

「インストールできた」は「動いた」ではありません。ツール呼び出し・画面・
ログの 3 点で確認してから完了とします。

---

## 9. よくある落とし穴

- **app.asar はシェルから見えない** … スキル資料や同梱型は `read` ツールか
  `cordis_inspect_query` で読む。
- **Node のモジュール解決** … ローカルプラグインに依存を足すとプロファイル側の
  `node_modules` に入る。実行時 import はその解決に従う。
- **`ctx.on` のスコープ** … `{ global: true }` を付けないと、その Agent 文脈の
  イベントしか届かない場合がある。
- **setup 中の `ctx.get(...)` は空を返しうる** … 数百エントリの構成では、Web
  サーバーはプラグインと並列に立ち上がる。`apply()` の同期コードで
  `ctx.get('webServer')` を一度だけ読むと、その瞬間は `undefined` で、
  `register` を呼ばないまま静かに諦める（実測: サイドバーパネルだけ
  「トンネル未接続」になり、スマホ側とトンネルは正常のまま）。
  `ctx.inject(['webServer'], (scope) => { ... })` で後追いし、載ったかどうかを
  状態（例: `server.bridge.mounted`）にも出すと、次は 1 回の確認で済む。
- **ツール出力スキーマ** … `type: ['number','null']` のような union は避け、
  単純な型 + センチネル値（-1 など）にすると安全。
- **静的ファイルのキャッシュ** … 開発中は `cache-control: no-store`。
- **PWA** … Service Worker は HTTPS / localhost のみ。LAN の HTTP では
  「ホーム画面に追加」によるショートカットとして動く。
- **時刻** … 端末の時計がずれると「◯秒前」が崩れる。サーバーの `now` と
  `updatedAt` の差分で描画すると安定する。
- **トークンを静的アセットに掛けると画面が壊れる** … `<script src="/app.js">` や
  `<link href="/style.css">` はページのクエリ文字列を引き継がない。`/?k=…` で開いても
  これらの要求は `?k=` 無しで飛ぶので 401 になる（実測で踏んだ）。守るのは `/api/*`
  だけで、シェル（HTML/CSS/JS/アイコン/manifest）は公開する。
- **PWA の manifest は動的生成** … `start_url` にトークンを埋めないと、ホーム画面から
  起動した瞬間 401 になる。`/manifest.webmanifest` をリクエスト毎に組み立てる。
- **死んだトンネルは 502/530 を返す** … ネットワークエラーではないので `catch` では
  拾えない。Service Worker は `response.ok` で判定し、非 2xx もキャッシュへ落とす。
- **子プロセスを常駐させるなら `-Command` に長いコードを渡さない** … Windows では
  引用符の再パースで壊れて即終了する（終了コード 1 を実測）。`.ps1` を書いて `-File`
  で渡し、停止時は `taskkill /pid <pid> /T /F` でツリーごと落とす。

---

## 10. 提出前チェックリスト

- [ ] `id` / パッケージ名が一意
- [ ] `locale/en.json` と `locale/ja.json` に `meta.title` / `meta.description`
- [ ] 256 KiB 以下のアイコン（SVG / PNG）
- [ ] `apply` 内の登録がすべて `ctx.effect` / `ctx.on` で解除可能
- [ ] ツールの `description` / `parameters` / `output` が揃っている
- [ ] `node --check` と `node --test` が通る
- [ ] インストール結果の `application` を確認した
- [ ] README に設定・制限・確認手順を書いた
- [ ] 秘密情報・`node_modules`・ログを含めていない

# {{TITLE}}

{{DESCRIPTION}}

## 使い方

```
plugin_manager install_bundle  target: <このフォルダの絶対パス>
```

インストール後、`{{TOOL}}_ping` ツールで疎通確認できます。

## 設定

| キー | 既定 | 意味 |
|---|---|---|
| `enabled` | `true` | プラグイン全体の有効化 |

プロファイルの `cordis.patch.yml` で同じ `id` を指定すると `config` を上書きできます。

## 開発

```powershell
node --check index.js
node --test test/
```

## TODO

- [ ] ping ツールを本来の機能に置き換える
- [ ] README に制限と確認手順を書く
- [ ] `locale/en.json` と `locale/ja.json` の文言を確定する

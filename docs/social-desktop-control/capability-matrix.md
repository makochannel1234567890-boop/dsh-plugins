# 能力マトリクス — dsh-social-desktop-agent

「どの能力を、誰が既に提供していて、本プラグインが再利用するのか／新規に作るのか」を
1 枚で示す。設計の本文は `docs/social-desktop-control/design.md`。

- 調査時点: 2026-11-17（本リポジトリ `C:\Users\user\Desktop\ローカル実験\dsh-plugins`）
- 調査方法: ファイル実読（`dsh-browser-agent/package.json`、`dsh-browser-agent/lib/index.js`、
  `dsh-browser-agent/lib/cdp.js`、`dsh-browser-agent/skills/dsh-browser-agent/references/tools.md`、
  `docs/PLUGIN-GUIDE.md`）＋ プロファイル実読（`~/.dsh/profiles/desktop/package.json`）。
  実行して確かめたのは「プロファイルに両系統が入っている」ところまで。

---

## 1. 提供元の一覧（実測）

| 記号 | 提供元 | 実体 | 呼び出し名 |
|---|---|---|---|
| **B** | `dsh-builtin-browser` 0.5.8 | プロファイル依存（配布バンドル） | `dsh_browser_*` |
| **A** | `dsh-browser-agent` 1.0.1 | リポジトリ内 `dsh-browser-agent/`（`link:` 導入、有効） | `browser_*` |
| **P** | DSH 組込み | ツールカタログに存在 | `pwsh` |
| **N** | 本プラグイン | `dsh-social-desktop-agent/`（新規） | `browse_*` `desktop_*` `app_launch` `power_action` |

**A と B は同じことができる**（a11y 読み、クリック、入力、スクリーンショット、スクロール）。
本プラグインは**どちらも再実装しない**。`lib/browser/driver.js` の抽象に
`stub-driver.js`（テスト）/ `cdp-driver.js`（実機）を差し込み、**上にポリシーを被せる**。

---

## 2. 能力 × 提供元 × 本プラグインの判断

| 能力 | B (`dsh_browser_*`) | A (`browser_*`) | P (`pwsh`) | N の扱い | 判断 |
|---|---|---|---|---|---|
| ページを開く | ✅ | ✅ `browser_open` | — | `browse_open`（allowlist 検査つき） | **再利用 + ゲート** |
| 構造を読む（a11y/ref） | ✅ `a11y`/`snapshot` | ✅ `browser_read {mode:ax}` | — | `browse_snapshot` | **再利用 + ゲート** |
| テキスト読取 | ✅ `content` | ✅ `browser_read {mode:text}` | — | 同上（mode で切替） | 再利用 |
| クリック | ✅ | ✅ `browser_click`（CDP 実入力） | — | `browse_click` | **再利用 + deny/資格情報判定** |
| 入力 | ✅ `fill`/`type` | ✅ `browser_type` | — | `browse_type` | **再利用 + deny/資格情報判定** |
| スクロール | ✅ | ✅ `browser_scroll` | — | `browse_scroll` | 再利用 |
| スクリーンショット | ✅ | ✅ `browser_screenshot`（CDP 優先） | — | `browse_screenshot` | 再利用 |
| タブ管理/クローズ | ✅ | ✅ `browser_tabs` | — | `browse_close` | 再利用 |
| ネットワーク観測 | 一部 | ✅ `browser_network`/`browser_cdp` | — | **提供しない**（読者は不要） | 対象外 |
| リクエスト改変/遮断 | ❌ | ✅ `browser_policy` | — | **提供しない**（ToS リスク） | 意図的に対象外 |
| Cookie の export/import | ❌ | ✅ `browser_cookies` | — | **呼ばない**（資格情報を扱わない） | 意図的に対象外 |
| 任意 JS 実行 | ⚠️ 限定的 | ✅ `browser_eval` | — | **提供しない**（deny を迂回できる） | 意図的に対象外 |
| 画面キャプチャ（デスクトップ全体） | ❌ | ❌ | ⚠️ 可（長いスクリプト要） | `desktop_observe` | **新規** |
| カーソル位置・ウィンドウ列挙 | ❌ | ❌ | ⚠️ 可（P/Invoke 要） | `desktop_observe` | **新規** |
| カーソル移動/クリック | ❌ | ❌ | ⚠️ 可 | `desktop_move` `desktop_click` | **新規** |
| キー入力（OS 全体） | ❌ | ⚠️ ページ内のみ | ⚠️ 可 | `desktop_type` `desktop_key` | **新規** |
| アプリ起動 | ❌ | ❌ | ✅ `Start-Process` | `app_launch`（allowlist のみ） | **新規 + ゲート** |
| 再起動/シャットダウン | ❌ | ❌ | ✅ `shutdown.exe` | `power_action`（三重ゲート） | **新規 + 三重ゲート** |
| スコープ制御 | ❌ | ❌ | — | `lib/core/scopes.js` | **新規** |
| ドメイン allowlist | ❌ | ❌ | — | `lib/core/policy.js` | **新規** |
| 書き込み系ソーシャルの恒久拒否 | ❌ | ❌ | — | `FORBIDDEN_KINDS` + `classifySocialLabel` | **新規** |
| レート制限 | ❌ | ❌ | — | `lib/core/policy.js`（トークンバケット） | **新規** |
| 監査ログ（JSONL / ハッシュ連鎖） | ❌ | ❌ | — | `lib/core/audit.js` | **新規** |
| kill switch | ❌ | ❌ | — | `lib/core/killswitch.js` | **新規** |
| CAPTCHA/2FA/ログイン検出 | ❌ | ❌ | — | `lib/browser/policies.js` | **新規** |

> **重複の解消方針**: A と B の両方が有効なので、N は「どちらか一方を選ぶ」ことを
> 強制しない。driver が能力を検出し、`engine` フィールドで実際に使った系統を返す。
> 片方しか無い環境では `DEPENDENCY_MISSING` を返して**静かに劣化しない**。

---

## 3. 足りない能力（＝本プラグインの存在理由）

1. **スコープ制御**（最小権限の既定）。
2. **allowlist**（ドメイン / アプリ / 電源対象）。
3. **書き込み系ソーシャルの恒久拒否**（どのスコープでも解除不可）。
4. **レート制限**。
5. **監査ログ**。
6. **kill switch**。
7. **人間介入**（CAPTCHA/2FA/ログインで停止）。
8. **デスクトップ面**（観測・入力・起動・電源）。

既存 A/B/P はいずれも「できる」だけで、**してよいかの判断を持っていない**。
本プラグインの価値は能力追加ではなく**判断層**にある。

---

## 4. スコープ × 能力の許可表（受入の基準）

✅ = 許可 / ⛔ = 拒否 / 🔑 = 確認トークン必須 / 🚫 = 恒久拒否（スコープ・トークンで解除不可）

| 能力 | `browse.read` | `browse.interact` | `app.launch` | `os.power` |
|---|---|---|---|---|
| `browse_open`（allowlist 内） | ✅ | ✅ | ✅ | ✅ |
| `browse_snapshot` / `browse_screenshot` | ✅ | ✅ | ✅ | ✅ |
| `browse_scroll` / `browse_close` | ✅ | ✅ | ✅ | ✅ |
| `browse_click`（閲覧要素） | ⛔ | ✅ | ✅ | ✅ |
| `browse_type`（検索欄） | ⛔ | ✅ | ✅ | ✅ |
| いいね / フォロー / DM / 投稿 / コメント | 🚫 | 🚫 | 🚫 | 🚫 |
| パスワード・2FA コードの入力 | 🚫 | 🚫 | 🚫 | 🚫 |
| CAPTCHA の解答 | 🚫 | 🚫 | 🚫 | 🚫 |
| allowlist 外のドメイン | ⛔ | ⛔ | ⛔ | ⛔ |
| `desktop_observe` / `desktop_move` | ⛔ | ⛔ | ✅ | ✅ |
| `desktop_click` / `desktop_type` / `desktop_key` | ⛔ | ⛔ | ✅ | ✅ |
| `app_launch`（allowlist 内） | ⛔ | ⛔ | 🔑 | ✅ |
| `app_launch`（allowlist 外） | 🚫 | 🚫 | 🚫 | 🚫 |
| `power_action`（restart/shutdown） | ⛔ | ⛔ | ⛔ | 🔑+env |
| `power_action`（`force` 付き） | ⛔ | ⛔ | ⛔ | 🔑+env+追加確認 |
| 任意コマンド実行 | 🚫 | 🚫 | 🚫 | 🚫 |

> `os.power` 行の 🔑 は**毎回**必要（単回・5 分 TTL・対象束縛）。加えて
> `DSH_ALLOW_POWER=1` と `dryRun:false` の明示が要る（設計書 §5.7）。

---

## 5. 受入テスト（完全オフライン）との対応

| ケース | 期待 | 何で担保するか |
|---|---|---|
| 設定なしで起動 | `effectiveScopes = ['browse.read']` のみ | `scopes.test.mjs` |
| `browse.click` を `browse.read` で呼ぶ | `SCOPE_DENIED`（実行しない） | `tools.test.mjs` + fake policy |
| `like` を `os.power` で呼ぶ | `TARGET_DENIED`（恒久拒否が scope より優先） | `policy.test.mjs` |
| allowlist 外 URL | `TARGET_DENIED`、遷移しない | `policies.test.mjs` |
| CAPTCHA 画面でのクリック | `HUMAN_REQUIRED`、リトライしない | stub driver（`challenge` を返す） |
| 連続クリックで上限超過 | `RATE_LIMITED`、実行回数が増えない | fake clock |
| kill switch 中の全ツール | `KILL_SWITCH`（`social_status` 除く） | `killswitch.test.mjs` |
| `power_action` 既定 | `executed:false` + `planned` のみ（**絶対に実行しない**） | `power.test.mjs` |
| トークン再利用 | 2 回目は `CONFIRM_REQUIRED` | `confirm.test.mjs` |
| 監査のハッシュ連鎖 | 1 行改竄で検証が落ちる | `audit.test.mjs` |
| 入力本文の監査 | 平文が残らず `sha256` + 長さだけ | `audit.test.mjs` |

**禁止事項**: 実ブラウザ起動、実 PowerShell（`shutdown.exe` 等）、実ネットワーク、
実資格情報。driver / runner は DI で fake に差し替える。

---

## 6. 停止点（fail closed）の一覧

「どこで止まるか」を先に決めておくと、実装が迷わない。判定は**この順**で行い、
**最初に該当した停止点で拒否**する（後段の allow は前段の deny を覆せない）。

| 順 | 停止点 | 実装 | 返るコード | 実行されるか |
|---|---|---|---|---|
| 1 | kill switch（env / 番兵ファイル） | `lib/core/killswitch.js` | `KILL_SWITCH` | ❌ |
| 2 | スコープ未付与（未知名も含む） | `lib/core/scopes.js` + `policy.js` | `SCOPE_DENIED` | ❌ |
| 3 | ドメイン / アプリ / 電源対象が allowlist 外 | `lib/core/policy.js` | `TARGET_DENIED` | ❌ |
| 4 | 恒久拒否（書き込み系ソーシャル・資格情報・CAPTCHA） | `FORBIDDEN_KINDS` / `classifySocialLabel` / `detectCredentialInput` | `TARGET_DENIED` | ❌ |
| 5 | レート制限超過 | `policy.js` トークンバケット | `RATE_LIMITED` | ❌ |
| 6 | 確認トークン欠落/不一致/TTL 切れ/使用済み | `lib/core/confirm.js` | `CONFIRM_REQUIRED` | ❌ |
| 7 | 人間介入の必要な画面（CAPTCHA/2FA/checkpoint/login） | `lib/browser/policies.js` | `HUMAN_REQUIRED` | ❌ |
| 8 | 座標が仮想スクリーン外（4px 超） | `lib/desktop/input.js` | `TARGET_DENIED` | ❌ |
| 9 | 電源の三重条件のいずれか欠け | `lib/desktop/power.js` | `CONFIRM_REQUIRED` | ❌ |
| 10 | ここまで通った | 各ツール | `ok:true` | ✅（監査に記録） |

**fail closed の原則**: 判定に必要な情報が**取れない**場合（allowlist 未設定、
driver 不在、監査ログに書けない）は「許可」ではなく「拒否」に倒す。例外は
`social_status`（状況確認）だけで、これは停止中も動く。

---

## 8. 既知の限界（この表が保証しないこと）

| 限界 | 意味 | 誰が埋めるか |
|---|---|---|
| 実機での動作は未検証 | 本書は「何をどこに置くか」の設計であり、実ブラウザ・実 PowerShell での
  E2E は含まない（安全要件により意図的にやらない） | 人間が手動で 1 回だけ確認する受入チェックリスト |
| Instagram の DOM は変わる | ラベル集合・URL パターンは**定期的に陳腐化する** | 実装は「不明なら拒否」なので、陳腐化は
  「便利でなくなる」方向に倒れ、危険側には倒れない |
| ラベル偽装は可能 | 悪意あるページが `aria-label="Like"` を別要素に付けられる | そもそも操作対象は allowlist のドメインのみ。
  未知のドメインは開かない |
| OS 権限は越えられない | UAC 昇格・ロック画面・別セッションのデスクトップ | 設計上 `PRIVILEGE_REQUIRED` で停止する |
| 本プラグインは sandbox ではない | env もファイルも読めるプロセスはゲートを迂回できる | OS アカウント権限と DSH サンドボックスが最終境界
  （設計書 R5） |
| 座標は物理ピクセルでなく論理ピクセル | DPI 100% 以外では見た目と数値がずれる | `desktop_observe` が `dpi.scale` と
  仮想スクリーン矩形を返し、`desktop_click` は範囲外を拒否する |

**表の読み方**: 「提供元」列は**能力の有無**だけを言う。**してよいか**は「N の扱い」列と
§4 の許可表が決める。既存の A/B/P が「できる」ことは、本プラグインが「許可する」ことを
意味しない。

---

## 9. 更新履歴

| 日付 | 変更 | 根拠 |
|---|---|---|
| 2026-11-17 | 初版。A/B/P の棚卸し、4 スコープ、停止点 10 段、受入テスト対応表 | リポジトリ実読 + プロファイル実読 |

---

## 10. 参照した既存ファイル（すべて実在）

| パス | 何のために読んだか |
|---|---|
| `docs/PLUGIN-GUIDE.md` | プラグインの最小形・`apply` 内登録・`-Command` の落とし穴 |
| `templates/plugin-template/index.js` | `ctx.tools.register` / `ctx.get('systemPrompt')` / `ctx.effect` の実例 |
| `templates/plugin-template/package.json` | `type:module` / `exports` / `dsh.bundle.patch` / `scripts.test` |
| `templates/plugin-template/cordis.patch.yml` | `insert` row の形 |
| `dsh-browser-agent/package.json` | 版・依存・`dsh.bundle` / `dsh.client` |
| `dsh-browser-agent/lib/index.js` | `browser_*` 19 ツールの実名 |
| `dsh-browser-agent/lib/cdp.js` | CDP の到達範囲と `pickTarget` の安全护栏 |
| `dsh-browser-agent/README.md` | 何ができて何ができないか（既知境界） |
| `dsh-browser-agent/skills/dsh-browser-agent/references/tools.md` | 各ツールの引数・戻り値・engine 表記 |
| `scripts/check-plugin.ps1` | マニフェスト検証の受入コマンド |
| `dsh-social-desktop-agent/package.json` | 新プラグインの manifest（実測） |
| `dsh-social-desktop-agent/lib/core/{scopes,errors,policy,confirm,audit,killswitch}.js` | 実装済みの契約（スコープ順序・コード・判定順序） |
| `dsh-social-desktop-agent/lib/browser/{tools,policies,driver,stub-driver}.js` | ツール名・ラベル/資格情報/CAPTCHA 判定 |
| `dsh-social-desktop-agent/lib/desktop/{win,observe,input,apps,power,tools}.js` | Windows 実行経路・DPI/座標検証・電源ゲート |
| `~/.dsh/profiles/desktop/package.json`（環境パス） | A と B の両方が有効であることの根拠 |

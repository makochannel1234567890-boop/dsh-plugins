# Instagram 実機検証（2026-11-17 22:19–23:17 JST）

対象: `dsh-social-desktop-agent` の `browse_*` 7 ツール
目的: 「Instagram を起動し、ログインし、動画を閲覧できるか」を**実測**で確認する。

## 結論

| 検証項目 | 判定 | 根拠（実測） |
|---|---|---|
| インスタを起動 | **可** | `browse_open` が `{ok:true,url,title:"Instagram"}` を返し、CDP の page target が Instagram を表示。スクショに実ページが写る |
| ログイン | **可**（既存セッションの復元） | 認証後 UI（プロフィール `/makochannel1234567890/`・ホーム・メッセージ）が出る。ログイン壁は出ず、資格情報入力も発生しない |
| 動画の閲覧（再生） | **可（条件付き）** | 投稿ページで `<video>` が `readyState:4` / `duration:34.7s` / `1920x1080` / `paused:false`、`currentTime` が 23.94→26.45、16.56→18.57、30.65→32.67 と連続して進行。スクショに別フレーム（ポスター→26 秒付近のカット）が写る |

条件は 1 点だけ重大: **Chrome のウィンドウが可視であること**（下記 G1）。

## 検証環境

- プロファイル: `~/.dsh/profiles/desktop`（実行中プロセスの引数で確認）
- プラグイン設定: `browserDriver: cdp` / `cdpPort: 9222` / `cdpAllowPageTargets: true` /
  scopes `browse.read, browse.interact, social.write, app.launch`（`os.power` なし）
- 専用ブラウザ: `chrome.exe --remote-debugging-port=9222 --user-data-dir=%LOCALAPPDATA%\dsh-social-desktop-agent\chrome-profile`
  （プロファイルは既存のものを再利用 → Instagram のセッションが保持されていた）
- 観測手段: CDP（同一 Chrome の page target）で `Runtime.evaluate` / `Page.captureScreenshot`。
  プラグインを経由しない独立観測なので、「プラグインが操作している Chrome で何が起きたか」を直接測れる。

## 実測ログ（要点）

```
22:19  9222 待受なし → browse_open は DRIVER_ERROR: fetch failed（監査に deny 記録）
22:20  専用 Chrome 起動 → CDP OK Chrome/157.0.8103.79
22:22  browse_open(instagram.com) 1 回目: 90 秒でタイムアウト（ただし画面遷移は成功していた）
22:23  browse_open 2 回目: ok（url/title 返却）
22:29  browse_snapshot: count 28。プロフィールリンク=/makochannel1234567890/ → ログイン確認
22:31  browse_open(/p/Dfja7nMv4VJ/): ok。投稿本文・コメント・「音声ミュート済み」ボタンを取得
22:32  video 実測: readyState 0 / paused true / w,h=0  → 未再生
22:34  document.visibilityState = "hidden", hasFocus=false → メディア読込が止まる原因と判明
22:45  Chrome 窓を前面化（SetForegroundWindow）→ まだ hidden
22:58  窓の実体を確認: ハンドルは在るが IsWindowVisible=False（＝非表示のまま生成）
       SetWindowPos(SWP_SHOWWINDOW) で表示 → IsWindowVisible=True
23:05  リール一覧（video 15 本）を開いたらレンダラ暴走（1 プロセス CPU 10,252 秒・Runtime 応答不能）
       → プラグインの browse_close 後もタブは残存（target 一覧に残る）
23:07  ハングしたタブを /json/close/<id> で名指しで閉じる → 最後のタブだったため Chrome 終了
23:11  Chrome を再起動＋窓を可視化（5 窓すべて可視）→ browse_open ok
23:12  動画再生を確認: readyState 4 / paused false / 23.94→26.45（+2.51 秒）
23:15  browse_click(e8=音声ミュート済み) 1 回目: 60 秒タイムアウト・監査記録なし
23:16  再試行: ok を返すが video.muted は true のまま（＝UI 効果なし）
```

## 分かった制約（今後の運用に効く）

- **G1: 窓が非表示だと動画は読み込まれない。**
  Chromium は `visibilityState:"hidden"` の間、メディアの読込を事実上止める。
  この環境では、エージェント側シェルから `Start-Process` で起動した Chrome の窓が
  `IsWindowVisible=False` で生成された（`ShowWindow(SW_SHOWNORMAL)` では復帰せず、
  `SetWindowPos(..., SWP_SHOWWINDOW)` で可視化できた）。
  → 起動手順に「窓を可視化する」1 手を入れるか、`--disable-backgrounding-occluded-windows`
  などのフラグで起動するのが安定。
- **G2: 初回の `browse_open` が 90 秒を超えることがある。** 遷移自体は成功しているので、
  2 回目以降は返る。コールドスタート時のタイムアウト値（プラグイン側 RPC 20 秒 / 接続 6 秒）と
  実測の乖離はここ。
- **G3: `browse_close` はタブを閉じ切らないことがある。** セッション状態をリセットする一方で
  CDP target が残り、ハングしたままだと `CDP Page.enable` タイムアウト（20 秒）で以後の
  `browse_open` が失敗する。今回は `/json/close/<targetId>` で解消した。
- **G4: `browse_click` の「ok」は UI 効果を保証しない。** ミュートボタン（ref e8）は
  `button` / name 空として解決され、ok が返るが `video.muted` は不変だった。
  対象要素の同定（実ボタンかラッパーか）が課題。
- **G5: リール一覧（同時 15 video）はこの環境では重すぎる。** 単発の投稿ページは安定。
- 設計どおりの安全側: ログイン壁 / CAPTCHA 検出時は `NEEDS_HUMAN` で停止し、資格情報は扱わない。
  いいね・フォロー・DM・投稿・コメントは恒久拒否（今回は該当操作を試行していない）。

## 再現手順（短縮版）

```powershell
$exe='C:\Program Files\Google\Chrome\Application\chrome.exe'
$ud="$env:LOCALAPPDATA\dsh-social-desktop-agent\chrome-profile"
Start-Process $exe -ArgumentList @('--remote-debugging-port=9222',"--user-data-dir=$ud",
  '--no-first-run','--no-default-browser-check','https://www.instagram.com/')
# 窓が IsWindowVisible=False なら SetWindowPos(SWP_SHOWWINDOW) で可視化する
```

その後エージェントから:

```
browse_open { url: "https://www.instagram.com/p/Dfja7nMv4VJ/" }
browse_snapshot { maxNodes: 60 }   # ログイン後 UI と投稿内容が取れる
```

## 検証の限界

- 動画の「再生」は Chrome 内の `<video>` 状態と画面フレームで確認した。音声出力（実際に耳で
  聞こえるか）は未測定（ミュート状態が既定のため）。
- ホームフィード／リール一覧の継続視聴は未確認（G5 で環境が耐えなかった）。
- 本検証は 1 アカウント（`@makochannel1234567890`）・1 端末での実測。

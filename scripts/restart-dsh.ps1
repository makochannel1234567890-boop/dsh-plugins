# restart-dsh.ps1 — DeepSeek Harness を終了して起動し直す。
#
# 使い方（**DSH の外**から。通常のターミナル / Explorer から）:
#   pwsh -NoProfile -File "<このパス>"
#
# なぜ「外から」なのか（2026-11-20 の調査で分かったこと）:
#   旧版は DSH の中（エージェントのツール呼び出し）から起動される前提で書かれていて、
#   `Stop-Process` で DSH を止めた直後に **自分も巻き添えで死ぬ**。すると
#   「停止だけして再起動しない」状態になり、アプリが閉じたままになる。
#   scripts/restart-dsh.log の 2026-11-17T21:59:04 は
#   `stopping main pid=8024` で終わっており、その後の `relaunching` が無い。
#   さらに dsh-command-guard は `DeepSeek Harness` を終了対象に含むコマンドを
#   tier3（致命的・承認でも解除不可）として拒否するため、エージェントからは
#   そもそも実行できない。
#
#   そこでこの版は、**自分が DSH の子孫だと分かったら何もせず終了**する。
#   半分だけ止まる事故を起こさないことを、停止より先に保証する。
#
# 安全:
#   - 引数は受け取らない（このファイルに固定）。
#   - 対象は `DeepSeek Harness.exe` の全プロセス（メイン＋描画＋GPU など）。
#     メインだけ止めると子が残り、次回起動が単一インスタンス制約で失敗しうる。
#   - 停止を待ち合わせてから起動し、新しい pid を確認してから `done` を書く。
#   - 実行ログは scripts/restart-dsh.log に追記する。

$ErrorActionPreference = 'Stop'

$log = Join-Path $PSScriptRoot 'restart-dsh.log'
$exe = 'C:\Users\user\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe'
$procName = 'DeepSeek Harness.exe'

function Write-Log([string]$message) {
  $line = "[{0}] {1}" -f (Get-Date).ToString('s'), $message
  try { Add-Content -Path $log -Value $line -Encoding utf8 } catch { }
}

function Get-DshProcesses {
  @(Get-CimInstance Win32_Process -Filter "Name='$procName'" -ErrorAction SilentlyContinue)
}

# $PID から親をたどり、祖先 pid の集合を返す（最大 32 段で打ち切り）。
function Get-AncestorIds([int]$startPid) {
  $seen = New-Object 'System.Collections.Generic.HashSet[int]'
  $cur = $startPid
  for ($i = 0; $i -lt 32 -and $cur -gt 0; $i++) {
    if (-not $seen.Add($cur)) { break }
    $row = Get-CimInstance Win32_Process -Filter "ProcessId=$cur" -ErrorAction SilentlyContinue
    if ($null -eq $row) { break }
    $cur = [int]$row.ParentProcessId
  }
  $seen
}

function Format-Ids($items) {
  (@($items) | ForEach-Object { $_.ProcessId }) -join ','
}

if (-not (Test-Path -LiteralPath $exe)) {
  Write-Log "abort: exe not found at $exe"
  Write-Output "abort: exe not found at $exe"
  exit 1
}

$dsh = Get-DshProcesses

# --- 先に「自分は DSH の中にいるか」を判定する（停止より前） ---------------
if ($dsh.Count -gt 0) {
  $ancestors = Get-AncestorIds -startPid $PID
  $inside = @($dsh | Where-Object { $ancestors.Contains([int]$_.ProcessId) })
  if ($inside.Count -gt 0) {
    $ids = Format-Ids $inside
    Write-Log "refused: helper (pid $PID) is a descendant of DSH (pid $ids); stopping DSH here would kill the helper before it could relaunch. Run this script from a terminal outside DeepSeek Harness."
    Write-Output "refused: このヘルパは DSH の子プロセスです（DSH pid=$ids）。ここで止めると再起動できません。"
    Write-Output 'DSH の外のターミナルから実行してください:'
    Write-Output "  pwsh -NoProfile -File `"$PSCommandPath`""
    exit 2
  }
} else {
  Write-Log 'no DSH process found; launching only'
}

# --- 停止 ---------------------------------------------------------------
if ($dsh.Count -gt 0) {
  Write-Log 'waiting 10s for in-flight turns to settle'
  Start-Sleep -Seconds 10

  Write-Log ("stopping {0} process(es): {1}" -f $dsh.Count, (Format-Ids $dsh))
  foreach ($p in $dsh) {
    try {
      Stop-Process -Id ([int]$p.ProcessId) -Force -ErrorAction Stop
    } catch {
      Write-Log ("stop failed pid={0}: {1}" -f $p.ProcessId, $_.Exception.Message)
    }
  }

  $deadline = (Get-Date).AddSeconds(45)
  while ((Get-Date) -lt $deadline) {
    if ((Get-DshProcesses).Count -eq 0) { break }
    Start-Sleep -Seconds 2
  }
  $left = Get-DshProcesses
  if ($left.Count -gt 0) {
    Write-Log ("still alive after 45s: {0}" -f (Format-Ids $left))
  } else {
    Write-Log 'all DSH processes exited'
  }
}

# --- 起動 ---------------------------------------------------------------
Write-Log 'relaunching'
Start-Process -FilePath $exe
Start-Sleep -Seconds 8

$new = Get-DshProcesses
if ($new.Count -eq 0) {
  Write-Log 'FAILED: no DSH process after relaunch; start it manually'
  Write-Output 'FAILED: 再起動できませんでした。手動で DeepSeek Harness を起動してください。'
  exit 3
}

Write-Log ("relaunched pids: {0}" -f (Format-Ids $new))
Write-Log 'done'
Write-Output ("done: relaunched pids {0}" -f (Format-Ids $new))

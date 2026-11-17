<#
.SYNOPSIS
  dsh-builtin-browser に「ターン終了時にタスクのブラウザセッションを閉じる」パッチを当てる。

.DESCRIPTION
  プロファイルに npm で入っている dsh-builtin-browser の
    lib/tool-browser/index.js   ← 実際に動くコード
    src/tool-browser/index.ts   ← 次にビルドし直すとき用
  を patched/ の内容で置き換える。置き換える前に必ずバックアップを取る。

  プラグインを更新すると node_modules 側は上書きされてこのパッチは消える。
  そのときはこのスクリプトをもう一度流せばよい（何度流しても同じ結果になる）。

.PARAMETER Target
  プラグインのディレクトリ。省略時は desktop プロファイルの既定位置。

.PARAMETER ForceVersion
  パッチを当てた版（0.5.8）以外でも実行する。

.EXAMPLE
  pwsh -File .\apply.ps1
  pwsh -File .\apply.ps1 -Target 'C:\path\to\node_modules\dsh-builtin-browser'
#>
[CmdletBinding()]
param(
  [string]$Target = (Join-Path $env:USERPROFILE '.dsh\profiles\desktop\node_modules\dsh-builtin-browser'),
  [switch]$ForceVersion
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

if (-not (Test-Path $Target)) {
  throw "プラグインが見つかりません: $Target`n-Target で指定してください。"
}

$manifestPath = Join-Path $Target 'package.json'
if (-not (Test-Path $manifestPath)) {
  throw "package.json がありません。dsh-builtin-browser のディレクトリを指していますか: $Target"
}
$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
if ($manifest.name -ne 'dsh-builtin-browser') {
  throw "対象が違います: $($manifest.name)（dsh-builtin-browser ではありません）"
}
$patchedAgainst = '0.5.8'
if ($manifest.version -ne $patchedAgainst -and -not $ForceVersion) {
  Write-Warning "このパッチは dsh-builtin-browser $patchedAgainst 用です（インストール済み: $($manifest.version)）。"
  Write-Warning '上流が該当箇所を変えている可能性があります。turn-cleanup.patch を目で確認してから -ForceVersion で続行してください。'
  exit 2
}

$files = @('lib\tool-browser\index.js', 'src\tool-browser\index.ts')
$backup = Join-Path $here ('backups\' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
$suffix = 1
while (Test-Path $backup) { $backup = Join-Path $here ('backups\' + (Get-Date -Format 'yyyyMMdd-HHmmss') + "-$suffix"); $suffix++ }
New-Item -ItemType Directory -Force -Path $backup | Out-Null

foreach ($rel in $files) {
  $live = Join-Path $Target $rel
  $fresh = Join-Path $here "patched\$rel"
  if (-not (Test-Path $fresh)) { throw "パッチ側のファイルがありません: $fresh" }
  if (Test-Path $live) {
    $dest = Join-Path $backup $rel
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest) | Out-Null
    Copy-Item $live $dest -Force
  }
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $live) | Out-Null
  Copy-Item $fresh $live -Force
  Write-Host "patched: $rel"
}

# 壊れた JS を配るのが一番まずいので、置き換えたあとに構文を確認し、失敗したら戻す。
$libFile = Join-Path $Target 'lib\tool-browser\index.js'
$check = & node --check $libFile 2>&1
if ($LASTEXITCODE -ne 0) {
  Write-Warning "構文チェックに失敗したので元に戻します:`n$check"
  foreach ($rel in $files) {
    $saved = Join-Path $backup $rel
    if (Test-Path $saved) { Copy-Item $saved (Join-Path $Target $rel) -Force }
  }
  exit 1
}

Write-Host ''
Write-Host "完了: $Target"
Write-Host "バックアップ: $backup"
Write-Host '反映には DSH の再起動が必要です（プラグインの ESM は起動時に読み込まれます）。'

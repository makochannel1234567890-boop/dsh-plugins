#Requires -Version 5.1
<#
.SYNOPSIS
  Create a new DSH plugin folder from templates/plugin-template.

.EXAMPLE
  .\scripts\new-plugin.ps1 -Name dsh-my-tool -Title "My Tool" -Description "Adds a my_tool capability."

.EXAMPLE
  .\scripts\new-plugin.ps1 -Name experimental -Title "Experimental" -Description "..." -PackageName "@me/experimental"
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$Name,

  [Parameter(Mandatory = $true)]
  [string]$Title,

  [Parameter(Mandatory = $true)]
  [string]$Description,

  [string]$PackageName
)

$ErrorActionPreference = 'Stop'

if ($Name -notmatch '^[a-z][a-z0-9-]*$') {
  throw "Name must match ^[a-z][a-z0-9-]*$ (lowercase letters, digits, hyphens): '$Name'"
}

$root = Split-Path -Parent $PSScriptRoot
$template = Join-Path $root 'templates\plugin-template'
$target = Join-Path $root $Name

if (-not (Test-Path $template)) {
  throw "Template not found: $template"
}
if (Test-Path $target) {
  throw "Target already exists: $target"
}
if ([string]::IsNullOrWhiteSpace($PackageName)) {
  $PackageName = "@local/$Name"
}

$toolName = $Name -replace '-', '_'

Copy-Item -Path $template -Destination $target -Recurse

$replacements = [ordered]@{
  '{{NAME}}'        = $Name
  '{{ID}}'          = $Name
  '{{PACKAGE}}'     = $PackageName
  '{{TITLE}}'       = $Title
  '{{DESCRIPTION}}' = $Description
  '{{TOOL}}'        = $toolName
}

$files = Get-ChildItem -Path $target -Recurse -File
foreach ($file in $files) {
  $text = Get-Content -LiteralPath $file.FullName -Raw
  foreach ($token in $replacements.Keys) {
    $text = $text.Replace($token, $replacements[$token])
  }
  Set-Content -LiteralPath $file.FullName -Value $text -NoNewline -Encoding UTF8
}

Write-Host ""
Write-Host "Created $target" -ForegroundColor Green
Write-Host ""
Write-Host "Next:" -ForegroundColor Cyan
Write-Host "  1. Edit index.js and cordis.patch.yml"
Write-Host "  2. Run: .\scripts\check-plugin.ps1 -Path .\$Name -RunTests"
Write-Host "  3. Install: plugin_manager install_bundle target: $target"
Write-Host "  4. Verify the tool, then the screen (if the plugin serves one)"
Write-Host ""

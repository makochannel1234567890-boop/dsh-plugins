#Requires -Version 5.1
<#
.SYNOPSIS
  Validate a plugin folder before installing it.

.DESCRIPTION
  Checks the manifest, bundle patch, Host entry, locale metadata, icon, README,
  JavaScript syntax, and (optionally) the unit tests. Prints PASS/FAIL per
  check and exits non-zero when anything fails.

.EXAMPLE
  .\scripts\check-plugin.ps1 -Path .\dsh-mobile-progress

.EXAMPLE
  .\scripts\check-plugin.ps1 -Path .\my-plugin -RunTests
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$Path,

  [switch]$RunTests
)

$ErrorActionPreference = 'Stop'

$failures = [System.Collections.Generic.List[string]]::new()
$warnings = [System.Collections.Generic.List[string]]::new()

function Pass([string]$message) {
  Write-Host "  PASS  $message" -ForegroundColor Green
}

function Fail([string]$message) {
  $script:failures.Add($message)
  Write-Host "  FAIL  $message" -ForegroundColor Red
}

function Warn([string]$message) {
  $script:warnings.Add($message)
  Write-Host "  WARN  $message" -ForegroundColor Yellow
}

function Check([string]$label, [scriptblock]$test) {
  try {
    $result = & $test
    if ($result -eq $true) { Pass $label } else { Fail $label }
  } catch {
    Fail "$label ($($_.Exception.Message))"
  }
}

$pluginPath = (Resolve-Path -LiteralPath $Path).Path
Write-Host ""
Write-Host "Checking $pluginPath" -ForegroundColor Cyan

# --- package.json -----------------------------------------------------------

$manifestPath = Join-Path $pluginPath 'package.json'
if (-not (Test-Path -LiteralPath $manifestPath)) {
  Fail 'package.json is missing'
  $manifest = $null
} else {
  try {
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    Pass 'package.json parses'
  } catch {
    Fail "package.json is not valid JSON ($($_.Exception.Message))"
    $manifest = $null
  }
}

if ($null -ne $manifest) {
  Check 'package.json has a name' { -not [string]::IsNullOrWhiteSpace($manifest.name) }
  Check 'package.json has a version' { -not [string]::IsNullOrWhiteSpace($manifest.version) }
  Check 'package.json declares dsh.bundle.patch' {
    $null -ne $manifest.dsh -and $null -ne $manifest.dsh.bundle -and
    -not [string]::IsNullOrWhiteSpace($manifest.dsh.bundle.patch)
  }
  Check 'package.json exports "."' {
    $null -ne $manifest.exports -and $null -ne $manifest.exports.PSObject.Properties['.']
  }

  if ($null -ne $manifest.dsh -and $null -ne $manifest.dsh.bundle -and $manifest.dsh.bundle.patch) {
    $patchPath = Join-Path $pluginPath $manifest.dsh.bundle.patch
    Check 'bundle patch file exists' { Test-Path -LiteralPath $patchPath }
    if (Test-Path -LiteralPath $patchPath) {
      $patchText = Get-Content -LiteralPath $patchPath -Raw
      Check 'bundle patch contains an insert list' { $patchText -match '(?m)^\s*-\s*insert:' }
      Check 'bundle patch names the package' {
        -not [string]::IsNullOrWhiteSpace($manifest.name) -and $patchText.Contains($manifest.name)
      }
    }
  }
}

# --- Host entry -------------------------------------------------------------

$indexPath = Join-Path $pluginPath 'index.js'
if (-not (Test-Path -LiteralPath $indexPath)) {
  Fail 'index.js is missing'
} else {
  Check 'index.js syntax is valid' {
    $output = & node --check $indexPath 2>&1
    $LASTEXITCODE -eq 0 -and $output.Count -eq 0
  }
  $indexText = Get-Content -LiteralPath $indexPath -Raw
  Check 'index.js exports apply() or a default service' {
    $indexText -match 'export\s+function\s+apply' -or $indexText -match 'export\s+default\s+class'
  }
}

# --- locale metadata --------------------------------------------------------

foreach ($locale in @('en', 'ja')) {
  $localePath = Join-Path $pluginPath "locale\$locale.json"
  if (-not (Test-Path -LiteralPath $localePath)) {
    Fail "locale/$locale.json is missing"
    continue
  }
  try {
    $data = Get-Content -LiteralPath $localePath -Raw | ConvertFrom-Json
    $title = $data.meta.title
    $description = $data.meta.description
    Check "locale/$locale.json has meta.title and meta.description" {
      -not [string]::IsNullOrWhiteSpace($title) -and -not [string]::IsNullOrWhiteSpace($description)
    }
  } catch {
    Fail "locale/$locale.json is not valid JSON"
  }
}

# --- icon -------------------------------------------------------------------

$iconPath = Join-Path $pluginPath 'icon.svg'
if (-not (Test-Path -LiteralPath $iconPath)) {
  Fail 'icon.svg is missing'
} else {
  $iconSize = (Get-Item -LiteralPath $iconPath).Length
  Check 'icon.svg is 256 KiB or smaller' { $iconSize -le 262144 }
  Check 'icon.svg looks like SVG' {
    (Get-Content -LiteralPath $iconPath -Raw) -match '<svg'
  }
}

# --- README & hygiene -------------------------------------------------------

Check 'README.md exists' { Test-Path -LiteralPath (Join-Path $pluginPath 'README.md') }

$nodeModules = Join-Path $pluginPath 'node_modules'
if (Test-Path -LiteralPath $nodeModules) {
  Warn 'node_modules exists in the plugin folder; it is ignored by git'
}

$logs = Get-ChildItem -LiteralPath $pluginPath -File -Filter '*.log' -ErrorAction SilentlyContinue
if ($logs.Count -gt 0) {
  Warn "log files present: $($logs.Name -join ', ')"
}

# --- unit tests -------------------------------------------------------------

if ($RunTests) {
  $testDir = Join-Path $pluginPath 'test'
  if (Test-Path -LiteralPath $testDir) {
    $testFiles = Get-ChildItem -LiteralPath $testDir -File -Filter '*.test.mjs' -ErrorAction SilentlyContinue
    if ($testFiles.Count -eq 0) {
      Warn 'test/ exists but has no *.test.mjs files'
    } else {
      Check "unit tests pass ($($testFiles.Count) files)" {
        Push-Location $pluginPath
        try {
          & node --test @($testFiles.FullName) 2>&1 | Out-Null
          $LASTEXITCODE -eq 0
        } finally {
          Pop-Location
        }
      }
    }
  } else {
    Warn 'test/ does not exist; -RunTests skipped'
  }
}

# --- summary ----------------------------------------------------------------

Write-Host ""
if ($failures.Count -eq 0) {
  Write-Host "OK: $($pluginPath)" -ForegroundColor Green
  if ($warnings.Count -gt 0) {
    Write-Host "Warnings: $($warnings.Count)" -ForegroundColor Yellow
  }
  exit 0
}

Write-Host "Failed: $($failures.Count)" -ForegroundColor Red
foreach ($failure in $failures) {
  Write-Host "  - $failure" -ForegroundColor Red
}
exit 1

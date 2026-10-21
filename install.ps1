#Requires -Version 7.0
<#
.SYNOPSIS
  Install, upgrade or uninstall the subagent-model-pin DSH profile plugin.

.DESCRIPTION
  Copies plugin.mjs into <DshHome>/profiles/<Profile>/plugins/ and, when the
  profile patch has no subagent-model-pin entry yet, appends patch.snippet.yml.
  The operation is idempotent: running it again only refreshes the plugin file.

  Profile plugins are not hot-reloaded: restart DSH and open a NEW session
  afterwards (the model-selection whitelist is captured per session).

.PARAMETER Profile
  DSH profile name. Defaults to desktop.

.PARAMETER DshHome
  DSH home directory. Defaults to ~/.dsh.

.PARAMETER Uninstall
  Remove the plugin file and the patch block installed by this script.

.EXAMPLE
  pwsh -File .\install.ps1

.EXAMPLE
  pwsh -File .\install.ps1 -Profile web

.EXAMPLE
  pwsh -File .\install.ps1 -Uninstall
#>
[CmdletBinding()]
param(
  [string]$Profile = 'desktop',
  [string]$DshHome,
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if (-not $DshHome) { $DshHome = Join-Path $HOME '.dsh' }

$source = Join-Path $PSScriptRoot 'plugin.mjs'
$snippetPath = Join-Path $PSScriptRoot 'patch.snippet.yml'
$profileDir = Join-Path (Join-Path $DshHome 'profiles') $Profile
$patchFile = Join-Path $profileDir 'cordis.patch.yml'
$targetDir = Join-Path $profileDir 'plugins'
$target = Join-Path $targetDir 'subagent-model-pin.mjs'

function Read-Text([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return '' }
  return [System.IO.File]::ReadAllText($Path)
}

function Write-Text([string]$Path, [string]$Text) {
  $utf8 = [System.Text.UTF8Encoding]::new($false)
  [System.IO.File]::WriteAllText($Path, $Text, $utf8)
}

if (-not (Test-Path -LiteralPath $profileDir)) {
  throw "DSH profile not found: $profileDir. Start DSH once with -Profile $Profile so it creates the profile, or pass -DshHome/-Profile explicitly."
}
if (-not (Test-Path -LiteralPath $source)) { throw "plugin source missing: $source" }
if (-not (Test-Path -LiteralPath $snippetPath)) { throw "patch snippet missing: $snippetPath" }

$patchText = Read-Text $patchFile
$newline = if ($patchText.Contains("`r`n")) { "`r`n" } else { "`n" }
$snippet = (Read-Text $snippetPath).TrimEnd() -replace "`r`n", "`n"
if ($newline -eq "`r`n") { $snippet = $snippet -replace "`n", "`r`n" }
$hasBlock = $patchText -match 'id:\s*subagent-model-pin'

function Remove-PatchBlock([string]$Text) {
  # Drop the `- insert:` entry whose nested list contains our plugin id; other
  # top-level entries are left untouched.
  $lines = [System.Collections.Generic.List[string]]::new()
  foreach ($line in ($Text -split "`r?`n")) { $lines.Add($line) }

  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -notmatch '^-\s*insert:\s*$') { continue }
    $end = $i + 1
    while ($end -lt $lines.Count -and $lines[$end] -match '^\s+\S') { $end++ }
    $block = ($lines[$i..($end - 1)]) -join "`n"
    if ($block -match 'id:\s*subagent-model-pin') {
      $lines.RemoveRange($i, $end - $i)
      $i--
    }
  }

  while ($lines.Count -gt 0 -and [string]::IsNullOrWhiteSpace($lines[$lines.Count - 1])) {
    $lines.RemoveAt($lines.Count - 1)
  }
  if ($lines.Count -eq 0) { return '' }
  return (($lines -join $newline) + $newline)
}

if ($Uninstall) {
  if (Test-Path -LiteralPath $target) {
    Remove-Item -LiteralPath $target -Force
    Write-Host "removed plugin -> $target"
  } else {
    Write-Host "plugin not installed: $target"
  }
  if ($hasBlock -and (Test-Path -LiteralPath $patchFile)) {
    Write-Text $patchFile (Remove-PatchBlock $patchText)
    Write-Host "removed patch block -> $patchFile"
  } else {
    Write-Host "patch block not present: $patchFile"
  }
  Write-Host 'Restart DSH to unload the plugin.'
  return
}

if (-not (Test-Path -LiteralPath $targetDir)) {
  New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
}
Copy-Item -LiteralPath $source -Destination $target -Force
Write-Host "plugin -> $target"

if ($hasBlock) {
  Write-Host "patch  -> subagent-model-pin entry already present, left unchanged ($patchFile)"
} else {
  $separator = if ($patchText.Length -eq 0) { '' } elseif ($patchText.EndsWith($newline)) { $newline } else { $newline + $newline }
  Write-Text $patchFile ($patchText + $separator + $snippet + $newline)
  Write-Host "patch  -> appended subagent-model-pin entry to $patchFile"
}

Write-Host ''
Write-Host 'Next: restart DSH (profile plugins are not hot-reloaded), then open a NEW session.' -ForegroundColor Yellow
Write-Host 'Whitelist reminder: allowedModels is snapshotted per session; branches inherit the source session''s snapshot.'

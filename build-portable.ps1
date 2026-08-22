#!/usr/bin/env pwsh
#Requires -Version 5.1
<#
.SYNOPSIS
    Build the self-contained Readable Studio Windows x64 portable ZIP.

.DESCRIPTION
    This is the canonical project-root Windows build entrypoint. The resulting
    archive runs without Node, npm, pnpm, git, an installer, or an updater on
    the destination machine. Runtime data, logs, cache, and Chromium user data
    are created under <exeDir>\ReadableStudioData. Runtime-specific environment
    overrides remain end-user concerns and are never baked into the archive.

.PARAMETER Namespace
    Runtime namespace embedded in the artifact. Default: rg.

.PARAMETER DropDir
    Directory that receives Readable Studio-<namespace>-portable.zip.

.PARAMETER PortableZipCompression
    Optional 7-Zip compression level from 0 through 9. Default: 5.

.PARAMETER AppVersion
    Optional packaged version. Defaults to the project package.json version.
#>
[CmdletBinding()]
param(
    [string]$Namespace = "rg",
    [string]$DropDir,
    [string]$PortableZipCompression,
    [string]$AppVersion
)

$ErrorActionPreference = "Stop"
$ProjectRoot = $PSScriptRoot
$FallbackToolchainRoot = Join-Path $ProjectRoot ".tools\node24"
if ([string]::IsNullOrWhiteSpace($DropDir)) {
    $DropDir = Split-Path -Parent $ProjectRoot
}

if ([string]::IsNullOrWhiteSpace($Namespace)) {
    throw "Namespace must not be empty."
}
if ([string]::IsNullOrWhiteSpace($AppVersion)) {
    $AppVersion = (Get-Content -LiteralPath (Join-Path $ProjectRoot "package.json") -Raw | ConvertFrom-Json).version
}
if ([string]::IsNullOrWhiteSpace($AppVersion)) {
    throw "package.json does not contain a packaged app version."
}

$NamespaceToken = $Namespace -replace '[^A-Za-z0-9._-]+', '-'
$ArtifactName = "Readable Studio-$NamespaceToken-portable.zip"
$ExpectedZip = Join-Path $ProjectRoot ".tmp\tools-pack\out\win\namespaces\$Namespace\builder\$ArtifactName"

if ([string]::IsNullOrWhiteSpace($PortableZipCompression)) {
    $PortableZipCompression = $env:READABLE_PORTABLE_ZIP_COMPRESSION
}
$previousPortableZipCompression = $env:READABLE_PORTABLE_ZIP_COMPRESSION
if (-not [string]::IsNullOrWhiteSpace($PortableZipCompression)) {
    if ($PortableZipCompression -notmatch '^\d+$' -or [int]$PortableZipCompression -lt 0 -or [int]$PortableZipCompression -gt 9) {
        throw "Portable ZIP compression must be an integer from 0 to 9, but got '$PortableZipCompression'."
    }
    $env:READABLE_PORTABLE_ZIP_COMPRESSION = $PortableZipCompression
}

$NodeCommand = $null
$PnpmCommand = $null
if (Test-Path -LiteralPath (Join-Path $FallbackToolchainRoot "node.exe")) {
    $NodeCommand = Join-Path $FallbackToolchainRoot "node.exe"
    $PnpmCommand = Join-Path $FallbackToolchainRoot "pnpm.cmd"
    $env:Path = "$FallbackToolchainRoot$([IO.Path]::PathSeparator)$env:Path"
} else {
    $NodeCommand = (Get-Command node.exe -ErrorAction Stop).Source
    $PnpmCommand = (Get-Command pnpm.cmd -ErrorAction Stop).Source
}
if (-not (Test-Path -LiteralPath $PnpmCommand)) {
    throw "pnpm.cmd was not found beside the selected Node 24 toolchain."
}
$nodeVersion = & $NodeCommand --version
if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v24\.') {
    throw "Readable Studio portable builds require Node v24.x; selected runtime reported '$nodeVersion'."
}

Write-Host "=== Readable Studio portable build ===" -ForegroundColor Cyan
Write-Host "Project root : $ProjectRoot"
Write-Host "Namespace    : $Namespace"
Write-Host "Architecture : Windows x64"
Write-Host "App version  : $AppVersion"
Write-Host "Artifact     : $ArtifactName"
Write-Host "Node         : $nodeVersion"

$buildArgs = @(
    "tools-pack", "win", "build",
    "--namespace", $Namespace,
    "--app-version", $AppVersion
)
if (-not [string]::IsNullOrWhiteSpace($PortableZipCompression)) {
    $buildArgs += @("--cache-dir", (Join-Path $ProjectRoot ".tmp\tools-pack\cache\portable-zip-mx-$PortableZipCompression"))
}

$sw = [Diagnostics.Stopwatch]::StartNew()
$previousErrorActionPreference = $ErrorActionPreference
Push-Location $ProjectRoot
try {
    # PowerShell 5.1 wraps native stderr as ErrorRecord when redirected. Preserve
    # phase output and use each native exit code as the authoritative result.
    $ErrorActionPreference = "Continue"
    & $PnpmCommand --filter "@readable-studio/tools-pack" build 2>&1 | ForEach-Object { "$_" }
    $exitCode = $LASTEXITCODE
    if ($exitCode -eq 0) {
        & $PnpmCommand @buildArgs 2>&1 | ForEach-Object { "$_" }
        $exitCode = $LASTEXITCODE
    }
} finally {
    $ErrorActionPreference = $previousErrorActionPreference
    if ($null -eq $previousPortableZipCompression) {
        Remove-Item Env:READABLE_PORTABLE_ZIP_COMPRESSION -ErrorAction SilentlyContinue
    } else {
        $env:READABLE_PORTABLE_ZIP_COMPRESSION = $previousPortableZipCompression
    }
    Pop-Location
    $sw.Stop()
}
if ($exitCode -ne 0) {
    throw "Portable build failed with exit code $exitCode after $(('{0:n1}' -f $sw.Elapsed.TotalMinutes)) minutes."
}
if (-not (Test-Path -LiteralPath $ExpectedZip -PathType Leaf)) {
    throw "Portable build completed without the expected artifact: $ExpectedZip"
}

$dropDirInfo = New-Item -ItemType Directory -Path $DropDir -Force
$DropPath = Join-Path $dropDirInfo.FullName $ArtifactName
if (-not [string]::Equals($ExpectedZip, $DropPath, [StringComparison]::OrdinalIgnoreCase)) {
    if (Test-Path -LiteralPath $DropPath) {
        Remove-Item -LiteralPath $DropPath -Force
    }
    Move-Item -LiteralPath $ExpectedZip -Destination $DropPath
}

$artifact = Get-Item -LiteralPath $DropPath
Write-Host "=== Build complete in $(('{0:n1}' -f $sw.Elapsed.TotalMinutes)) minutes ===" -ForegroundColor Green
Write-Host "Portable ZIP : $($artifact.FullName)" -ForegroundColor Green
Write-Host "Size         : $([math]::Round($artifact.Length / 1MB, 1)) MB" -ForegroundColor Green

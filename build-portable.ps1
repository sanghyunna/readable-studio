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

.PARAMETER FastBuild
    Post-v1.2.0 opt-in: overlap independent preparation and use up to 20 ZIP
    threads. Compression remains level 5 unless explicitly overridden.

.PARAMETER ProfileBuild
    Record phase timings and Windows CPU/disk/process utilization. Off by
    default. Comparison archives receive unique build-perf filenames.

.PARAMETER CacheDir
    Optional tools-pack cache root. Use a new private directory for a cache-miss
    measurement without clearing or changing the release cache.
#>
[CmdletBinding()]
param(
    [string]$Namespace = "rg",
    [string]$DropDir,
    [string]$PortableZipCompression,
    [string]$AppVersion,
    [switch]$FastBuild,
    [switch]$ProfileBuild,
    [string]$CacheDir
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
if (-not [string]::IsNullOrWhiteSpace($CacheDir)) {
    $buildArgs += @("--cache-dir", $CacheDir)
} elseif (-not [string]::IsNullOrWhiteSpace($PortableZipCompression)) {
    $buildArgs += @("--cache-dir", (Join-Path $ProjectRoot ".tmp\tools-pack\cache\portable-zip-mx-$PortableZipCompression"))
}
if ($FastBuild) {
    $buildArgs += "--fast-build"
}

$sw = [Diagnostics.Stopwatch]::StartNew()
$previousErrorActionPreference = $ErrorActionPreference
$previousBuildProfile = $env:READABLE_TOOLS_PACK_PROFILE
$profileProcess = $null
$profileStopPath = $null
$profileFailure = $null
$profileRunId = $null
Push-Location $ProjectRoot
try {
    if ($ProfileBuild) {
        $env:READABLE_TOOLS_PACK_PROFILE = "1"
        $profileSetupStart = $sw.ElapsedMilliseconds
        Write-Host "[tools-pack win] phase:start phase=profile-recorder:startup timestampMs=$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()) pid=$PID"
        $profileRunId = "{0}-{1}-{2}" -f [DateTime]::UtcNow.ToString("yyyyMMddTHHmmssfffZ"), $PID, [Guid]::NewGuid().ToString("N").Substring(0, 8)
        $profileRoot = Join-Path $ProjectRoot ".omo\evidence\build-perf"
        [IO.Directory]::CreateDirectory($profileRoot) | Out-Null
        $profilePath = Join-Path $profileRoot "utilization-$profileRunId.log"
        $profileStopPath = Join-Path $profileRoot "utilization-$profileRunId.stop.json"
        $profileScript = Join-Path $ProjectRoot "tools\pack\record-build-utilization.ps1"
        $profileInfo = New-Object Diagnostics.ProcessStartInfo
        $profileInfo.FileName = (Get-Command powershell.exe -ErrorAction Stop).Source
        $profileInfo.Arguments = '-NoProfile -ExecutionPolicy Bypass -File "{0}" -RootProcessId {1} -OutputPath "{2}" -StopPath "{3}"' -f $profileScript, $PID, $profilePath, $profileStopPath
        $profileInfo.UseShellExecute = $false
        $profileInfo.CreateNoWindow = $true
        $profileInfo.RedirectStandardOutput = $true
        $profileProcess = [Diagnostics.Process]::Start($profileInfo)
        $ready = $profileProcess.StandardOutput.ReadLineAsync()
        if (-not $ready.Wait(30000) -or $ready.Result -ne "BUILD_PROFILE_READY") {
            throw "Utilization recorder did not become ready; no build was started."
        }
        Write-Host "Utilization  : $profilePath"
        Write-Host "[tools-pack win] phase:done durationMs=$($sw.ElapsedMilliseconds - $profileSetupStart) phase=profile-recorder:startup timestampMs=$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()) pid=$PID"
    }
    # PowerShell 5.1 wraps native stderr as ErrorRecord when redirected. Preserve
    # phase output and use each native exit code as the authoritative result.
    $ErrorActionPreference = "Continue"
    if ($ProfileBuild) {
        $toolBuildStart = $sw.ElapsedMilliseconds
        Write-Host "[tools-pack win] phase:start phase=tools-pack-bootstrap timestampMs=$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()) pid=$PID"
    }
    & $PnpmCommand --filter "@readable-studio/tools-pack" build 2>&1 | ForEach-Object { "$_" }
    $exitCode = $LASTEXITCODE
    if ($ProfileBuild) {
        $toolBuildStatus = if ($exitCode -eq 0) { "done" } else { "failed" }
        Write-Host "[tools-pack win] phase:$toolBuildStatus durationMs=$($sw.ElapsedMilliseconds - $toolBuildStart) phase=tools-pack-bootstrap timestampMs=$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()) pid=$PID"
    }
    if ($exitCode -eq 0) {
        & $PnpmCommand @buildArgs 2>&1 | ForEach-Object { "$_" }
        $exitCode = $LASTEXITCODE
    }
} finally {
    $ErrorActionPreference = $previousErrorActionPreference
    try {
        if ($null -ne $profileProcess) {
            $profileStopStart = $sw.ElapsedMilliseconds
            Write-Host "[tools-pack win] phase:start phase=profile-recorder:shutdown timestampMs=$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()) pid=$PID"
            try {
                [IO.File]::WriteAllText($profileStopPath, "{}")
                if (-not $profileProcess.WaitForExit(15000)) {
                    $profileProcess.Kill() # Only the recorder PID started above.
                    $profileProcess.WaitForExit()
                    $profileFailure = "Utilization recorder did not stop within 15 seconds."
                } elseif ($profileProcess.ExitCode -ne 0) {
                    $profileFailure = "Utilization recorder exited with code $($profileProcess.ExitCode)."
                }
            } finally {
                $profileProcess.Dispose()
                [IO.File]::Delete($profileStopPath)
                $profileStopStatus = if ($null -eq $profileFailure) { "done" } else { "failed" }
                Write-Host "[tools-pack win] phase:$profileStopStatus durationMs=$($sw.ElapsedMilliseconds - $profileStopStart) phase=profile-recorder:shutdown timestampMs=$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()) pid=$PID"
            }
        }
    } finally {
        if ($null -eq $previousBuildProfile) {
            Remove-Item Env:READABLE_TOOLS_PACK_PROFILE -ErrorAction SilentlyContinue
        } else {
            $env:READABLE_TOOLS_PACK_PROFILE = $previousBuildProfile
        }
        if ($null -eq $previousPortableZipCompression) {
            Remove-Item Env:READABLE_PORTABLE_ZIP_COMPRESSION -ErrorAction SilentlyContinue
        } else {
            $env:READABLE_PORTABLE_ZIP_COMPRESSION = $previousPortableZipCompression
        }
        Pop-Location
        $sw.Stop()
    }
}
if ($exitCode -ne 0) {
    throw "Portable build failed with exit code $exitCode after $(('{0:n1}' -f $sw.Elapsed.TotalMinutes)) minutes."
}
if ($null -ne $profileFailure) { throw $profileFailure }
if (-not (Test-Path -LiteralPath $ExpectedZip -PathType Leaf)) {
    throw "Portable build completed without the expected artifact: $ExpectedZip"
}

if (Test-Path -LiteralPath $DropDir -PathType Container) {
    $dropDirRoot = (Resolve-Path -LiteralPath $DropDir).ProviderPath
} else {
    $dropDirRoot = (New-Item -ItemType Directory -Path $DropDir -Force).FullName
}
$DropArtifactName = if ($ProfileBuild) { "Readable-Studio-build-perf-$profileRunId-$NamespaceToken-portable.zip" } else { $ArtifactName }
$DropPath = Join-Path $dropDirRoot $DropArtifactName
if (-not [string]::Equals($ExpectedZip, $DropPath, [StringComparison]::OrdinalIgnoreCase)) {
    if (Test-Path -LiteralPath $DropPath) {
        if ($ProfileBuild) { throw "Refusing to replace an existing comparison archive: $DropPath" }
        Remove-Item -LiteralPath $DropPath -Force
    }
    Move-Item -LiteralPath $ExpectedZip -Destination $DropPath
}

$artifact = Get-Item -LiteralPath $DropPath
Write-Host "=== Build complete in $(('{0:n1}' -f $sw.Elapsed.TotalMinutes)) minutes ===" -ForegroundColor Green
Write-Host "Portable ZIP : $($artifact.FullName)" -ForegroundColor Green
Write-Host "Size         : $([math]::Round($artifact.Length / 1MB, 1)) MB" -ForegroundColor Green

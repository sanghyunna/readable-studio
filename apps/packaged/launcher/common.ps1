# Shared immutable launcher contract; keep this file beside both scripts.
$ErrorActionPreference = 'Stop'
function Import-Launcher([string]$Root) {
    [void][Reflection.Assembly]::LoadFrom((Join-Path $Root 'Readable Studio.exe'))
}
function Assert-UpdatePaths([string]$Root, [string]$Staging) {
    if ([IO.Path]::GetFullPath($Staging).TrimEnd('\') -ne [IO.Path]::GetFullPath((Join-Path $Root 'app.staging'))) {
        throw 'Staging must be the installation app.staging folder.'
    }
    if (-not [IO.File]::Exists((Join-Path $Staging 'Readable Studio.exe'))) { throw 'Staged executable is missing.' }
}
function Get-UpdateArguments([string]$Script, [string]$Root, [string]$Staging, [string]$TargetVersion, [int]$WaitPid) {
    $values = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', $Script,
        '-Root', $Root, '-Staging', $Staging, '-TargetVersion', $TargetVersion, '-WaitPid', [string]$WaitPid)
    return (($values | ForEach-Object { [ReadableStudio.Launcher.Program]::Quote($_) }) -join ' ')
}

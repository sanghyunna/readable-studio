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
function Stop-PayloadProcesses([string]$Root) {
    $failure = '앱 종료를 확인하지 못했습니다. 모든 창을 닫고 다시 시도해 주세요.'
    $payload = [IO.Path]::GetFullPath((Join-Path $Root 'app')).TrimEnd('\')
    if (([IO.File]::GetAttributes($payload) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw $failure }
    $prefix = $payload + '\'
    $log = Join-Path $Root 'update-broker.log'
    $owned = @()
    try {
        foreach ($candidate in (Get-CimInstance Win32_Process)) {
            if (-not $candidate.ExecutablePath -or -not $candidate.ExecutablePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { continue }
            try { $process = [Diagnostics.Process]::GetProcessById($candidate.ProcessId) }
            catch [ArgumentException] { continue }
            # Recheck the image on the process handle, not a possibly reused PID.
            if ($process.HasExited) { $process.Dispose(); continue }
            $image = $process.MainModule.FileName
            if (-not $image.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { $process.Dispose(); continue }
            $owned += $process
            [IO.File]::AppendAllText($log, "payload process detected pid=$($process.Id) image=$image`n")
        }
        $deadline = [Diagnostics.Stopwatch]::StartNew()
        foreach ($process in $owned) {
            $remaining = [Math]::Max(0, 420000 - [int]$deadline.ElapsedMilliseconds)
            if ($process.WaitForExit($remaining)) {
                [IO.File]::AppendAllText($log, "payload process exited pid=$($process.Id)`n")
                continue
            }
            # Never kill a tree: a descendant may execute outside this payload.
            $image = $process.MainModule.FileName
            if (-not $image.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw $failure }
            [IO.File]::AppendAllText($log, "payload process terminating pid=$($process.Id) image=$image`n")
            $process.Kill()
        }
        $deadline.Restart()
        foreach ($process in $owned) {
            if (-not $process.WaitForExit([Math]::Max(0, 30000 - [int]$deadline.ElapsedMilliseconds))) { throw $failure }
        }
        foreach ($candidate in (Get-CimInstance Win32_Process)) {
            if ($candidate.ExecutablePath -and $candidate.ExecutablePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw $failure }
        }
    } catch {
        [IO.File]::AppendAllText($log, "payload process cleanup failed: $($_.Exception.Message)`n")
        throw $failure
    } finally { foreach ($process in $owned) { $process.Dispose() } }
}
function Get-UpdateArguments([string]$Script, [string]$Root, [string]$Staging, [string]$TargetVersion, [int]$WaitPid, [string]$Namespace = 'rg') {
    $values = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', $Script,
        '-Root', $Root, '-Staging', $Staging, '-TargetVersion', $TargetVersion, '-WaitPid', [string]$WaitPid, '-Namespace', $Namespace)
    return (($values | ForEach-Object { [ReadableStudio.Launcher.Program]::Quote($_) }) -join ' ')
}
function Complete-UpdateOperation($Worker, $Operation, $Form, [string]$Root) {
    try {
        $result = @($Worker.EndInvoke($Operation))
        if ($result -contains 'rolled-back') {
            $Form.SetMessage("업데이트를 적용하지 못해 이전 버전으로 되돌렸습니다.`n작업 내역은 그대로입니다.", $false)
            return 1
        }
        if ($result -contains 'app-open') {
            $Form.SetMessage("업데이트를 준비하지 못했습니다.`n앱을 열어 둔 채 다시 시도해 주세요. 작업 내역은 그대로입니다.", $false)
            return 1
        }
        if ($Worker.HadErrors) { throw $Worker.Streams.Error[0].Exception }
        $Form.Close()
        return 0
    } catch {
        [IO.File]::WriteAllText((Join-Path $Root 'update-error.log'), $_.Exception.ToString())
        # Reuse the form already owned by Application.Run. Starting another
        # message loop from its timer callback would discard this notice.
        $Form.SetMessage("업데이트를 완료하지 못했습니다.`nReadable Studio를 다시 실행해 주세요. 작업 내역은 그대로입니다.", $false)
        return 1
    }
}

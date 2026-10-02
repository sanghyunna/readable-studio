param(
    [Parameter(Mandatory=$true)][string]$Root,
    [Parameter(Mandatory=$true)][string]$Staging,
    [Parameter(Mandatory=$true)][string]$TargetVersion,
    [Parameter(Mandatory=$true)][int]$WaitPid
)
$ErrorActionPreference = 'Stop'
[IO.File]::AppendAllText((Join-Path $Root 'update-broker.log'), "helper started pid=$PID handoff=$env:READABLE_UPDATE_HANDOFF_ID`n")
. (Join-Path $PSScriptRoot 'common.ps1')
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
Import-Launcher $Root
[Windows.Forms.Application]::EnableVisualStyles()
$form = [ReadableStudio.Launcher.Notice]::new("업데이트 진행 중`n앱을 종료하고 새 버전을 준비하고 있습니다.", $true)
$worker = [PowerShell]::Create()
[void]$worker.AddScript({
    param($Root, $Staging, $TargetVersion, $WaitPid, $Common)
    $ErrorActionPreference = 'Stop'
    . $Common
    function Stop-At([string]$Point) {
        # Test-only rendezvous: no delay or extra public command-line parameter.
        if ($env:READABLE_UPDATE_TEST_POINT -ne $Point) { return }
        $hit = [Threading.EventWaitHandle]::OpenExisting('Local\ReadableUpdateCheckpoint-' + $tx.State.id)
        $release = [Threading.EventWaitHandle]::OpenExisting('Local\ReadableUpdateRelease-' + $tx.State.id)
        try { [void]$hit.Set(); if (-not $release.WaitOne(180000)) { throw 'Checkpoint controller timed out.' } }
        finally { $hit.Dispose(); $release.Dispose() }
    }
    $tx = [ReadableStudio.Launcher.Transaction]::new($Root)
    try {
        Assert-UpdatePaths $Root $Staging
        if (-not $tx.TryLock()) { throw 'Another update owns this installation.' }
        [void]$tx.Read()
        if ($null -ne $tx.State -and [ReadableStudio.Launcher.Transaction]::Decision($tx.State, $true, $tx.Exists('app.old'), $true) -ne 'launch') {
            throw 'An unfinished update must be recovered by the launcher first.'
        }
        if ($tx.Exists('app.old') -or $tx.Exists('app.failed')) { throw 'A previous payload still needs recovery or removal.' }
        $tx.State = [ReadableStudio.Launcher.Journal]::new()
        $tx.State.id = [Guid]::NewGuid().ToString()
        if ($env:READABLE_UPDATE_TEST_ID) { $tx.State.id = $env:READABLE_UPDATE_TEST_ID }
        $tx.State.target = $TargetVersion
        $tx.Claim()
        if ($env:READABLE_UPDATE_HANDOFF_ID) {
            $ready = Join-Path $Root 'update-helper-ready.json'
            $temporary = $ready + '.tmp'
            [IO.File]::WriteAllText($temporary, (@{id=$env:READABLE_UPDATE_HANDOFF_ID;pid=$PID} | ConvertTo-Json -Compress))
            if ([IO.File]::Exists($ready)) { [IO.File]::Replace($temporary, $ready, $null) }
            else { [IO.File]::Move($temporary, $ready) }
        }
        Stop-At 'prepared'
        if ($WaitPid -gt 0) {
            try { $parent = [Diagnostics.Process]::GetProcessById($WaitPid) }
            catch [ArgumentException] { $parent = $null }
            if ($null -ne $parent) {
                try { if (-not $parent.WaitForExit(45000)) { throw '앱 종료를 기다리고 있습니다. 모든 Readable Studio 창을 닫고 다시 시도해 주세요.' } }
                finally { $parent.Dispose() }
            }
        }
        $tx.RequireEmpty(50000)
        $tx.Move('old-move', 'app', 'app.old')
        Stop-At 'old-move'
        $tx.Move('new-move', 'app.staging', 'app')
        Stop-At 'new-move'
        $tx.State.step = 'complete'; $tx.State.done = $true; $tx.Save()
        if (-not $tx.LaunchAndWaitReady(180000)) { throw '새 버전 시작을 확인하지 못했습니다. 앱을 닫고 다시 실행해 주세요.' }
        if (-not $tx.TryLock()) { throw 'Could not reclaim update mutex.' }
        [void]$tx.Read()
        if (-not $tx.Ready()) { throw '새 버전 실행 정보가 일치하지 않습니다.' }
        $tx.BeginCleanup()
        if ($env:READABLE_UPDATE_TEST_POINT -eq 'cleanup') {
            [IO.File]::Delete((Join-Path $Root 'app.old\LICENSE.electron.txt'))
            Stop-At 'cleanup'
        }
        $tx.Cleanup()
    } catch {
        $failure = $_.Exception
        [IO.File]::WriteAllText((Join-Path $Root 'update-error.log'), $failure.ToString())
        if ($null -ne $tx.State -and $tx.State.confirmed) {
            # The new app has proved itself. Keep cleanup pending, not failed.
            if (-not $tx.TryLock()) { throw $failure }
            $tx.State.step = 'cleanup'; $tx.State.pid = 0; $tx.State.error = $failure.Message; $tx.Save()
            return
        }
        throw $failure
    } finally { $tx.Dispose() }
}).AddArgument($Root).AddArgument($Staging).AddArgument($TargetVersion).AddArgument($WaitPid).AddArgument((Join-Path $PSScriptRoot 'common.ps1'))
$operation = $worker.BeginInvoke()
$script:exitCode = 0
$timer = [Windows.Forms.Timer]::new(); $timer.Interval = 100
$timer.add_Tick({
    if (-not $operation.IsCompleted) { return }
    $timer.Stop()
    try {
        [void]$worker.EndInvoke($operation)
        if ($worker.HadErrors) { throw $worker.Streams.Error[0].Exception }
    } catch {
        [IO.File]::WriteAllText((Join-Path $Root 'update-error.log'), $_.Exception.ToString())
        $script:exitCode = 1
        $form.Hide()
        [ReadableStudio.Launcher.Program]::Show("업데이트가 중단되었습니다. 앱을 닫고 Readable Studio를 다시 실행하면 복구합니다.`n" + $_.Exception.Message, $false)
    } finally { $form.Close() }
})
$form.add_FormClosing({ if (-not $operation.IsCompleted) { $_.Cancel = $true } })
$timer.Start()
try { [Windows.Forms.Application]::Run($form) }
finally { $timer.Dispose(); $worker.Dispose(); $form.Dispose() }
exit $script:exitCode

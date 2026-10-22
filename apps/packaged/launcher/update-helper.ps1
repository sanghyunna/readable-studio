param(
    [Parameter(Mandatory=$true)][string]$Root,
    [Parameter(Mandatory=$true)][string]$Staging,
    [Parameter(Mandatory=$true)][string]$TargetVersion,
    [Parameter(Mandatory=$true)][int]$WaitPid,
    [string]$Namespace = 'rg'
)
$ErrorActionPreference = 'Stop'
[IO.File]::AppendAllText((Join-Path $Root 'update-broker.log'), "helper started pid=$PID handoff=$env:READABLE_UPDATE_HANDOFF_ID namespace=$Namespace`n")
. (Join-Path $PSScriptRoot 'common.ps1')
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
Import-Launcher $Root
[Windows.Forms.Application]::EnableVisualStyles()
$form = [ReadableStudio.Launcher.Notice]::new("업데이트 진행 중`n앱을 종료하고 새 버전을 준비하고 있습니다.", $true)
$appReady = [Threading.ManualResetEventSlim]::new($false)
$worker = [PowerShell]::Create()
[void]$worker.AddScript({
    param($Root, $Staging, $TargetVersion, $WaitPid, $Common, $Namespace, $AppReady)
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
    if ($null -ne $AppReady) { $tx.add_ReadyObserved({ $AppReady.Set() }) }
    $claimed = $false
    try {
        Assert-UpdatePaths $Root $Staging
        if (-not $tx.TryLock()) { throw 'Another update owns this installation.' }
        [void]$tx.Read()
        $tx.PrepareNextUpdate($WaitPid)
        $tx.State = [ReadableStudio.Launcher.Journal]::new()
        $tx.State.id = [Guid]::NewGuid().ToString()
        if ($env:READABLE_UPDATE_TEST_ID) { $tx.State.id = $env:READABLE_UPDATE_TEST_ID }
        $tx.State.target = $TargetVersion
        $tx.State.launchNamespace = $Namespace
        $tx.Claim()
        $claimed = $true
        if ($env:READABLE_UPDATE_HANDOFF_ID) {
            $ready = Join-Path $Root 'update-helper-ready.json'
            $temporary = $ready + '.tmp'
            [IO.File]::WriteAllText($temporary, (@{id=$env:READABLE_UPDATE_HANDOFF_ID;pid=$PID;namespace=$Namespace} | ConvertTo-Json -Compress))
            if ([IO.File]::Exists($ready)) {
                # PowerShell coerces a null string to "", not a null backup path.
                [IO.File]::Replace($temporary, $ready, $ready + '.previous')
                [IO.File]::Delete($ready + '.previous')
            }
            else { [IO.File]::Move($temporary, $ready) }
        }
        Stop-At 'prepared'
        if ($WaitPid -gt 0) {
            try { $parent = [Diagnostics.Process]::GetProcessById($WaitPid) }
            catch [ArgumentException] { $parent = $null }
            if ($null -ne $parent) {
                try { if (-not $parent.WaitForExit(540000)) { throw '앱 종료를 기다리고 있습니다. 모든 Readable Studio 창을 닫고 다시 시도해 주세요.' } }
                finally { $parent.Dispose() }
            }
        }
        Stop-PayloadProcesses $Root
        $tx.RequireEmpty(180000)
        $tx.Move('old-move', 'app', 'app.old')
        Stop-At 'old-move'
        $tx.Move('new-move', 'app.staging', 'app')
        Stop-At 'new-move'
        $tx.State.step = 'complete'; $tx.State.done = $true; $tx.Save()
        [IO.File]::AppendAllText((Join-Path $Root 'update-broker.log'), "helper relaunch namespace=$Namespace`n")
        if (-not $tx.LaunchAndWaitReady(2400000)) { throw "Version $TargetVersion failed to confirm startup." }
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
        if ($claimed -and $tx.Exists('app.old')) {
            if (-not $tx.TryLock()) { throw $failure }
            if ($tx.Exists('app')) { Stop-PayloadProcesses $Root }
            if ($tx.RecoverAndLaunch(2400000)) {
                [IO.File]::AppendAllText((Join-Path $Root 'update-error.log'), "`nUpdate to $TargetVersion failed; rolled back to $($tx.State.target).`n")
                return 'rolled-back'
            }
        }
        if ($claimed -and $tx.State.step -eq 'prepared' -and $tx.TryLock()) {
            # No payload move happened. Leave a terminal journal so another
            # apply does not inherit an abandoned "prepared" attempt.
            $tx.State.step = 'rolled-back'; $tx.State.done = $true; $tx.State.pid = 0
            $tx.State.error = $failure.Message; $tx.Save(); $tx.ClearAttemptFiles()
        }
        if ($WaitPid -gt 0) {
            try {
                $requester = [Diagnostics.Process]::GetProcessById($WaitPid)
                try {
                    if (-not $requester.HasExited -and [string]::Equals($requester.MainModule.FileName, (Join-Path $Root 'app\Readable Studio.exe'), [StringComparison]::OrdinalIgnoreCase)) {
                        return 'app-open'
                    }
                } finally { $requester.Dispose() }
            } catch [ArgumentException] { }
        }
        throw $failure
    } finally { $tx.Dispose() }
}).AddArgument($Root).AddArgument($Staging).AddArgument($TargetVersion).AddArgument($WaitPid).AddArgument((Join-Path $PSScriptRoot 'common.ps1')).AddArgument($Namespace).AddArgument($appReady)
$operation = $worker.BeginInvoke()
$script:exitCode = 0
$timer = [Windows.Forms.Timer]::new(); $timer.Interval = 100
$timer.add_Tick({
    if ($null -ne $appReady -and $appReady.IsSet) { $form.Hide() }
    if (-not $operation.IsCompleted) { return }
    $timer.Stop()
    $script:exitCode = Complete-UpdateOperation $worker $operation $form $Root
})
$form.add_FormClosing({ if (-not $operation.IsCompleted) { $_.Cancel = $true } })
$timer.Start()
try { [Windows.Forms.Application]::Run($form) }
finally { $timer.Dispose(); $worker.Dispose(); $form.Dispose(); $appReady.Dispose() }
exit $script:exitCode

param([string]$Source, [string]$Root)
$ErrorActionPreference = 'Stop'
. (Join-Path $Source 'common.ps1')
$passed = 0; $failed = 0
try {
    $scripts = @(& fd -t f -e ps1 . $Source)
    if ($LASTEXITCODE -ne 0 -or -not $scripts.Count) { throw 'Script discovery failed' }
    foreach ($path in $scripts) {
        $bytes = [IO.File]::ReadAllBytes($path)
        $nonAscii = @($bytes | Where-Object { $_ -gt 127 }).Count -gt 0
        if ($nonAscii -and ($bytes.Length -lt 3 -or $bytes[0] -ne 239 -or $bytes[1] -ne 187 -or $bytes[2] -ne 191)) { throw "Non-ASCII script lacks UTF-8 BOM: $path" }
    }
    $passed++
} catch { $failed++; Write-Output "FAIL launcher non-ASCII scripts have UTF-8 BOM $_" }
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $Source 'update-helper.ps1'), [ref]$tokens, [ref]$errors)
try {
    # Execute the production successful-recovery branch with a controlled transaction.
    $recovery = $ast.Find({param($node) $node -is [Management.Automation.Language.IfStatementAst] -and $node.Clauses[0].Item1.Extent.Text -eq '$tx.RecoverAndLaunch(2400000)'}, $true)
    $tx = [pscustomobject]@{ State = [pscustomobject]@{ target = '1.3.3' } }
    $TargetVersion = '1.3.4'
    [IO.File]::WriteAllText((Join-Path $Root 'update-error.log'), 'original failure')
    $result = & ([ScriptBlock]::Create(($recovery.Clauses[0].Item2.Statements.Extent.Text -join "`n")))
    $log = [IO.File]::ReadAllText((Join-Path $Root 'update-error.log'))
    if ($result -ne 'rolled-back' -or -not $log.Contains($TargetVersion) -or -not $log.Contains($tx.State.target)) { throw 'Recovery log must identify failed and restored versions' }
    $passed++
} catch { $failed++; Write-Output "FAIL automatic rollback logs failed and restored versions $_" }
$tick = $ast.Find({param($node) $node -is [Management.Automation.Language.InvokeMemberExpressionAst] -and $node.Member.Value -eq 'add_Tick'}, $true)
$handler = $tick.Arguments[0].ScriptBlock.GetScriptBlock()
try {
    $appReady = [Threading.ManualResetEventSlim]::new($false)
    $form = [pscustomobject]@{ Hidden = $false }
    $form | Add-Member ScriptMethod Hide { $this.Hidden = $true }
    $operation = [pscustomobject]@{ IsCompleted = $false }
    $appReady.Set()
    . $handler
    if (-not $form.Hidden) { throw 'Ready app remains covered while cleanup is pending' }
    $passed++
} catch { $failed++; Write-Output "FAIL progress hides at readiness before cleanup finishes $_" }
finally { if ($appReady) { $appReady.Dispose() }; $appReady = $null }
try {
    # Execute the real handoff publication block, twice, including legacy debris.
    $publish = $ast.Find({param($node) $node -is [Management.Automation.Language.IfStatementAst] -and $node.Clauses[0].Item1.Extent.Text -eq '$env:READABLE_UPDATE_HANDOFF_ID'}, $true)
    $block = [ScriptBlock]::Create(($publish.Clauses[0].Item2.Statements.Extent.Text -join "`n"))
    $Namespace = 'rg'
    $env:READABLE_UPDATE_HANDOFF_ID = [Guid]::NewGuid().ToString()
    . $block
    $env:READABLE_UPDATE_HANDOFF_ID = [Guid]::NewGuid().ToString()
    . $block
    $receipt = [IO.File]::ReadAllText((Join-Path $Root 'update-helper-ready.json')) | ConvertFrom-Json
    if ($receipt.id -ne $env:READABLE_UPDATE_HANDOFF_ID) { throw 'Second handoff did not replace first acknowledgement' }
    $passed++
} catch { $failed++; Write-Output "FAIL consecutive helper handoffs $_" }
finally { Remove-Item Env:READABLE_UPDATE_HANDOFF_ID -ErrorAction SilentlyContinue }
try {
    Add-Type -AssemblyName System.Windows.Forms,System.Drawing
    Import-Launcher $Root
    $notice = [ReadableStudio.Launcher.Notice]::new('progress', $true)
    if (-not $notice.ControlBox -or $notice.FormBorderStyle -eq [Windows.Forms.FormBorderStyle]::FixedDialog) { throw 'Native title bar suppresses the app icon' }
    $expected = [Drawing.Icon]::ExtractAssociatedIcon((Join-Path $Root 'Readable Studio.exe'))
    $actualStream = [IO.MemoryStream]::new(); $expectedStream = [IO.MemoryStream]::new()
    $notice.Icon.Save($actualStream); $expected.Save($expectedStream)
    if ([Convert]::ToBase64String($actualStream.ToArray()) -ne [Convert]::ToBase64String($expectedStream.ToArray())) { throw 'Helper notice uses host icon rather than launcher icon' }
    $passed++
} catch { $failed++; Write-Output "FAIL helper app icon $_" }
finally {
    if ($notice) { $notice.Dispose() }
    if ($expected) { $expected.Dispose() }
    if ($actualStream) { $actualStream.Dispose(); $expectedStream.Dispose() }
}
try {
    $fixture = Join-Path $Root 'pre-swap-failure'
    [void][IO.Directory]::CreateDirectory((Join-Path $fixture 'app'))
    [void][IO.Directory]::CreateDirectory((Join-Path $fixture 'app.staging'))
    [IO.File]::Copy((Join-Path $Root 'HarnessHost.exe'), (Join-Path $fixture 'app\Readable Studio.exe'), $true)
    [IO.File]::WriteAllText((Join-Path $fixture 'app.staging\Readable Studio.exe'), 'staged')
    $readyName = 'Local\F17-requester-' + [Guid]::NewGuid().ToString()
    $readyEvent = [Threading.EventWaitHandle]::new($false, [Threading.EventResetMode]::ManualReset, $readyName)
    $start = [Diagnostics.ProcessStartInfo]::new((Join-Path $fixture 'app\Readable Studio.exe'), ('--fixture ' + $readyName))
    $start.UseShellExecute = $false; $start.CreateNoWindow = $true
    $requester = [Diagnostics.Process]::Start($start)
    if (-not $readyEvent.WaitOne(5000)) { throw 'Requester fixture did not open' }
    $scriptNode = $ast.Find({param($node) $node -is [Management.Automation.Language.InvokeMemberExpressionAst] -and $node.Member.Value -eq 'AddScript'}, $true)
    $runWorker = $scriptNode.Arguments[0].ScriptBlock.GetScriptBlock()
    for ($attempt = 0; $attempt -lt 2; $attempt++) {
        $env:READABLE_UPDATE_TEST_ID = [Guid]::NewGuid().ToString()
        $env:READABLE_UPDATE_HANDOFF_ID = [Guid]::NewGuid().ToString()
        # A missing rendezvous injects an exact failure before app shutdown.
        $env:READABLE_UPDATE_TEST_POINT = 'prepared'
        $result = @(& $runWorker $fixture (Join-Path $fixture 'app.staging') '1.3.4' $requester.Id (Join-Path $Source 'common.ps1') 'rg')
        if ($result -notcontains 'app-open' -or $requester.HasExited) { throw 'Failure does not describe the live requester' }
        $journal = [IO.File]::ReadAllText((Join-Path $fixture 'update-journal.json')) | ConvertFrom-Json
        if ($journal.step -ne 'rolled-back' -or $journal.pid -ne 0) { throw 'Preparation failure left an active journal' }
        foreach ($name in @('update-helper-ready.json', 'update-helper-ready.json.tmp', 'update-journal.json.previous')) {
            if ([IO.File]::Exists((Join-Path $fixture $name))) { throw "Attempt marker remains: $name" }
        }
    }
    $passed++
} catch { $failed++; Write-Output "FAIL repeated pre-swap failure preserves requester $_" }
finally {
    foreach ($name in @('READABLE_UPDATE_TEST_ID', 'READABLE_UPDATE_HANDOFF_ID', 'READABLE_UPDATE_TEST_POINT')) { Remove-Item "Env:$name" -ErrorAction SilentlyContinue }
    if ($requester) { if (-not $requester.HasExited) { $requester.Kill(); $requester.WaitForExit() }; $requester.Dispose() }
    if ($readyEvent) { $readyEvent.Dispose() }
}
foreach ($mode in @('failure', 'success', 'rollback', 'app-open')) {
    try {
        $worker = [pscustomobject]@{ Mode = $mode; HadErrors = $false }
        $worker | Add-Member ScriptMethod EndInvoke {
            param($operation)
            if ($this.Mode -eq 'failure') { throw 'technical failure for log only' }
            if ($this.Mode -eq 'rollback') { return 'rolled-back' }
            if ($this.Mode -eq 'app-open') { return 'app-open' }
        }
        $form = [pscustomobject]@{ Closed = $false; Informed = $false; Progress = $true }
        $form | Add-Member ScriptMethod Close { $this.Closed = $true }
        $form | Add-Member ScriptMethod SetMessage { param($message, $progress) $this.Informed = $true; $this.Progress = $progress }
        $operation = [pscustomobject]@{ IsCompleted = $true }
        $timer = [pscustomobject]@{ Stopped = $false }
        $timer | Add-Member ScriptMethod Stop { $this.Stopped = $true }
        $script:exitCode = -1
        . $handler
        $result = $script:exitCode
        if (-not $timer.Stopped) { throw 'Completion timer must stop before updating the existing form' }
        if ($mode -ne 'success') {
            if ($result -ne 1 -or $form.Closed -or -not $form.Informed -or $form.Progress) { throw 'Failure must keep the existing form open as a dismissible notice' }
            if ($mode -eq 'failure' -and -not [IO.File]::ReadAllText((Join-Path $Root 'update-error.log')).Contains('technical failure for log only')) { throw 'Missing diagnostic log' }
        } elseif ($result -ne 0 -or -not $form.Closed) { throw 'Success must close progress' }
        $passed++
    } catch { $failed++; Write-Output "FAIL helper mode=$mode $_" }
}
try {
    Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class NoticeCapture {
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr window, IntPtr dc, uint flags);
    [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr window, uint message, IntPtr wparam, IntPtr lparam);
}
'@
    $directory = if ($env:READABLE_LAUNCHER_NOTICE_DIRECTORY) { $env:READABLE_LAUNCHER_NOTICE_DIRECTORY } else { Join-Path $Root 'notices' }
    [void][IO.Directory]::CreateDirectory($directory)
    $constructor = $ast.Find({param($node) $node -is [Management.Automation.Language.InvokeMemberExpressionAst] -and $node.Expression.Extent.Text -eq '[ReadableStudio.Launcher.Notice]'}, $true)
    $createNotice = [ScriptBlock]::Create($constructor.Extent.Text)
    foreach ($mode in @('progress', 'rollback', 'failure', 'app-open')) {
        $notice = & $createNotice
        try {
            $notice.Show()
            if ($mode -ne 'progress') {
                $worker = [pscustomobject]@{ Mode = $mode; HadErrors = $false }
                $worker | Add-Member ScriptMethod EndInvoke {
                    param($operation)
                    if ($this.Mode -eq 'failure') { throw 'diagnostic render fixture' }
                    if ($this.Mode -eq 'rollback') { return 'rolled-back' }
                    return 'app-open'
                }
                [void](Complete-UpdateOperation $worker $null $notice $Root)
            }
            $notice.Refresh()
            [Windows.Forms.Application]::DoEvents()
            if ([NoticeCapture]::SendMessage($notice.Handle, 0x7f, [IntPtr]::Zero, [IntPtr]::Zero) -eq [IntPtr]::Zero) { throw "No native title-bar icon: $mode" }
            $bitmap = [Drawing.Bitmap]::new($notice.Width, $notice.Height)
            $graphics = [Drawing.Graphics]::FromImage($bitmap)
            $dc = $graphics.GetHdc()
            try { if (-not [NoticeCapture]::PrintWindow($notice.Handle, $dc, 0)) { throw "PrintWindow failed: $mode" } }
            finally { $graphics.ReleaseHdc($dc); $graphics.Dispose() }
            try { $bitmap.Save((Join-Path $directory "$mode.png")) } finally { $bitmap.Dispose() }
        } finally { $notice.Dispose() }
    }
    $passed++
} catch { $failed++; Write-Output "FAIL all helper notices render with native app icons $_" }
@{total=$passed+$failed;passed=$passed;failed=$failed}|ConvertTo-Json -Compress
if ($failed) { exit 1 }

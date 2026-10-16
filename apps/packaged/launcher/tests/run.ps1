param([Parameter(Mandatory=$true)][string]$OutputDirectory, [switch]$Worker)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'NativeProcess.ps1')
$exitCode = 0
$output = [IO.Path]::GetFullPath($OutputDirectory)
function Get-OutputProcesses {
    $prefix = $output.TrimEnd('\') + '\'
    @(Get-Process | Where-Object {
        try { $_.Path -and $_.Path.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) }
        catch { $false }
    })
}
try {
    $source = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
    $repo = [IO.Path]::GetFullPath((Join-Path $source '../../..'))
    $output = [IO.Path]::GetFullPath($OutputDirectory)
    [void][IO.Directory]::CreateDirectory($output)
    $csc = "$env:SystemRoot\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
    if (-not $Worker) {
        if ((Get-OutputProcesses).Count) { throw 'OutputDirectory already contains a running process; refusing to reuse it' }
        Invoke-HiddenNative $csc @('/nologo', '/warnaserror+', '/target:exe', "/out:$output\HarnessHost.exe", '/r:System.Windows.Forms.dll', '/r:System.Web.Extensions.dll', "$PSScriptRoot\HarnessHost.cs")
        if ($LASTEXITCODE -ne 0) { throw "Harness compiler exited $LASTEXITCODE" }
        # HarnessHost starts this script suspended on a private desktop, assigns
        # its entire descendant tree to a kill-on-close job, then resumes it.
        # The host always drains that job in finally, including assertion failures.
        Invoke-HiddenNative "$output\HarnessHost.exe" @($PSCommandPath, $output)
        if ($LASTEXITCODE -ne 0) { throw "Contained launcher tests exited $LASTEXITCODE" }
        Invoke-HiddenNative 'powershell.exe' @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "$PSScriptRoot\HarnessTests.ps1", '-OutputDirectory', $output)
        if ($LASTEXITCODE -ne 0) { throw "Harness regression tests exited $LASTEXITCODE" }
    } else {
    if ($env:READABLE_LAUNCHER_TEST_WORKER -ne '1') { throw 'Worker mode requires the private-desktop harness host' }
    foreach ($name in @('common.ps1', 'update-broker.ps1', 'update-helper.ps1')) {
        $tokens = $null; $errors = $null
        [void][Management.Automation.Language.Parser]::ParseFile((Join-Path $source $name), [ref]$tokens, [ref]$errors)
        if ($errors.Count) { throw ($errors | Out-String) }
    }
    Invoke-HiddenNative $csc @('/nologo', '/warnaserror+', '/target:winexe', '/platform:x64', '/optimize+', "/out:$output\Readable Studio.exe", "/win32icon:$repo\tools\pack\resources\win\icon.ico", '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll', '/r:System.Web.Extensions.dll', "$source\ReadableStudioLauncher.cs")
    if ($LASTEXITCODE -ne 0) { throw "Launcher compiler exited $LASTEXITCODE" }
    Invoke-HiddenNative $csc @('/nologo', '/warnaserror+', '/target:exe', "/out:$output\DecisionTests.exe", "/r:$output\Readable Studio.exe", '/r:System.Web.Extensions.dll', "$PSScriptRoot\DecisionTests.cs")
    if ($LASTEXITCODE -ne 0) { throw "Test compiler exited $LASTEXITCODE" }
    Invoke-HiddenNative "$output\DecisionTests.exe" @("$output\fixture")
    if ($LASTEXITCODE -ne 0) { throw "Decision tests exited $LASTEXITCODE" }
    Invoke-HiddenNative $csc @('/nologo', '/warnaserror+', '/target:exe', "/out:$output\RecoveryTests.exe", "/r:$output\Readable Studio.exe", '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll', '/r:System.Web.Extensions.dll', "$PSScriptRoot\RecoveryTests.cs")
    if ($LASTEXITCODE -ne 0) { throw "Recovery test compiler exited $LASTEXITCODE" }
    Invoke-HiddenNative "$output\RecoveryTests.exe" @("$output\recovery-fixture")
    $recoveryExit = $LASTEXITCODE
    Invoke-HiddenNative $csc @('/nologo', '/warnaserror+', '/target:exe', "/out:$output\AttemptTests.exe", "/r:$output\Readable Studio.exe", '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll', '/r:System.Web.Extensions.dll', "$PSScriptRoot\AttemptTests.cs")
    if ($LASTEXITCODE -ne 0) { throw "Attempt test compiler exited $LASTEXITCODE" }
    Invoke-HiddenNative "$output\AttemptTests.exe" @("$output\attempt-fixture")
    $attemptExit = $LASTEXITCODE
    Invoke-HiddenNative 'powershell.exe' @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "$PSScriptRoot\HelperTests.ps1", '-Source', $source, '-Root', $output)
    if ($LASTEXITCODE -ne 0 -or $attemptExit -ne 0 -or $recoveryExit -ne 0) { throw "Recovery/attempt/helper tests exited $recoveryExit/$attemptExit/$LASTEXITCODE" }
    }
} catch {
    $_ | Out-String | Write-Output
    $exitCode = 1
} finally {
    if (-not $Worker) {
        $remaining = @(Get-OutputProcesses | Select-Object Id, Path, MainWindowHandle)
        $apps = @(Get-Process -Name 'Readable Studio' -ErrorAction SilentlyContinue | Select-Object Id, Path, MainWindowHandle)
        $audit = @{ outputDirectory = $output; remainingProcesses = $remaining; readableStudioProcesses = $apps; total = 1; passed = [int]($remaining.Count -eq 0); failed = [int]($remaining.Count -ne 0) } | ConvertTo-Json -Compress -Depth 4
        [IO.File]::WriteAllText((Join-Path $output 'process-audit.json'), $audit)
        Write-Output $audit
        if ($remaining.Count) {
            Write-Output 'FAIL launcher harness leaked processes under OutputDirectory'
            $exitCode = 1
        }
    }
}
exit $exitCode

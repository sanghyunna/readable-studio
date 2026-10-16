param([string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'NativeProcess.ps1')
$hostExe = Join-Path $OutputDirectory 'HarnessHost.exe'
$fixtureRoot = Join-Path $OutputDirectory 'harness-failure'
[void][IO.Directory]::CreateDirectory($fixtureRoot)
[IO.File]::Copy($hostExe, (Join-Path $fixtureRoot 'Readable Studio.exe'), $true)
Invoke-HiddenNative $hostExe @((Join-Path $PSScriptRoot 'HarnessFailureWorker.ps1'), $fixtureRoot)
$failureExit = $LASTEXITCODE
$report = [IO.File]::ReadAllText((Join-Path $fixtureRoot 'containment.json')) | ConvertFrom-Json
$fixturePid = [int][IO.File]::ReadAllText((Join-Path $fixtureRoot 'fixture-pid.txt'))
$checks = @(
    @{ Name = 'assertion failure preserves failing status'; Passed = $failureExit -ne 0 },
    @{ Name = 'finally kills the signaled window child'; Passed = $report.processesBeforeCleanup -ge 1 -and $report.processesAfterCleanup -eq 0 -and -not (Get-Process -Id $fixturePid -ErrorAction SilentlyContinue) },
    @{ Name = 'window child never reaches the interactive desktop'; Passed = $report.windowSamples -gt 0 -and $report.visibleWindowChanges -eq 0 }
)
$failed = @($checks | Where-Object { -not $_.Passed })
foreach ($check in $checks) { Write-Output "$($check.Passed) harness: $($check.Name)" }
$summary = @{ total = $checks.Count; passed = $checks.Count - $failed.Count; failed = $failed.Count } | ConvertTo-Json -Compress
[IO.File]::WriteAllText((Join-Path $OutputDirectory 'harness-results.json'), $summary)
Write-Output $summary
if ($failed.Count) { exit 1 }

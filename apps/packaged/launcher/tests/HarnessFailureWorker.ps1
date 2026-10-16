param([string]$OutputDirectory, [switch]$Worker)
$ErrorActionPreference = 'Stop'
$name = 'Local\ReadableHarnessFixture-' + [Guid]::NewGuid().ToString('N')
$ready = New-Object Threading.EventWaitHandle($false, [Threading.EventResetMode]::ManualReset, $name)
try {
    # The host puts this worker and every descendant on its private desktop/job.
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = Join-Path $OutputDirectory 'Readable Studio.exe'
    $info.Arguments = "--fixture $name"
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $fixture = [Diagnostics.Process]::Start($info)
    if (-not $ready.WaitOne(10000)) { throw 'Window fixture did not signal Shown' }
    [IO.File]::WriteAllText((Join-Path $OutputDirectory 'fixture-pid.txt'), [string]$fixture.Id)
    throw 'Intentional assertion failure after child window creation'
} finally {
    $ready.Dispose()
    # Deliberately leave the child to the enclosing host's finally/job cleanup.
}

param(
    [Parameter(Mandatory=$true)][string]$ZipExe,
    [Parameter(Mandatory=$true)][string]$Tree,
    [Parameter(Mandatory=$true)][string]$FileList,
    [Parameter(Mandatory=$true)][string]$Output,
    [int]$Threads = 0
)
$ErrorActionPreference = 'Stop'
$info = New-Object Diagnostics.ProcessStartInfo
$info.FileName = $ZipExe
$threadArgument = if ($Threads -gt 0) { " -mmt=$Threads" } else { '' }
$info.Arguments = 'a -tzip -mx=5 -bt -mtc=off -mta=off -mtm=off -scsUTF-8{0} "{1}" "@{2}"' -f $threadArgument,$Output,$FileList
$info.WorkingDirectory = $Tree
$info.UseShellExecute = $false
$info.CreateNoWindow = $true
$info.RedirectStandardOutput = $true
$info.RedirectStandardError = $true
$watch = [Diagnostics.Stopwatch]::StartNew()
$p = [Diagnostics.Process]::Start($info)
$stdout = $p.StandardOutput.ReadToEndAsync()
$stderr = $p.StandardError.ReadToEndAsync()
$observed = @{}
$samples = 0
$vanished = 0
try {
    # This is an explicitly time/CPU-measuring benchmark, not a wait-based test.
    # Sample only the owned archiver. No sleep or machine-wide process polling.
    while (-not $p.HasExited) {
        if ($watch.Elapsed.TotalSeconds -gt 60) { $p.Kill(); throw 'synthetic ZIP exceeded its 60-second budget' }
        $p.Refresh()
        $samples++
        foreach ($thread in $p.Threads) {
            try {
                $id = [string]$thread.Id
                $cpu = $thread.TotalProcessorTime.TotalMilliseconds
                if (-not $observed.ContainsKey($id)) {
                    $observed[$id] = @{id=$id;firstCpuMs=$cpu;lastCpuMs=$cpu;firstWallMs=$watch.Elapsed.TotalMilliseconds;lastWallMs=$watch.Elapsed.TotalMilliseconds;observations=1}
                } else {
                    $record = $observed[$id]
                    $record.lastCpuMs = [math]::Max($record.lastCpuMs,$cpu)
                    $record.lastWallMs = $watch.Elapsed.TotalMilliseconds
                    $record.observations++
                }
            } catch [ComponentModel.Win32Exception] { $vanished++ }
              catch [InvalidOperationException] { $vanished++ }
        }
    }
    $p.WaitForExit()
    $watch.Stop()
    if ($p.ExitCode -ne 0) { throw "7z failed $($p.ExitCode): $($stderr.Result)" }
    [pscustomobject]@{
        args=$info.Arguments;elapsedMs=$watch.Elapsed.TotalMilliseconds;cpuMs=$p.TotalProcessorTime.TotalMilliseconds;
        samples=$samples;vanishedThreadReads=$vanished;threads=@($observed.Values | Sort-Object id);
        stdout=$stdout.Result;stderr=$stderr.Result;exitCode=$p.ExitCode
    } | ConvertTo-Json -Depth 5 -Compress
} finally { $p.Dispose() }

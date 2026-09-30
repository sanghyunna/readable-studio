#Requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateRange(1, 2147483647)][int]$RootProcessId,
    [Parameter(Mandatory = $true)][string]$OutputPath,
    [Parameter(Mandatory = $true)][string]$StopPath,
    [ValidateRange(1, 86400)][int]$MaxSamples = 7200
)

$ErrorActionPreference = "Stop"
$EvidenceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\..\.omo\evidence\build-perf"))
$OutputPath = [IO.Path]::GetFullPath($OutputPath)
$StopPath = [IO.Path]::GetFullPath($StopPath)
foreach ($path in @($OutputPath, $StopPath)) {
    if (-not [string]::Equals([IO.Path]::GetDirectoryName($path), $EvidenceRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Profiler output and stop signal must stay in $EvidenceRoot"
    }
}
if ([IO.Path]::GetExtension($OutputPath) -ne ".log" -or [IO.Path]::GetExtension($StopPath) -ne ".json") {
    throw "Profiler output must be .log and the stop signal must be .json."
}
[IO.Directory]::CreateDirectory($EvidenceRoot) | Out-Null
# Never replace an existing evidence file, let alone a release archive.
$stream = [IO.File]::Open($OutputPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
$writer = [IO.StreamWriter]::new($stream, [Text.UTF8Encoding]::new($false))
$logicalProcessors = [Environment]::ProcessorCount
$previous = @{}
$previousElapsed = $null
$clock = [Diagnostics.Stopwatch]::StartNew()
$cimSession = $null

try {
    $cimSession = New-CimSession -SessionOption (New-CimSessionOption -Protocol Dcom)
    $writer.WriteLine((@{
        record = "metadata"; schemaVersion = 1; rootProcessId = $RootProcessId; recorderProcessId = $PID
        logicalProcessors = $logicalProcessors; timestampMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        nominalSampleIntervalMs = 1000; cpuSource = "Win32_PerfFormattedData_PerfOS_Processor._Total"
        diskSource = "Win32_PerfFormattedData_PerfDisk_PhysicalDisk"; processCounts = "sampled, not cumulative launches"
    } | ConvertTo-Json -Compress))
    for ($sample = 0; $sample -lt $MaxSamples; $sample++) {
        if ([IO.File]::Exists($StopPath)) { break }
        $collectionStarted = $clock.Elapsed.TotalMilliseconds
        $collectionStartMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        # CIM class/property names are stable on localized Windows installations.
        $cpu = Get-CimInstance -CimSession $cimSession Win32_PerfFormattedData_PerfOS_Processor -Filter "Name='_Total'"
        $disks = @(Get-CimInstance -CimSession $cimSession Win32_PerfFormattedData_PerfDisk_PhysicalDisk)
        if ($null -eq $cpu -or $null -eq $cpu.PercentProcessorTime -or $disks.Count -eq 0) {
            throw "Windows performance counters are unavailable; refusing to record missing data as idle."
        }
        $processes = @(Get-CimInstance -CimSession $cimSession Win32_Process -Property ProcessId, ParentProcessId, Name, CreationDate, KernelModeTime, UserModeTime, ReadTransferCount, WriteTransferCount)
        $root = @($processes | Where-Object { $_.ProcessId -eq $RootProcessId })
        if ($root.Count -eq 0) {
            if ($sample -eq 0) { throw "Build root PID $RootProcessId is not running." }
            break
        }
        $elapsed = $clock.Elapsed.TotalSeconds
        $interval = if ($null -eq $previousElapsed) { $null } else { $elapsed - $previousElapsed }
        $tree = [Collections.Generic.HashSet[int]]::new()
        [void]$tree.Add($RootProcessId)
        do {
            $before = $tree.Count
            foreach ($process in $processes) {
                if ($process.ProcessId -ne $PID -and $tree.Contains([int]$process.ParentProcessId)) {
                    [void]$tree.Add([int]$process.ProcessId)
                }
            }
        } while ($tree.Count -ne $before)

        $current = @{}
        $rows = @(foreach ($process in $processes) {
            $id = [int]$process.ProcessId
            $cpuSeconds = if ($null -eq $process.KernelModeTime -or $null -eq $process.UserModeTime) { $null } else {
                ([double]$process.KernelModeTime + [double]$process.UserModeTime) / 10000000
            }
            $readBytes = if ($null -eq $process.ReadTransferCount) { $null } else { [double]$process.ReadTransferCount }
            $writeBytes = if ($null -eq $process.WriteTransferCount) { $null } else { [double]$process.WriteTransferCount }
            $old = $previous[$id]
            $current[$id] = @{ cpuSeconds = $cpuSeconds; readBytes = $readBytes; writeBytes = $writeBytes; created = $process.CreationDate }
            $cpuPercent = $null
            $readRate = $null
            $writeRate = $null
            if ($null -ne $old -and $old.created -eq $process.CreationDate -and $null -ne $interval -and $interval -gt 0) {
                if ($null -ne $cpuSeconds -and $null -ne $old.cpuSeconds) {
                    $cpuPercent = 100 * ($cpuSeconds - $old.cpuSeconds) / $interval / $logicalProcessors
                }
                if ($null -ne $readBytes -and $null -ne $old.readBytes) { $readRate = ($readBytes - $old.readBytes) / $interval }
                if ($null -ne $writeBytes -and $null -ne $old.writeBytes) { $writeRate = ($writeBytes - $old.writeBytes) / $interval }
            }
            [pscustomobject]@{
                pid = $id; parentPid = [int]$process.ParentProcessId; name = $process.Name
                created = $process.CreationDate; cpuSeconds = $cpuSeconds; cpuPercentNormalized = $cpuPercent
                readBytesPerSecond = $readRate; writeBytesPerSecond = $writeRate
            }
        })
        $treeRows = @($rows | Where-Object { $tree.Contains($_.pid) })
        $knownCpuRows = @($treeRows | Where-Object { $null -ne $_.cpuPercentNormalized })
        $treeCpu = if ($knownCpuRows.Count -eq 0) { $null } else {
            ($knownCpuRows | Measure-Object -Property cpuPercentNormalized -Sum).Sum
        }
        $recorder = $rows | Where-Object { $_.pid -eq $PID }
        $record = @{
            record = "sample"; sample = $sample; timestampMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
            collectionStartMs = $collectionStartMs; collectionDurationMs = $clock.Elapsed.TotalMilliseconds - $collectionStarted
            elapsedSeconds = $elapsed; intervalSeconds = $interval; systemCpuPercentNormalized = [double]$cpu.PercentProcessorTime
            treeCpuPercentNormalized = $treeCpu; treeCpuCoverage = $knownCpuRows.Count; treeProcessCount = $treeRows.Count
            childProcessCount = [Math]::Max(0, $treeRows.Count - 1); systemProcessCount = $processes.Count
            recorderCpuPercentNormalized = $recorder.cpuPercentNormalized
            processes = $treeRows
            topCpuProcesses = @($rows | Where-Object { $null -ne $_.cpuPercentNormalized -and $_.pid -ne 0 } | Sort-Object -Property cpuPercentNormalized -Descending | Select-Object -First 8)
            disks = @($disks | ForEach-Object {
                @{ name = $_.Name; readBytesPerSecond = [double]$_.DiskReadBytesPersec; writeBytesPerSecond = [double]$_.DiskWriteBytesPersec
                   readsPerSecond = [double]$_.DiskReadsPersec; writesPerSecond = [double]$_.DiskWritesPersec
                   currentQueueDepth = [double]$_.CurrentDiskQueueLength; percentIdleTime = [double]$_.PercentIdleTime }
            })
        }
        $writer.WriteLine(($record | ConvertTo-Json -Depth 7 -Compress))
        $writer.Flush()
        if ($sample -eq 0) {
            [Console]::Out.WriteLine("BUILD_PROFILE_READY")
            [Console]::Out.Flush()
        }
        $previous = $current
        $previousElapsed = $elapsed
        if ($sample + 1 -lt $MaxSamples) {
            # Cadence is the behavior of this sampler, not a readiness sleep.
            $remainingMs = [Math]::Max(0, 1000 - ($clock.Elapsed.TotalMilliseconds - $collectionStarted))
            if ($remainingMs -gt 0) { Start-Sleep -Milliseconds ([int]$remainingMs) }
        }
    }
} finally {
    $writer.Dispose()
    $clock.Stop()
    if ($null -ne $cimSession) { Remove-CimSession -CimSession $cimSession }
}

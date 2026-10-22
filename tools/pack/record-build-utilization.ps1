#Requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateRange(1, 2147483647)][int]$RootProcessId,
    [Parameter(Mandatory = $true)][string]$OutputPath,
    [Parameter(Mandatory = $true)][string]$StopPath,
    [ValidateRange(1, 86400)][int]$MaxSamples = 7200,
    [int[]]$ExtraRootProcessIds = @(),
    [switch]$Append
)

$ErrorActionPreference = "Stop"
$EvidenceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\..\.omo\evidence\build-perf"))
$ScratchRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\..\.tmp\build-verify-speed")) + [IO.Path]::DirectorySeparatorChar
$OutputPath = [IO.Path]::GetFullPath($OutputPath)
$StopPath = [IO.Path]::GetFullPath($StopPath)
foreach ($path in @($OutputPath, $StopPath)) {
    if (-not [string]::Equals([IO.Path]::GetDirectoryName($path), $EvidenceRoot, [StringComparison]::OrdinalIgnoreCase) -and
        -not $path.StartsWith($ScratchRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Profiler output and stop signal must stay in $EvidenceRoot or $ScratchRoot"
    }
}
if ([IO.Path]::GetExtension($OutputPath) -ne ".log" -or [IO.Path]::GetExtension($StopPath) -ne ".json") {
    throw "Profiler output must be .log and the stop signal must be .json."
}
[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($OutputPath)) | Out-Null

# Build the set of watched root PIDs. The primary root is authoritative for the
# "watched parent PID exited" stop condition, but all roots and their trees are
# measured.
$watchedRootPids = [Collections.Generic.HashSet[int]]::new()
[void]$watchedRootPids.Add($RootProcessId)
foreach ($extra in $ExtraRootProcessIds) { [void]$watchedRootPids.Add($extra) }

$mode = if ($Append) { [IO.FileMode]::Append } else { [IO.FileMode]::CreateNew }
$stream = [IO.File]::Open($OutputPath, $mode, [IO.FileAccess]::Write, [IO.FileShare]::Read)
$writer = [IO.StreamWriter]::new($stream, [Text.UTF8Encoding]::new($false))
$logicalProcessors = [Environment]::ProcessorCount
$previous = @{} # pid -> @{ cpuSeconds; readBytes; writeBytes; created }
$previousElapsed = $null
$clock = [Diagnostics.Stopwatch]::StartNew()
$queryPool = $null
$queries = @()

function Get-ProcessTree {
    param([Collections.Generic.HashSet[int]]$roots, [array]$processes)
    $tree = [Collections.Generic.HashSet[int]]::new($roots)
    do {
        $before = $tree.Count
        foreach ($process in $processes) {
            $id = [int]$process.ProcessId
            if ($id -eq $PID) { continue }
            if ($tree.Contains([int]$process.ParentProcessId)) { [void]$tree.Add($id) }
        }
    } while ($tree.Count -ne $before)
    # PowerShell enumerates returned collections; preserve the HashSet even when
    # the coordinator has no child jobs yet and the tree contains only one PID.
    return ,$tree
}

try {
    # Each local CIM round trip costs hundreds of milliseconds on Windows.
    # Collect independent classes concurrently so those waits do not turn the
    # nominal one-second recorder into a two-second recorder.
    $queryPool = [RunspaceFactory]::CreateRunspacePool(5, 5)
    $queryPool.Open()
    foreach ($command in @(
        'Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -ErrorAction Stop',
        'Get-CimInstance Win32_PerfFormattedData_PerfDisk_PhysicalDisk -ErrorAction Stop',
        'Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory -ErrorAction Stop',
        'Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, Name, CreationDate, KernelModeTime, UserModeTime, ReadTransferCount, WriteTransferCount, WorkingSetSize, HandleCount -ErrorAction Stop',
        'try { Get-CimInstance -Namespace ROOT/StandardCimv2 -ClassName MSFT_NetTCPConnection -OperationTimeoutSec 1 -ErrorAction Stop } catch { }'
    )) {
        $query = [PowerShell]::Create()
        $query.RunspacePool = $queryPool
        [void]$query.AddScript($command)
        $queries += $query
    }

    if (-not $Append) {
        $writer.WriteLine((@{
            record = "metadata"; schemaVersion = 2; rootProcessId = $RootProcessId
            extraRootProcessIds = @($ExtraRootProcessIds)
            recorderProcessId = $PID; logicalProcessors = $logicalProcessors
            timestampMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
            nominalSampleIntervalMs = 1000
            cpuSource = "Win32_PerfFormattedData_PerfOS_Processor"
            coreSource = "Win32_PerfFormattedData_PerfOS_Processor"
            memorySource = "Win32_PerfFormattedData_PerfOS_Memory"
            tcpSource = "MSFT_NetTCPConnection"
            diskSource = "Win32_PerfFormattedData_PerfDisk_PhysicalDisk"
            processSource = "Win32_Process"
        } | ConvertTo-Json -Compress))
    }

    for ($sample = 0; $sample -lt $MaxSamples; $sample++) {
        if ([IO.File]::Exists($StopPath)) { break }
        $collectionStarted = $clock.Elapsed.TotalMilliseconds
        $collectionStartMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()

        # Total and per-core CPU. CIM class/property names are stable on localized
        # Windows installations, avoiding Korean-localized Get-Counter counter paths.
        $pending = @($queries | ForEach-Object { $_.BeginInvoke() })
        $collected = @()
        for ($index = 0; $index -lt $queries.Count; $index++) {
            $collected += ,@($queries[$index].EndInvoke($pending[$index]))
        }
        $cpus = $collected[0]
        $cpuTotal = @($cpus | Where-Object { $_.Name -eq '_Total' })
        $cpuCores = @($cpus | Where-Object { $_.Name -ne '_Total' } | Sort-Object { [int]$_.Name })
        $disks = $collected[1]
        $memory = $collected[2]
        $processes = $collected[3]

        if ($cpuTotal.Count -eq 0 -or $null -eq $cpuTotal[0].PercentProcessorTime -or $disks.Count -eq 0) {
            throw "Windows performance counters are unavailable; refusing to record missing data as idle."
        }

        # Stop if every watched root PID has exited. If the primary root was never
        # alive, fail on the first sample so callers do not silently profile nothing.
        $rootsAlive = @($processes | Where-Object { $watchedRootPids.Contains([int]$_.ProcessId) })
        if ($rootsAlive.Count -eq 0) {
            if ($sample -eq 0) { throw "Build root PID $RootProcessId is not running." }
            break
        }

        $elapsed = $clock.Elapsed.TotalSeconds
        $interval = if ($null -eq $previousElapsed) { $null } else { $elapsed - $previousElapsed }
        $tree = Get-ProcessTree -roots $watchedRootPids -processes $processes

        # TCP connection counts by state. Numeric states avoid localized strings.
        $tcpByState = @{ }
        foreach ($conn in $collected[4]) {
            $state = [string][int]$conn.State
            $tcpByState[$state] = 1 + $tcpByState[$state]
        }

        $commitUsed = $null
        $commitLimit = $null
        if ($memory.Count -gt 0) {
            $commitUsed = [double]$memory[0].CommittedBytes
            $commitLimit = [double]$memory[0].CommitLimit
        }

        $current = @{}
        $rows = @(foreach ($process in $processes) {
            $id = [int]$process.ProcessId
            $cpuSeconds = if ($null -eq $process.KernelModeTime -or $null -eq $process.UserModeTime) { $null } else {
                ([double]$process.KernelModeTime + [double]$process.UserModeTime) / 10000000
            }
            $readBytes = if ($null -eq $process.ReadTransferCount) { $null } else { [double]$process.ReadTransferCount }
            $writeBytes = if ($null -eq $process.WriteTransferCount) { $null } else { [double]$process.WriteTransferCount }
            $workingSet = if ($null -eq $process.WorkingSetSize) { $null } else { [double]$process.WorkingSetSize }
            $handles = if ($null -eq $process.HandleCount) { $null } else { [int]$process.HandleCount }
            $old = $previous[$id]
            $current[$id] = @{ cpuSeconds = $cpuSeconds; readBytes = $readBytes; writeBytes = $writeBytes; created = $process.CreationDate; workingSet = $workingSet; handles = $handles }
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
                workingSetBytes = $workingSet; handleCount = $handles
            }
        })
        $treeRows = @($rows | Where-Object { $tree.Contains($_.pid) })
        $knownCpuRows = @($treeRows | Where-Object { $null -ne $_.cpuPercentNormalized })
        $treeCpu = if ($knownCpuRows.Count -eq 0) { $null } else {
            ($knownCpuRows | Measure-Object -Property cpuPercentNormalized -Sum).Sum
        }
        $treeWorkingSet = ($treeRows | Where-Object { $null -ne $_.workingSetBytes } | Measure-Object -Property workingSetBytes -Sum).Sum
        $treeHandles = ($treeRows | Where-Object { $null -ne $_.handleCount } | Measure-Object -Property handleCount -Sum).Sum
        $recorder = $rows | Where-Object { $_.pid -eq $PID }

        $gapMs = $null
        $gap = $false
        if ($null -ne $interval -and $interval -gt 0) {
            $gapMs = [Math]::Max(0, ($elapsed - $previousElapsed) * 1000 - 1000)
            # Any sample that took materially longer than the nominal 1 s cadence is a gap.
            $gap = $gapMs -gt 100
        }

        $coreRecords = @($cpuCores | ForEach-Object {
            @{ name = $_.Name; percentProcessorTime = [double]$_.PercentProcessorTime }
        })
        $activeCores = @($coreRecords | Where-Object { $_.percentProcessorTime -gt 0 } | ForEach-Object { $_.name })

        $diskRecords = @($disks | ForEach-Object {
            $idle = [double]$_.PercentIdleTime
            @{ name = $_.Name; readBytesPerSecond = [double]$_.DiskReadBytesPersec; writeBytesPerSecond = [double]$_.DiskWriteBytesPersec
               readsPerSecond = [double]$_.DiskReadsPersec; writesPerSecond = [double]$_.DiskWritesPersec
               currentQueueDepth = [double]$_.CurrentDiskQueueLength; percentIdleTime = $idle; percentBusyTime = [Math]::Max(0, 100 - $idle) }
        })

        $record = @{
            record = "sample"; sample = $sample; timestampMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
            collectionStartMs = $collectionStartMs; collectionDurationMs = $clock.Elapsed.TotalMilliseconds - $collectionStarted
            elapsedSeconds = $elapsed; intervalSeconds = $interval; gapMs = $gapMs; gap = $gap
            systemCpuPercentNormalized = [double]$cpuTotal[0].PercentProcessorTime
            cores = $coreRecords; activeCoreCount = $activeCores.Count; activeCores = $activeCores; allCoresActive = ($activeCores.Count -eq $logicalProcessors)
            treeCpuPercentNormalized = $treeCpu; treeCpuCoverage = $knownCpuRows.Count; treeProcessCount = $treeRows.Count
            treeWorkingSetBytes = $treeWorkingSet; treeHandleCount = $treeHandles
            childProcessCount = [Math]::Max(0, $treeRows.Count - $watchedRootPids.Count)
            systemProcessCount = $processes.Count
            recorderCpuPercentNormalized = $recorder.cpuPercentNormalized
            processes = $treeRows
            topCpuProcesses = @($rows | Where-Object { $null -ne $_.cpuPercentNormalized -and $_.pid -ne 0 } | Sort-Object -Property cpuPercentNormalized -Descending | Select-Object -First 8)
            commitChargeUsedBytes = $commitUsed; commitChargeLimitBytes = $commitLimit
            tcpConnectionsByState = $tcpByState
            disks = $diskRecords
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
    foreach ($query in $queries) { $query.Dispose() }
    if ($null -ne $queryPool) { $queryPool.Dispose() }
}

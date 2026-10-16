# Console children of a CREATE_NO_WINDOW worker must also use CREATE_NO_WINDOW;
# otherwise Windows can allocate a console on the interactive desktop.
function Invoke-HiddenNative([string]$FileName, [string[]]$Arguments) {
    $start = [Diagnostics.ProcessStartInfo]::new($FileName)
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    # These arguments are switches and Windows paths, which cannot contain ".
    # Double trailing backslashes before the closing argument quote.
    $start.Arguments = (($Arguments | ForEach-Object {
        $trailing = [regex]::Match($_, '\\*$').Value
        '"' + $_ + $trailing + '"'
    }) -join ' ')
    $child = [Diagnostics.Process]::Start($start)
    try {
        $stdout = $child.StandardOutput.ReadToEndAsync()
        $stderr = $child.StandardError.ReadToEndAsync()
        $child.WaitForExit()
        $script:LASTEXITCODE = $child.ExitCode
        $text = $stdout.GetAwaiter().GetResult()
        if ($text) { Write-Output $text.TrimEnd() }
        $text = $stderr.GetAwaiter().GetResult()
        if ($text) { Write-Output $text.TrimEnd() }
    } finally { $child.Dispose() }
}

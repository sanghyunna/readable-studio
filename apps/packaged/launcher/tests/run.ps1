param([Parameter(Mandatory=$true)][string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
try {
    $source = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
    $repo = [IO.Path]::GetFullPath((Join-Path $source '../../..'))
    $output = [IO.Path]::GetFullPath($OutputDirectory)
    [void][IO.Directory]::CreateDirectory($output)
    $csc = "$env:SystemRoot\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
    foreach ($name in @('common.ps1', 'update-broker.ps1', 'update-helper.ps1')) {
        $tokens = $null; $errors = $null
        [void][Management.Automation.Language.Parser]::ParseFile((Join-Path $source $name), [ref]$tokens, [ref]$errors)
        if ($errors.Count) { throw ($errors | Out-String) }
    }
    & $csc /nologo /warnaserror+ /target:winexe /platform:x64 /optimize+ "/out:$output\Readable Studio.exe" "/win32icon:$repo\tools\pack\resources\win\icon.ico" /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.Web.Extensions.dll "$source\ReadableStudioLauncher.cs"
    if ($LASTEXITCODE -ne 0) { throw "Launcher compiler exited $LASTEXITCODE" }
    & $csc /nologo /warnaserror+ /target:exe "/out:$output\DecisionTests.exe" "/r:$output\Readable Studio.exe" "$PSScriptRoot\DecisionTests.cs"
    if ($LASTEXITCODE -ne 0) { throw "Test compiler exited $LASTEXITCODE" }
    & "$output\DecisionTests.exe" "$output\fixture"
    if ($LASTEXITCODE -ne 0) { throw "Decision tests exited $LASTEXITCODE" }
    exit 0
} catch {
    $_ | Out-String | Write-Output
    exit 1
}

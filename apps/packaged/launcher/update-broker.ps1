param(
    [Parameter(Mandatory=$true)][string]$Root,
    [Parameter(Mandatory=$true)][string]$Staging,
    [Parameter(Mandatory=$true)][string]$TargetVersion,
    [Parameter(Mandatory=$true)][int]$WaitPid
)
$ErrorActionPreference = 'Stop'
try {
    . (Join-Path $PSScriptRoot 'common.ps1')
    Import-Launcher $Root
    Assert-UpdatePaths $Root $Staging
    $arguments = Get-UpdateArguments (Join-Path $PSScriptRoot 'update-helper.ps1') $Root $Staging $TargetVersion $WaitPid
    # Start-Process detaches the helper from the Electron/broker lifetime.
    $helper = Start-Process -FilePath "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -ArgumentList $arguments -WindowStyle Hidden -PassThru
    $helper.Dispose()
    exit 0
} catch {
    [IO.File]::WriteAllText((Join-Path $Root 'update-broker-error.log'), $_.Exception.ToString())
    Add-Type -AssemblyName System.Windows.Forms
    [void][Windows.Forms.MessageBox]::Show("업데이트 준비 상태를 확인하지 못했습니다. 앱을 다시 실행해 주세요.`n" + $_.Exception.Message, 'Readable Studio 업데이트')
    exit 1
}

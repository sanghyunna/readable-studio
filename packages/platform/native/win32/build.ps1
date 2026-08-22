$ErrorActionPreference = "Stop"

if ($env:OS -ne "Windows_NT") {
  throw "build:native:win32 requires Windows"
}

$source = Join-Path $PSScriptRoot "agent-isolator.cpp"
$outputDir = Join-Path $PSScriptRoot "..\..\dist\native\win32"
$output = Join-Path $outputDir "agent-isolator.exe"
$object = Join-Path $outputDir "agent-isolator.obj"
$vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"

if (-not (Test-Path -LiteralPath $vswhere)) {
  throw "Visual Studio Installer (vswhere.exe) was not found"
}

$visualStudio = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $visualStudio) {
  throw "Visual Studio C++ x64 build tools were not found"
}

$vsDevCmd = Join-Path $visualStudio "Common7\Tools\VsDevCmd.bat"
if (-not (Test-Path -LiteralPath $vsDevCmd)) {
  throw "VsDevCmd.bat was not found at $vsDevCmd"
}

New-Item -ItemType Directory -Force -Path $outputDir | Out-Null

$compile = @(
  "call `"$vsDevCmd`" -no_logo -arch=amd64 -host_arch=amd64 >nul",
  "cl.exe /nologo /std:c++20 /EHsc /permissive- /W4 /WX /DUNICODE /D_UNICODE /O2 /MT /Brepro /Fo`"$object`" /Fe`"$output`" `"$source`" advapi32.lib bcrypt.lib userenv.lib ws2_32.lib /link /Brepro"
) -join " && "

& $env:ComSpec /d /s /c $compile
if ($LASTEXITCODE -ne 0) {
  throw "MSVC failed with exit code $LASTEXITCODE"
}

Remove-Item -LiteralPath $object -Force -ErrorAction SilentlyContinue
Write-Output $output

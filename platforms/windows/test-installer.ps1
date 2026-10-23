$ErrorActionPreference = 'Stop'
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$Compiler = Get-Command ISCC.exe -ErrorAction SilentlyContinue
$CompilerPath = if ($Compiler) { $Compiler.Source } else { Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe' }
if (!(Test-Path -LiteralPath $CompilerPath -PathType Leaf)) { throw 'Inno Setup 6 is required for the installer compilation test' }
$Fixture = Join-Path $RepoRoot 'dist\verification\installer-source'
$Output = Join-Path $RepoRoot 'dist\verification\installer-compile'
New-Item -ItemType Directory -Path $Fixture, $Output -Force | Out-Null
# A compile-only fixture; never execute the generated setup or this placeholder.
Set-Content -LiteralPath (Join-Path $Fixture 'JobTrackerHost.exe') -Value 'Not an executable: installer compile fixture'
$Minimum = ([xml](Get-Content (Join-Path $PSScriptRoot 'JobTracker.WebView.csproj') -Raw)).Project.PropertyGroup.MinimumDesktopRuntimeVersion
foreach ($Arch in @('x64', 'arm64')) {
  & $CompilerPath '/DMyAppVersion=0.0.0' "/DTargetArch=$Arch" "/DMinimumDotNetVersion=$Minimum" "/DSourceDir=$Fixture" "/DOutputDir=$Output" (Join-Path $PSScriptRoot 'installer.iss')
  if ($LASTEXITCODE -ne 0) { throw "Installer compile failed: $Arch" }
}
Write-Host 'x64 and ARM64 setup scripts compiled; no installer was executed.'

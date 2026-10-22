$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'ensure-desktop-runtime.ps1')

$script:passed = 0
function Assert-True($Value, [string]$Message) { if (!$Value) { throw $Message } }
function Assert-Throws([scriptblock]$Action, [string]$Pattern) {
  try { & $Action } catch { if ($_.Exception.Message -match $Pattern) { return }; throw }
  throw "Expected failure: $Pattern"
}
$mockable = @('Get-InstalledFrameworkVersions', 'Test-DesktopRuntimeInstalled', 'Save-OfficialDownload', 'Assert-MicrosoftInstaller', 'Start-DesktopRuntimeInstaller', 'Get-FileHash', 'Get-AuthenticodeSignature')
$original = @{}
foreach ($name in $mockable) { $original[$name] = (Get-Command $name).ScriptBlock }
function Restore-Functions {
  foreach ($name in $mockable) {
    if ($null -eq $original[$name]) { Remove-Item "Function:script:$name" -ErrorAction SilentlyContinue }
    else { Set-Item "Function:script:$name" $original[$name] }
  }
}
function New-Fixture([string]$Arch = 'x64', [string]$Version = '10.0.14') {
  return @{ 'channel-version' = '10.0'; releases = @(@{ windowsdesktop = @{ version = $Version; files = @(@{
    name = "windowsdesktop-runtime-win-$Arch.exe"; rid = "win-$Arch";
    url = "https://builds.dotnet.microsoft.com/dotnet/WindowsDesktop/$Version/windowsdesktop-runtime-$Version-win-$Arch.exe";
    hash = ('a' * 128)
  }) } }) }
}

try {
  foreach ($version in @('10.0.13', '10.0.14', '10.0.100')) { Assert-True (Test-CompatibleRuntimeVersion $version ([version]'10.0.13')) "Should accept $version" }
  foreach ($version in @('10.0.12', '9.0.20', '11.0.0', '10.1.0', '10.0.14-preview.1', 'invalid')) { Assert-True (!(Test-CompatibleRuntimeVersion $version ([version]'10.0.13'))) "Should reject $version" }
  $script:passed++

  foreach ($arch in @('x64', 'arm64')) {
    $spec = Select-DesktopRuntimeInstaller (New-Fixture $arch) $arch ([version]'10.0.13')
    Assert-True ($spec.Filename -eq "windowsdesktop-runtime-10.0.14-win-$arch.exe") 'Wrong installer CPU'
  }
  $fixture = New-Fixture
  $fixture.releases += (New-Fixture x64 '10.0.15').releases
  $fixture.releases += (New-Fixture x64 '10.0.16-preview.1').releases
  Assert-True ((Select-DesktopRuntimeInstaller $fixture x64 ([version]'10.0.13')).Version -eq '10.0.15') 'Latest stable patch not selected'
  Assert-Throws { Select-DesktopRuntimeInstaller (New-Fixture arm64) x64 ([version]'10.0.13') } 'Missing installer'
  Assert-Throws { Select-DesktopRuntimeInstaller (New-Fixture x64 '10.0.12') x64 ([version]'10.0.13') } 'No compatible'
  $script:passed++

  foreach ($badUrl in @('http://builds.dotnet.microsoft.com/test.exe', 'https://example.com/test.exe', 'https://builds.dotnet.microsoft.com.evil.example/test.exe', 'https://builds.dotnet.microsoft.com/dotnet/WindowsDesktop/10.0.14/windowsdesktop-runtime-10.0.14-win-arm64.exe', 'https://builds.dotnet.microsoft.com/dotnet/WindowsDesktop/10.0.14/windowsdesktop-runtime-10.0.14-win-x64.exe?redirect=evil')) {
    $fixture = New-Fixture; $fixture.releases[0].windowsdesktop.files[0].url = $badUrl
    Assert-Throws { Select-DesktopRuntimeInstaller $fixture x64 ([version]'10.0.13') } 'Invalid official'
  }
  $fixture = New-Fixture; $fixture.releases[0].windowsdesktop.files[0].hash = 'bad'
  Assert-Throws { Select-DesktopRuntimeInstaller $fixture x64 ([version]'10.0.13') } 'SHA-512'
  $script:passed++

  function Get-InstalledFrameworkVersions { param($Arch, $Framework); if ($Arch -eq 'x64' -and $Framework -eq 'Microsoft.NETCore.App') { '10.0.13' } }
  Assert-True (!(Test-DesktopRuntimeInstalled x64 ([version]'10.0.13'))) 'Core runtime alone must not satisfy Desktop prerequisite'
  function Get-InstalledFrameworkVersions { param($Arch, $Framework); if ($Arch -eq 'x64') { '10.0.13' } }
  Assert-True (Test-DesktopRuntimeInstalled x64 ([version]'10.0.13')) 'Both frameworks must satisfy prerequisite'
  Assert-True (!(Test-DesktopRuntimeInstalled arm64 ([version]'10.0.13'))) 'Different CPU must not satisfy prerequisite'
  Restore-Functions
  $script:passed++

  function Get-FileHash { return @{ Hash = ('a' * 128) } }
  function Get-AuthenticodeSignature { return @{ Status = 'NotSigned'; SignerCertificate = $null } }
  Assert-Throws { Assert-MicrosoftInstaller 'mock.exe' ('b' * 128) } 'SHA-512'
  Assert-Throws { Assert-MicrosoftInstaller 'mock.exe' ('a' * 128) } 'signature'
  $script:certificate = New-Object PSObject
  $script:certificate | Add-Member ScriptMethod GetNameInfo { param($Type, $Issuer); return 'Untrusted Publisher' }
  function Get-AuthenticodeSignature { return @{ Status = 'Valid'; SignerCertificate = $script:certificate } }
  Assert-Throws { Assert-MicrosoftInstaller 'mock.exe' ('a' * 128) } 'signature'
  $script:certificate | Add-Member ScriptMethod GetNameInfo { param($Type, $Issuer); return 'Microsoft Corporation' } -Force
  Assert-MicrosoftInstaller 'mock.exe' ('a' * 128)
  Restore-Functions
  $script:passed++

  function Test-DesktopRuntimeInstalled { return $true }
  function Save-OfficialDownload { throw 'Must not download for an installed runtime' }
  function Start-DesktopRuntimeInstaller { throw 'Must not start installer for an installed runtime' }
  Assert-True ((Ensure-DesktopRuntime x64 '10.0.13') -eq 0) 'Already-installed path failed'
  Restore-Functions
  $script:passed++

  foreach ($mode in @('success', 'restart', 'cancel', 'network', 'integrity', 'missing-after-install')) {
    $script:mode = $mode; $script:events = @(); $script:temporaryDirectory = $null; $script:checks = 0
    function Test-DesktopRuntimeInstalled {
      $script:checks++
      return $script:checks -gt 1 -and $script:mode -ne 'missing-after-install'
    }
    function Save-OfficialDownload {
      param($Uri, $Destination, $MaxBytes)
      $script:temporaryDirectory = Split-Path $Destination
      if ($script:mode -eq 'network') { throw 'Network unavailable' }
      if ($Destination.EndsWith('.json')) { New-Fixture | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $Destination -Encoding UTF8 }
      else { Set-Content -LiteralPath $Destination -Value 'mock installer' }
    }
    function Assert-MicrosoftInstaller {
      $script:events += 'verified'
      if ($script:mode -eq 'integrity') { throw 'Integrity mismatch' }
    }
    function Start-DesktopRuntimeInstaller {
      Assert-True ($script:events.Count -eq 1 -and $script:events[0] -eq 'verified') 'Installer ran before verification'
      $script:events += 'started'
      if ($script:mode -eq 'restart') { return 3010 }
      if ($script:mode -eq 'cancel') { return 1602 }
      return 0
    }
    switch ($mode) {
      'success' { Assert-True ((Ensure-DesktopRuntime x64 '10.0.13') -eq 0) 'Installation failed' }
      'restart' { Assert-True ((Ensure-DesktopRuntime x64 '10.0.13') -eq 3010) 'Restart not propagated' }
      'cancel' { Assert-Throws { Ensure-DesktopRuntime x64 '10.0.13' } 'cancelled' }
      'network' { Assert-Throws { Ensure-DesktopRuntime x64 '10.0.13' } 'Network unavailable' }
      'integrity' {
        Assert-Throws { Ensure-DesktopRuntime x64 '10.0.13' } 'Integrity mismatch'
        Assert-True ($script:events -notcontains 'started') 'Unverified installer ran'
      }
      'missing-after-install' { Assert-Throws { Ensure-DesktopRuntime x64 '10.0.13' } 'not detected' }
    }
    Assert-True (!(Test-Path -LiteralPath $script:temporaryDirectory)) 'Temporary download not cleaned up'
    Restore-Functions
    $script:passed++
  }
  Write-Host "Desktop Runtime prerequisite: $script:passed test groups passed; no download, UAC or installation performed."
} finally { Restore-Functions }

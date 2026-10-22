param(
  [ValidateSet('x64', 'arm64')][string]$Architecture,
  [string]$MinimumVersion,
  [string]$ResultFile
)

$ErrorActionPreference = 'Stop'

function Test-CompatibleRuntimeVersion {
  param([string]$Version, [version]$Minimum)
  if ($Version -notmatch '^\d+\.\d+\.\d+$') { return $false }
  $parsed = [version]$Version
  return $parsed.Major -eq $Minimum.Major -and $parsed.Minor -eq $Minimum.Minor -and $parsed -ge $Minimum
}

function Get-InstalledFrameworkVersions {
  param([string]$Arch, [string]$Framework)
  # .NET installations can register in either registry view, regardless of this process's CPU.
  foreach ($view in @([Microsoft.Win32.RegistryView]::Registry64, [Microsoft.Win32.RegistryView]::Registry32)) {
    $base = $null; $key = $null; $fx = $null
    try {
      $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine, $view)
      $key = $base.OpenSubKey("SOFTWARE\dotnet\Setup\InstalledVersions\$Arch")
      if ($null -eq $key) { continue }
      $location = [string]$key.GetValue('InstallLocation')
      $fx = $key.OpenSubKey("sharedfx\$Framework")
      if (!$location -or $null -eq $fx) { continue }
      foreach ($version in $fx.GetValueNames()) {
        if ($version -notmatch '^\d+\.\d+\.\d+$') { continue }
        $directory = Join-Path $location "shared\$Framework\$version"
        $requiredFile = if ($Framework -eq 'Microsoft.WindowsDesktop.App') { 'System.Windows.Forms.dll' } else { 'System.Private.CoreLib.dll' }
        if (Test-Path -LiteralPath (Join-Path $directory $requiredFile) -PathType Leaf) { $version }
      }
    } finally {
      if ($null -ne $fx) { $fx.Dispose() }
      if ($null -ne $key) { $key.Dispose() }
      if ($null -ne $base) { $base.Dispose() }
    }
  }
}

function Test-DesktopRuntimeInstalled {
  param([string]$Arch, [version]$Minimum)
  foreach ($framework in @('Microsoft.NETCore.App', 'Microsoft.WindowsDesktop.App')) {
    $matching = @(Get-InstalledFrameworkVersions $Arch $framework | Where-Object { Test-CompatibleRuntimeVersion $_ $Minimum })
    if ($matching.Count -eq 0) { return $false }
  }
  return $true
}

function Save-OfficialDownload {
  param([uri]$Uri, [string]$Destination, [long]$MaxBytes)
  if ($Uri.Scheme -ne 'https' -or $Uri.Port -ne 443 -or $Uri.UserInfo -or $Uri.Query -or $Uri.Fragment -or
      $Uri.DnsSafeHost -notin @('builds.dotnet.microsoft.com', 'download.visualstudio.microsoft.com')) { throw 'Unofficial download URL' }
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $request = [Net.HttpWebRequest]::Create($Uri)
  $request.AllowAutoRedirect = $false
  $request.Timeout = 30000
  $request.ReadWriteTimeout = 30000
  $response = $null; $inputStream = $null; $outputStream = $null
  try {
    $response = $request.GetResponse()
    if ([int]$response.StatusCode -ne 200 -or $response.ContentLength -gt $MaxBytes) { throw 'Invalid download response' }
    $inputStream = $response.GetResponseStream()
    $outputStream = [IO.File]::Open($Destination, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    $buffer = New-Object byte[] 65536
    $total = 0L; $timer = [Diagnostics.Stopwatch]::StartNew()
    while (($count = $inputStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
      $total += $count
      if ($total -gt $MaxBytes -or $timer.Elapsed.TotalSeconds -gt 180) { throw 'Download limit exceeded' }
      $outputStream.Write($buffer, 0, $count)
    }
  } finally {
    if ($null -ne $outputStream) { $outputStream.Dispose() }
    if ($null -ne $inputStream) { $inputStream.Dispose() }
    if ($null -ne $response) { $response.Dispose() }
  }
}

function Select-DesktopRuntimeInstaller {
  param($Metadata, [string]$Arch, [version]$Minimum)
  $channel = "$($Minimum.Major).$($Minimum.Minor)"
  if ($Metadata.'channel-version' -ne $channel) { throw 'Unexpected .NET channel' }
  $releases = @($Metadata.releases | Where-Object {
    $null -ne $_.windowsdesktop -and (Test-CompatibleRuntimeVersion ([string]$_.windowsdesktop.version) $Minimum)
  } | Sort-Object { [version]$_.windowsdesktop.version } -Descending)
  if ($releases.Count -eq 0) { throw 'No compatible stable Desktop Runtime release' }
  $desktop = $releases[0].windowsdesktop
  $version = [string]$desktop.version
  $files = @($desktop.files | Where-Object { $_.rid -eq "win-$Arch" -and $_.name -eq "windowsdesktop-runtime-win-$Arch.exe" })
  if ($files.Count -ne 1 -or $files[0].hash -notmatch '^[a-fA-F0-9]{128}$') { throw 'Missing installer or SHA-512' }
  $uri = [uri]$files[0].url
  $filename = "windowsdesktop-runtime-$version-win-$Arch.exe"
  if ($uri.Scheme -ne 'https' -or $uri.Port -ne 443 -or $uri.UserInfo -or $uri.Query -or $uri.Fragment -or
      !(($uri.DnsSafeHost -eq 'builds.dotnet.microsoft.com' -and $uri.AbsolutePath -ceq "/dotnet/WindowsDesktop/$version/$filename") -or
        ($uri.DnsSafeHost -eq 'download.visualstudio.microsoft.com' -and $uri.AbsolutePath.StartsWith('/download/pr/') -and $uri.AbsolutePath.EndsWith('/' + $filename)))) { throw 'Invalid official installer URL' }
  return @{ Version = $version; Url = $uri; Hash = [string]$files[0].hash; Filename = $filename }
}

function Assert-MicrosoftInstaller {
  param([string]$File, [string]$ExpectedHash)
  if ((Get-FileHash -LiteralPath $File -Algorithm SHA512).Hash -ine $ExpectedHash) { throw 'Installer SHA-512 mismatch' }
  $signature = Get-AuthenticodeSignature -LiteralPath $File
  if ($signature.Status -ne 'Valid' -or $null -eq $signature.SignerCertificate -or
      $signature.SignerCertificate.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false) -cne 'Microsoft Corporation') { throw 'Invalid Microsoft installer signature' }
}

function Start-DesktopRuntimeInstaller {
  param([string]$File)
  # Only the verified Microsoft installer elevates; the app remains a per-user install.
  $process = Start-Process -FilePath $File -ArgumentList @('/install', '/passive', '/norestart') -Verb RunAs -Wait -PassThru
  return $process.ExitCode
}

function Ensure-DesktopRuntime {
  param([string]$Arch, [string]$Minimum)
  if ($Arch -notin @('x64', 'arm64') -or $Minimum -notmatch '^10\.0\.\d+$') { throw 'Unsupported runtime prerequisite' }
  $minimumParsed = [version]$Minimum
  if (Test-DesktopRuntimeInstalled $Arch $minimumParsed) { return 0 }
  $temporary = Join-Path ([IO.Path]::GetTempPath()) ('job-tracker-dotnet-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $temporary | Out-Null
  try {
    $metadataFile = Join-Path $temporary 'releases.json'
    Save-OfficialDownload ([uri]'https://builds.dotnet.microsoft.com/dotnet/release-metadata/10.0/releases.json') $metadataFile (16MB)
    $metadata = Get-Content -LiteralPath $metadataFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $installer = Select-DesktopRuntimeInstaller $metadata $Arch $minimumParsed
    $file = Join-Path $temporary $installer.Filename
    Save-OfficialDownload $installer.Url $file (160MB)
    Assert-MicrosoftInstaller $file $installer.Hash
    $exitCode = Start-DesktopRuntimeInstaller $file
    if ($exitCode -notin @(0, 3010, 1641)) { throw "Runtime installer failed or was cancelled ($exitCode)" }
    if (!(Test-DesktopRuntimeInstalled $Arch $minimumParsed)) { throw 'Desktop Runtime was not detected after installation' }
    if ($exitCode -in @(3010, 1641)) { return 3010 }
    return 0
  } finally {
    Remove-Item -LiteralPath $temporary -Recurse -Force -ErrorAction SilentlyContinue
  }
}

# Dot-sourcing exposes functions for tests without touching the machine or network.
if ($MyInvocation.InvocationName -ne '.') {
  try {
    $code = Ensure-DesktopRuntime $Architecture $MinimumVersion
    if ($ResultFile) { [IO.File]::WriteAllText($ResultFile, '') }
    exit $code
  } catch {
    if ($ResultFile) {
      [IO.File]::WriteAllText($ResultFile, $_.Exception.Message, (New-Object Text.UTF8Encoding($false)))
    }
    Write-Error $_ -ErrorAction Continue
    exit 1
  }
}

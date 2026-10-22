param(
  [Parameter(Mandatory=$true)][string]$File,
  [Parameter(Mandatory=$true)][ValidatePattern('^[A-Fa-f0-9]{40}$')][string]$Thumbprint,
  [Parameter(Mandatory=$true)][uri]$TimestampUrl,
  [switch]$Execute
)
$ErrorActionPreference = 'Stop'
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$Resolved = (Resolve-Path $File).Path
if (-not $Resolved.StartsWith((Join-Path $RepoRoot 'dist') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Sign only artifacts inside dist' }
if ([IO.Path]::GetExtension($Resolved) -notin @('.exe','.dll')) { throw 'Only executable files can be signed' }
if ($Resolved -match '[\\/]node_modules[\\/]@github[\\/]copilot-sdk-win32-(x64|arm64)[\\/]') { throw 'Preserve the separately licensed Copilot CLI vendor signature; do not re-sign it' }
if ($Resolved -match '[\\/]app[\\/]runtime[\\/]node\.exe$') { throw 'Preserve the official Node vendor binary and its pinned integrity' }
if ($TimestampUrl.Scheme -ne 'https' -or $TimestampUrl.UserInfo -or $TimestampUrl.Fragment) { throw 'Use an explicit HTTPS RFC3161 timestamp server' }
if (-not $Execute) { Write-Output "Dry run: Authenticode SHA-256 signing and RFC3161 timestamp for $Resolved. No certificate access performed."; exit 0 }
$Tool = Get-Command signtool.exe -ErrorAction Stop
& $Tool.Source sign /sha1 $Thumbprint /fd SHA256 /tr $TimestampUrl.AbsoluteUri /td SHA256 $Resolved
if ($LASTEXITCODE -ne 0) { throw 'Signing failed' }
& $Tool.Source verify /pa /all $Resolved
if ($LASTEXITCODE -ne 0) { throw 'Signature verification failed' }
$Signature = Get-AuthenticodeSignature $Resolved
if ($Signature.Status -ne 'Valid' -or $Signature.SignerCertificate.Thumbprint -ne $Thumbprint) { throw 'Publisher signature mismatch' }
Write-Output 'Signature verified. Rebuild archives and checksum manifest after signing; nothing was published.'

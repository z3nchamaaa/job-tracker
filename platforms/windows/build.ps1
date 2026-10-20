param(
  [ValidateSet("win-x64", "win-arm64")]
  [string]$Runtime = "win-x64"
)

$ErrorActionPreference = "Stop"
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$OutDir = Join-Path $RepoRoot "dist\$Runtime"

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
dotnet restore (Join-Path $PSScriptRoot "JobTracker.WebView.csproj") -r $Runtime --source https://api.nuget.org/v3/index.json
if ($LASTEXITCODE -ne 0) { throw "Dependency restore failed" }
dotnet list (Join-Path $PSScriptRoot "JobTracker.WebView.csproj") package --vulnerable --include-transitive
if ($LASTEXITCODE -ne 0) { throw "Dependency audit failed" }
dotnet publish (Join-Path $PSScriptRoot "JobTracker.WebView.csproj") `
  -c Release `
  -r $Runtime `
  --self-contained false `
  --no-restore `
  -o $OutDir

if ($LASTEXITCODE -ne 0) { throw "Windows publish failed" }

$AppDest = Join-Path $OutDir "app"
New-Item -ItemType Directory -Force -Path $AppDest | Out-Null
node (Join-Path $RepoRoot "scripts\stage.cjs") $AppDest windows
if ($LASTEXITCODE -ne 0) { throw "Runtime staging failed" }

Compress-Archive -Path "$OutDir\*" -DestinationPath (Join-Path $RepoRoot "dist\JobTracker-$Runtime-portable.zip") -Force

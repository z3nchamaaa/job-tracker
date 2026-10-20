param(
  [ValidateSet("win-x64", "win-arm64")]
  [string]$Runtime = "win-x64",
  [switch]$BuildInstaller
)

$ErrorActionPreference = "Stop"
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$OutDir = Join-Path $RepoRoot "dist\$Runtime"
$Version = (Get-Content (Join-Path $RepoRoot "package.json") -Raw | ConvertFrom-Json).version
$Arch = $Runtime.Split('-')[-1]
$NamesScript = Join-Path $RepoRoot "src\backend\artifact-names.cjs"

if (Test-Path $OutDir) { Remove-Item -Recurse -Force $OutDir }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
dotnet restore (Join-Path $PSScriptRoot "JobTracker.WebView.csproj") --locked-mode --source https://api.nuget.org/v3/index.json
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
node (Join-Path $RepoRoot "scripts\stage.cjs") $AppDest windows ($Runtime.Split('-')[-1])
if ($LASTEXITCODE -ne 0) { throw "Runtime staging failed" }

$ZipName = node $NamesScript $Version win32 $Arch zip
if ($LASTEXITCODE -ne 0) { throw "Invalid artifact version or architecture" }
# Archive outside its input directory, then move into the release directory.
$TemporaryZip = Join-Path $RepoRoot "dist\$ZipName"
Compress-Archive -Path "$OutDir\*" -DestinationPath $TemporaryZip -Force
Move-Item $TemporaryZip (Join-Path $OutDir $ZipName) -Force
if ($BuildInstaller) {
  $Compiler = Get-Command ISCC.exe -ErrorAction Stop
  & $Compiler.Source "/DMyAppVersion=$Version" "/DTargetArch=$Arch" "/DSourceDir=$OutDir" "/DOutputDir=$OutDir" (Join-Path $PSScriptRoot "installer.iss")
  if ($LASTEXITCODE -ne 0) { throw "Installer build failed" }
}
Push-Location $RepoRoot
try {
  node -e "require('./scripts/sbom.cjs').platformSbom(process.argv[1],process.argv[2],'win32',process.argv[3])" $AppDest $OutDir $Arch
  if ($LASTEXITCODE -ne 0) { throw "SBOM generation failed" }
  node (Join-Path $RepoRoot "scripts\release-manifest.cjs") $OutDir
  if ($LASTEXITCODE -ne 0) { throw "Manifest generation failed" }
} finally { Pop-Location }

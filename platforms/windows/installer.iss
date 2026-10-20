#define MyAppName "就活トラッカー"
#ifndef MyAppVersion
  #error MyAppVersion must be supplied by build.ps1
#endif
#ifndef SourceDir
  #error SourceDir must be supplied by build.ps1
#endif
#ifndef OutputDir
  #error OutputDir must be supplied by build.ps1
#endif
#ifndef TargetArch
  #error TargetArch must be supplied by build.ps1
#endif
#define MyAppId "{{8A24A8F0-4E7D-4B5F-9B61-2E68F3C92D10}"

[Setup]
AppId={#MyAppId}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
DefaultDirName={localappdata}\Programs\JobTracker
DefaultGroupName={#MyAppName}
SetupIconFile=..\..\assets\icons\app-icon.ico
PrivilegesRequired=lowest
Compression=lzma2
SolidCompression=yes
OutputDir={#OutputDir}
OutputBaseFilename=job-tracker-{#MyAppVersion}-win-{#TargetArch}
#if TargetArch == "arm64"
ArchitecturesAllowed=arm64
ArchitecturesInstallIn64BitMode=arm64
#else
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
#endif

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Excludes: "*.zip,*.cdx.json,job-tracker-*-win-*.exe,SHA256SUMS,release-manifest.json"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\{#MyAppName}"; Filename: "{app}\JobTrackerHost.exe"

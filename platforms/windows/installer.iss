#define MyAppName "就活トラッカー"
#define MyAppVersion "2.0.0"
#define MyAppId "{{8A24A8F0-4E7D-4B5F-9B61-2E68F3C92D10}"

[Setup]
AppId={#MyAppId}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
DefaultDirName={autopf}\JobTracker
DefaultGroupName={#MyAppName}
SetupIconFile=..\..\assets\icons\app-icon.ico
PrivilegesRequired=lowest
Compression=lzma2
SolidCompression=yes
OutputBaseFilename=JobTracker-Setup-{#MyAppVersion}

[Files]
Source: "..\..\dist\win\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\{#MyAppName}"; Filename: "{app}\JobTrackerHost.exe"

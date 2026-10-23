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
#ifndef MinimumDotNetVersion
  #error MinimumDotNetVersion must be supplied by build.ps1
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
MinVersion=10.0.19041

#if TargetArch == "arm64"
ArchitecturesAllowed=arm64
ArchitecturesInstallIn64BitMode=arm64
#else
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
#endif

[Languages]
Name: "japanese"; MessagesFile: "compiler:Languages\Japanese.isl"

[Files]
; Extract this prerequisite helper before application files are installed.
Source: "ensure-desktop-runtime.ps1"; Flags: dontcopy noencryption
Source: "{#SourceDir}\*"; DestDir: "{app}"; Excludes: "*.zip,*.cdx.json,job-tracker-*-win-*.exe,SHA256SUMS,release-manifest.json"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\{#MyAppName}"; Filename: "{app}\JobTrackerHost.exe"

[Code]
var
  RuntimeReady: Boolean;
  RuntimeNeedsRestart: Boolean;

function UpdateReadyMemo(Space, NewLine, MemoUserInfoInfo, MemoDirInfo,
  MemoTypeInfo, MemoComponentsInfo, MemoGroupInfo, MemoTasksInfo: String): String;
begin
  Result := MemoDirInfo + NewLine + NewLine + MemoGroupInfo + NewLine + NewLine +
    '.NET Desktop Runtime が未導入の場合は、Microsoft公式から対応する最新版を取得してインストールします。' + NewLine +
    'その際はインターネット接続と、Windowsの管理者権限の確認が必要です。';
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ExitCode: Integer;
  Parameters: String;
  Detail: AnsiString;
begin
  Result := '';
  if RuntimeReady then Exit;
  WizardForm.StatusLabel.Caption := '.NET Desktop Runtime を確認・準備しています...';
  ExtractTemporaryFile('ensure-desktop-runtime.ps1');
  Parameters := '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' +
    ExpandConstant('{tmp}\ensure-desktop-runtime.ps1') + '" -Architecture {#TargetArch}' +
    ' -MinimumVersion {#MinimumDotNetVersion} -ResultFile "' + ExpandConstant('{tmp}\dotnet-result.txt') + '"';
  if not Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
    Parameters, '', SW_HIDE, ewWaitUntilTerminated, ExitCode) then begin
    Result := '.NET Desktop Runtime の確認を開始できませんでした。セットアップをもう一度実行してください。';
    Exit;
  end;
  if (ExitCode <> 0) and (ExitCode <> 3010) then begin
    Result := '.NET Desktop Runtime を準備できませんでした。ネット接続を確認し、管理者権限の確認とインストールを完了してから再試行してください。';
    if LoadStringFromFile(ExpandConstant('{tmp}\dotnet-result.txt'), Detail) then
      Log('Desktop Runtime prerequisite: ' + String(Detail));
    Exit;
  end;
  RuntimeNeedsRestart := ExitCode = 3010;
  RuntimeReady := True;
end;

function NeedRestart(): Boolean;
begin
  Result := RuntimeNeedsRestart;
end;

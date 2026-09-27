; Inno Setup script for the Kestrel gateway Windows installer. Compiled by CI on windows-latest
; (Inno Setup ships preinstalled there) into KestrelGatewaySetup.exe, one per channel.
;
; Command-line defines set by .github/workflows/gateway-windows.yml:
;   AppVersion       gateway version (from VERSION)
;   CloudUrlDefault  pre-filled default for the "Cloud URL" field (optional)
;   SourceDir        the assembled bundle to embed, i.e. bundle/app
;   OutputDir        where to write KestrelGatewaySetup.exe
#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef CloudUrlDefault
  #define CloudUrlDefault ""
#endif
#ifndef SourceDir
  #define SourceDir "..\..\..\bundle\app"
#endif
#ifndef OutputDir
  #define OutputDir "."
#endif

[Setup]
AppId={{E4D1F1B0-6D2B-4C7B-9F5B-1B2C3D4E5F60}
AppName=Kestrel Gateway
AppVersion={#AppVersion}
AppPublisher=Kestrel
DefaultDirName={autopf}\Kestrel Gateway
DefaultGroupName=Kestrel Gateway
DisableProgramGroupPage=yes
DisableWelcomePage=no
PrivilegesRequired=admin
ArchitecturesInstallIn64BitMode=x64
OutputBaseFilename=KestrelGatewaySetup
OutputDir={#OutputDir}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}\app"; Flags: recursesubdirs ignoreversion
Source: "{#SourceDir}\windows\configure.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SourceDir}\windows\tray.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SourceDir}\windows\update.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SourceDir}\windows\uninstall.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SourceDir}\windows\KestrelGatewayService.exe"; DestDir: "{app}"; Flags: ignoreversion

[Code]
var
  ConnectPage: TInputQueryWizardPage;
  ModePage: TInputOptionWizardPage;

procedure InitializeWizard;
begin
  ConnectPage := CreateInputQueryPage(wpSelectTasks,
    'Connect this gateway', 'Where does it report to, and what''s its one-time token?',
    'The cloud URL is usually already correct. Get the enrolment token from the Gateways page in the ' +
    'portal (Add gateway, or a gateway''s menu) - you can leave it blank and enrol later.');
  ConnectPage.Add('Cloud URL:', False);
  ConnectPage.Add('Enrolment token (optional):', False);
  ConnectPage.Values[0] := '{#CloudUrlDefault}';

  ModePage := CreateInputOptionPage(ConnectPage.ID,
    'How should it run?', 'Choose how the gateway starts and keeps running',
    'Either way it restarts on its own if it stops, and keeps running until you stop it.',
    True, False);
  ModePage.Add('As a Windows service (starts at boot, before anyone logs in - recommended for a dedicated room PC)');
  ModePage.Add('When I log in (shows an icon in the system tray)');
  ModePage.SelectedValueIndex := 0;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if CurPageID = ConnectPage.ID then
  begin
    if Trim(ConnectPage.Values[0]) = '' then
    begin
      MsgBox('Enter the cloud URL.', mbError, MB_OK);
      Result := False;
    end
    else if (Pos('http://', ConnectPage.Values[0]) <> 1) and (Pos('https://', ConnectPage.Values[0]) <> 1) then
    begin
      MsgBox('The cloud URL must start with http:// or https://', mbError, MB_OK);
      Result := False;
    end;
  end;
end;

function GetCloudUrl(Param: string): string;
begin
  Result := ConnectPage.Values[0];
end;

function GetEnrollToken(Param: string): string;
begin
  Result := ConnectPage.Values[1];
end;

function GetMode(Param: string): string;
begin
  if ModePage.SelectedValueIndex = 0 then
    Result := 'Service'
  else
    Result := 'Tray';
end;

[Run]
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\configure.ps1"" -CloudUrl ""{code:GetCloudUrl}"" -EnrollToken ""{code:GetEnrollToken}"" -InstallDir ""{app}"" -Mode {code:GetMode}"; StatusMsg: "Setting up the gateway..."; Flags: runhidden waituntilterminated

[UninstallRun]
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\uninstall.ps1"" -NoSelfDelete"; RunOnceId: "KestrelUninstall"; Flags: runhidden waituntilterminated

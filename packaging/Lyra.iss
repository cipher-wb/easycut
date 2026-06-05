; Inno Setup 脚本：把 dist\Lyra 打成安装程序 Lyra-Setup.exe
; 编译： "C:\Users\<你>\AppData\Local\Programs\Inno Setup 6\ISCC.exe" packaging\Lyra.iss
; 说明：每用户安装（无需管理员），用户数据在 %LOCALAPPDATA%\Lyra。

#define MyAppName "Lyra"
#define MyAppNameCN "Lyra 视频剪辑"
#define MyAppVersion "1.0.0"
#define MyAppPublisher "ASTRA"
#define MyAppExeName "Lyra.exe"

[Setup]
AppId={{A3F1C2E4-5B6D-4E7F-9A1B-2C3D4E5F6A7B}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion} (ASTRA)
AppPublisher={#MyAppPublisher}
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
DisableDirPage=no
UninstallDisplayIcon={app}\{#MyAppExeName}
UninstallDisplayName={#MyAppName} (ASTRA)
OutputDir=..\dist
OutputBaseFilename=Lyra-Setup-{#MyAppVersion}
SetupIconFile=icon.ico
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
Source: "..\dist\Lyra\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{group}\Uninstall {#MyAppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchProgram,{#MyAppName}}"; Flags: nowait postinstall skipifsilent

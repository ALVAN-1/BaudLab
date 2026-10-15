; BaudLab - Inno Setup 安装包脚本
; 使用 ISCC.exe 编译生成安装包

#define MyAppName "BaudLab"
#define MyAppVersion "1.0.0"
#define MyAppPublisher "BaudLab"
#define MyAppExeName "BaudLab.exe"
#define MyAppSourceDir "dist\win-unpacked"
#define MyAppIcon "assets\app.ico"

[Setup]
AppId={{B8F3A2E1-1234-5678-9ABC-DEF012345678}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
OutputDir=installer_output
OutputBaseFilename=BaudLab-Setup-{#MyAppVersion}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=admin
SetupIconFile={#MyAppIcon}
UninstallDisplayIcon={app}\assets\app.ico
UninstallDisplayName={#MyAppName}

[Languages]
Name: "chinesesimp"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "附加选项:"; Flags: checkedonce

[Files]
; 打包整个 win-unpacked 目录（包含 Electron 运行时 + 项目文件 + node_modules）
Source: "{#MyAppSourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; IconFilename: "{app}\assets\app.ico"
Name: "{group}\卸载 {#MyAppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; IconFilename: "{app}\assets\app.ico"; Tasks: desktopicon

[Run]
; 安装完成后可选择启动应用
Filename: "{app}\{#MyAppExeName}"; Description: "立即启动 {#MyAppName}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; 卸载时清理数据目录（保留用户数据需注释掉此段）
; Type: filesandordirs; Name: "{app}\data"

[Code]
// 卸载前确认是否删除用户数据
function InitializeUninstall(): Boolean;
begin
  Result := True;
end;

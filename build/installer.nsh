; ============================================================
;  Serial Protocol Manager - 自定义安装向导脚本
; ============================================================

; ============================================================
;  安装前关闭正在运行的实例（避免文件锁定导致安装失败）
; ============================================================
!macro customInit
  DetailPrint "正在检查运行中的 Serial Protocol Manager..."
  nsExec::Exec 'taskkill /F /IM "Serial Protocol Manager.exe"'
  Pop $0
  ${If} $0 == 0
    DetailPrint "已关闭旧进程，等待文件句柄释放..."
    Sleep 1500
  ${EndIf}
!macroend

; ============================================================
;  卸载前关闭运行中的实例
; ============================================================
!macro customUnInstall
  nsExec::Exec 'taskkill /F /IM "Serial Protocol Manager.exe"'
  Pop $0
  ${If} $0 == 0
    Sleep 1000
  ${EndIf}
!macroend

; ============================================================
;  额外快捷方式（开始菜单卸载项）
; ============================================================
Section "AdditionalShortcuts" SEC_EXTRA
  CreateDirectory "$SMPROGRAMS\Serial Protocol Manager"
  CreateShortCut "$SMPROGRAMS\Serial Protocol Manager\卸载.lnk" "$INSTDIR\Uninstall Serial Protocol Manager.exe"
SectionEnd

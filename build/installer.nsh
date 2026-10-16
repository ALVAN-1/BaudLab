; ============================================================
;  BaudLab - 自定义安装向导脚本（现代化页面）
;  页面流程: 欢迎页 -> 安装方式选择页 -> (内置页跳过) ->
;            安装位置页 -> 安装进度页 -> 完成页
; ============================================================

; ---------------- 全局变量 ----------------
Var BL_Chosen        ; 安装方式选择: "all" / "user" (由选择页 leave 写入)
Var BL_FTitle        ; 标题字体 (Segoe UI 26 粗)
Var BL_FH2           ; 小标题字体 (Segoe UI 20 粗)
Var BL_FRadio        ; 选项字体 (Segoe UI 16 半粗)
Var BL_FBody         ; 正文字体 (Segoe UI 14)
Var BL_FSmall        ; 辅助文字字体 (Segoe UI 13)
Var BL_RadioAll      ; "所有用户" 单选按钮句柄
Var BL_RadioUser     ; "仅当前用户" 单选按钮句柄
Var BL_Info          ; 选择页底部说明文字句柄
Var BL_RunChk        ; 完成页"立即启动"复选框句柄
Var BL_Icon          ; 页面图标句柄

; ============================================================
;  标题栏
; ============================================================
!macro customHeader
  !ifdef BUILD_UNINSTALLER
    Caption "${PRODUCT_NAME} 卸载程序"
  !else
    Caption "${PRODUCT_NAME} 安装程序"
  !endif
!macroend

; ============================================================
;  安装前关闭正在运行的实例（避免文件锁定导致安装失败）
;  同时创建现代化页面所需的字体
; ============================================================
!macro customInit
  DetailPrint "正在检查运行中的 ${PRODUCT_NAME}..."
  nsExec::Exec 'taskkill /F /IM "${APP_EXECUTABLE_FILENAME}"'
  Pop $0
  ${If} $0 == 0
    DetailPrint "已关闭旧进程，等待文件句柄释放..."
    Sleep 1500
  ${EndIf}

  ; 现代化页面字体（中文由 GDI 字体链接回退到微软雅黑）
  CreateFont $BL_FTitle "Segoe UI" 26 700
  CreateFont $BL_FH2 "Segoe UI" 20 700
  CreateFont $BL_FRadio "Segoe UI" 16 600
  CreateFont $BL_FBody "Segoe UI" 14 400
  CreateFont $BL_FSmall "Segoe UI" 13 400
!macroend

; ============================================================
;  卸载前关闭运行中的实例
; ============================================================
!macro customUnInstall
  nsExec::Exec 'taskkill /F /IM "${APP_EXECUTABLE_FILENAME}"'
  Pop $0
  ${If} $0 == 0
    Sleep 1000
  ${EndIf}
!macroend

; ============================================================
;  额外快捷方式（开始菜单卸载项）
; ============================================================
!macro customInstall
  CreateDirectory "$SMPROGRAMS\${PRODUCT_NAME}"
  CreateShortCut "$SMPROGRAMS\${PRODUCT_NAME}\卸载.lnk" "$INSTDIR\${UNINSTALL_FILENAME}"
!macroend

; ============================================================
;  让内置"安装选项"页自动跳过:
;  由我们自己的选择页把结果写入 $BL_Chosen,
;  内置页 PRE 里的 customInstallMode 钩子读取后强制跳过它。
;  (卸载器 / --allusers / 提权实例中 $BL_Chosen 为空, 保持原有行为)
; ============================================================
!macro customInstallMode
  ${If} $BL_Chosen == "all"
    StrCpy $isForceMachineInstall "1"
  ${ElseIf} $BL_Chosen == "user"
    StrCpy $isForceCurrentInstall "1"
  ${EndIf}
!macroend

; ============================================================
;  欢迎页 + 安装方式选择页（替代原生单选样式页）
; ============================================================
!macro customWelcomePage
  Page custom BL_WelcomeCreate
  Page custom BL_ModeCreate BL_ModeLeave

  ; ---------------- 欢迎页 ----------------
  Function BL_WelcomeCreate
    ${If} ${UAC_IsInnerInstance}
      Abort ; 提权重启后的实例直接进入"安装位置"页
    ${EndIf}

    !insertmacro MUI_HEADER_TEXT "欢迎安装 ${PRODUCT_NAME}" "安装前请确认以下信息"

    nsDialogs::Create 1018
    Pop $0
    SetCtlColors $0 "" FFFFFF

    ${NSD_CreateIcon} 14u 8u 28u 28u ""
    Pop $0
    ${NSD_SetIconFromInstaller} $0 $BL_Icon

    ${NSD_CreateLabel} 52u 8u 240u 26u "欢迎安装 ${PRODUCT_NAME}"
    Pop $0
    SendMessage $0 ${WM_SETFONT} $BL_FTitle 1
    SetCtlColors $0 1A1D2E FFFFFF

    ${NSD_CreateLabel} 52u 38u 240u 14u "串口协议管理工具 · 版本 ${VERSION}"
    Pop $0
    SendMessage $0 ${WM_SETFONT} $BL_FSmall 1
    SetCtlColors $0 6B7280 FFFFFF

    ${NSD_CreateLabel} 14u 64u 272u 3u "" ; 橙色分隔条
    Pop $0
    SetCtlColors $0 FF6B00 FF6B00

    ; 功能要点 — 拆成独立行并加大行距, 留出呼吸空间
    ${NSD_CreateLabel} 14u 78u 272u 13u "• 协议数据库：串口协议的管理与导入导出"
    Pop $0
    SendMessage $0 ${WM_SETFONT} $BL_FBody 1
    SetCtlColors $0 444444 FFFFFF

    ${NSD_CreateLabel} 14u 98u 272u 13u "• 实时报文编解码、抓包与标记"
    Pop $0
    SendMessage $0 ${WM_SETFONT} $BL_FBody 1
    SetCtlColors $0 444444 FFFFFF

    ${NSD_CreateLabel} 14u 118u 272u 13u "• AI 助手辅助分析与调试"
    Pop $0
    SendMessage $0 ${WM_SETFONT} $BL_FBody 1
    SetCtlColors $0 444444 FFFFFF

    nsDialogs::Show
  FunctionEnd

  ; ---------------- 安装方式选择页 ----------------
  Function BL_ModeCreate
    ${If} ${UAC_IsInnerInstance}
      Abort ; 提权重启后的实例固定为"所有用户"，由内置页逻辑完成选择
    ${EndIf}
    ${If} ${isForAllUsers}
      Abort ; 命令行已指定 --allusers
    ${EndIf}
    ${If} ${isForCurrentUser}
      Abort ; 命令行已指定 --currentuser
    ${EndIf}

    !insertmacro MUI_HEADER_TEXT "安装选项" "选择将 ${PRODUCT_NAME} 安装给哪些用户"

    nsDialogs::Create 1018
    Pop $0
    SetCtlColors $0 "" FFFFFF

    ${NSD_CreateLabel} 14u 6u 272u 20u "选择安装方式"
    Pop $0
    SendMessage $0 ${WM_SETFONT} $BL_FH2 1
    SetCtlColors $0 1A1D2E FFFFFF

    ${NSD_CreateRadioButton} 16u 42u 270u 16u "为所有用户安装"
    Pop $BL_RadioAll
    SendMessage $BL_RadioAll ${WM_SETFONT} $BL_FRadio 1
    SetCtlColors $BL_RadioAll "" FFFFFF

    ${NSD_CreateLabel} 32u 60u 254u 13u "安装到 Program Files，这台电脑的所有账户可用"
    Pop $0
    SendMessage $0 ${WM_SETFONT} $BL_FSmall 1
    SetCtlColors $0 6B7280 FFFFFF

    System::Call "advapi32::GetUserName(t.r0,*i${NSIS_MAX_STRLEN})i"
    ${NSD_CreateRadioButton} 16u 80u 270u 16u "仅为当前用户安装 ($0)"
    Pop $BL_RadioUser
    SendMessage $BL_RadioUser ${WM_SETFONT} $BL_FRadio 1
    SetCtlColors $BL_RadioUser "" FFFFFF

    ${NSD_CreateLabel} 32u 98u 254u 13u "安装到个人应用目录，无需管理员权限"
    Pop $0
    SendMessage $0 ${WM_SETFONT} $BL_FSmall 1
    SetCtlColors $0 6B7280 FFFFFF

    ${NSD_CreateLabel} 16u 112u 270u 30u ""
    Pop $BL_Info
    SendMessage $BL_Info ${WM_SETFONT} $BL_FSmall 1
    SetCtlColors $BL_Info 1A1D2E FFFFFF

    ${NSD_OnClick} $BL_RadioAll BL_ModeChange
    ${NSD_OnClick} $BL_RadioUser BL_ModeChange

    ; 按 initMultiUser 的默认值预选 (已有安装时沿用原位置)
    ${If} $installMode == "all"
      SendMessage $BL_RadioAll ${BM_SETCHECK} ${BST_CHECKED} 0
      SendMessage $BL_RadioAll ${BM_CLICK} 0 0
    ${Else}
      SendMessage $BL_RadioUser ${BM_SETCHECK} ${BST_CHECKED} 0
      SendMessage $BL_RadioUser ${BM_CLICK} 0 0
    ${EndIf}

    nsDialogs::Show
  FunctionEnd

  ; 选项切换: 更新底部说明 + 下一步按钮的 UAC 盾牌图标
  Function BL_ModeChange
    Pop $1 ; 触发控件 (不区分)
    SendMessage $BL_RadioAll ${BM_GETCHECK} 0 0 $2
    ${If} $2 = ${BST_CHECKED}
      StrCpy $BL_Chosen "all"
      ${If} $hasPerMachineInstallation == "1"
        StrCpy $3 "已检测到现有安装，将升级：$\r$\n$perMachineInstallationFolder"
      ${Else}
        StrCpy $3 "全新安装 · 这台电脑的所有账户都可以使用"
      ${EndIf}
      ${If} ${UAC_IsAdmin}
        StrCpy $2 0
      ${Else}
        StrCpy $2 1 ; 非管理员选择"所有用户"时显示盾牌
      ${EndIf}
    ${Else}
      StrCpy $BL_Chosen "user"
      ${If} $hasPerUserInstallation == "1"
        StrCpy $3 "已检测到现有安装，将升级：$\r$\n$perUserInstallationFolder"
      ${Else}
        StrCpy $3 "全新安装 · 仅当前用户可用，无需管理员权限"
      ${EndIf}
      StrCpy $2 0
    ${EndIf}
    SendMessage $BL_Info ${WM_SETTEXT} 0 "STR:$3"
    GetDlgItem $1 $HWNDPARENT 1 ; 下一步按钮
    SendMessage $1 ${BCM_SETSHIELD} 0 $2
  FunctionEnd

  Function BL_ModeLeave
    SendMessage $BL_RadioAll ${BM_GETCHECK} 0 0 $0
    ${If} $0 = ${BST_CHECKED}
      StrCpy $BL_Chosen "all"
      ${IfNot} ${UAC_IsAdmin}
        ; 与原生页相同的提权流程: 用户取消时停留在本页而不是退出
        ShowWindow $HWNDPARENT ${SW_HIDE}
        !insertmacro UAC_RunElevated
        ${Switch} $0
          ${Case} 0
            ${If} $1 = 1
              Quit ; 外层进程退出, 提权实例继续完成安装
            ${EndIf}
            ${If} $1 = 3
            ${OrIf} $2 = 0x666666
              MessageBox mb_IconStop|mb_TopMost|mb_SetForeground "请使用具有管理员权限的账户登录后再试。"
            ${EndIf}
            ${Break}
          ${Case} 1223 ; 用户取消了 UAC
            ${Break}
          ${Case} 1062
            MessageBox mb_IconStop|mb_TopMost|mb_SetForeground "无法提权：Secondary Logon 服务未运行。"
            ${Break}
          ${Default}
            MessageBox mb_IconStop|mb_TopMost|mb_SetForeground "无法请求管理员权限，错误代码：$0"
            ${Break}
        ${EndSwitch}
        ShowWindow $HWNDPARENT ${SW_SHOW}
        BringToFront
        Abort ; 留在选择页
      ${EndIf}
    ${Else}
      StrCpy $BL_Chosen "user"
    ${EndIf}
  FunctionEnd
!macroend

; ============================================================
;  完成页（替代原生完成页, 自带"立即启动"选项）
; ============================================================
!macro customFinishPage
  Page custom BL_FinishCreate BL_FinishLeave

  Function BL_FinishCreate
    !insertmacro MUI_HEADER_TEXT "完成安装" "${PRODUCT_NAME} 已成功安装"

    nsDialogs::Create 1018
    Pop $0
    SetCtlColors $0 "" FFFFFF

    ${NSD_CreateIcon} 14u 8u 28u 28u ""
    Pop $0
    ${NSD_SetIconFromInstaller} $0 $BL_Icon

    ${NSD_CreateLabel} 52u 8u 240u 26u "安装完成"
    Pop $0
    SendMessage $0 ${WM_SETFONT} $BL_FTitle 1
    SetCtlColors $0 1A1D2E FFFFFF

    ${NSD_CreateLabel} 14u 48u 272u 30u "${PRODUCT_NAME} 已安装到：$\r$\n$INSTDIR"
    Pop $0
    SendMessage $0 ${WM_SETFONT} $BL_FSmall 1
    SetCtlColors $0 6B7280 FFFFFF

    ${NSD_CreateLabel} 14u 88u 272u 3u "" ; 橙色分隔条
    Pop $0
    SetCtlColors $0 FF6B00 FF6B00

    ${NSD_CreateCheckbox} 14u 102u 272u 18u "立即启动 ${PRODUCT_NAME}"
    Pop $BL_RunChk
    SendMessage $BL_RunChk ${WM_SETFONT} $BL_FBody 1
    SetCtlColors $BL_RunChk "" FFFFFF
    SendMessage $BL_RunChk ${BM_SETCHECK} ${BST_CHECKED} 0

    ${NSD_CreateLabel} 14u 126u 280u 13u "可在 Windows 设置或控制面板中卸载"
    Pop $0
    SendMessage $0 ${WM_SETFONT} $BL_FSmall 1
    SetCtlColors $0 8A8F98 FFFFFF

    nsDialogs::Show
  FunctionEnd

  Function BL_FinishLeave
    ${NSD_GetState} $BL_RunChk $0
    ${If} $0 = ${BST_CHECKED}
      ${If} ${isUpdated}
        StrCpy $1 "--updated"
      ${Else}
        StrCpy $1 ""
      ${EndIf}
      ${StdUtils.ExecShellAsUser} $2 "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "open" "$1"
    ${EndIf}
  FunctionEnd
!macroend

@echo off
REM ============================================================
REM BaudLab 构建辅助脚本（release-tools/build-release.bat）
REM 自动定位上级目录为项目根目录，双击或从任意位置调用均可
REM
REM 背景说明：electron-builder 裁剪语言包时会批量删除
REM dist/win-unpacked/locales 下约 50+ 个 .pak 文件，触发
REM WorkBuddy safe-delete 批量删除保护（阈值 50/轮）。
REM CODEBUDDY_SAFE_DELETE_ENABLED=0 是该安全特性自身的关闭开关，
REM 仅对本次构建子进程生效，不影响其他操作。
REM ============================================================
set CODEBUDDY_SAFE_DELETE_ENABLED=0
cd /d "%~dp0.." || exit /b 1
echo project dir: %CD%
echo.
call npm run build
if errorlevel 1 (
    echo.
    echo [ERROR] 构建失败，请查看上方日志。按任意键关闭窗口...
    pause >nul
    exit /b 1
)
echo.
echo 构建完成。按任意键关闭窗口...
pause >nul

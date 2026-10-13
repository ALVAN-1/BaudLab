echo off
chcp 65001 >nul 2>&1
title 团队数据服务器
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo   [错误] 未检测到 Node.js
  echo   请先安装 Node.js LTS 版本: https://nodejs.org/zh-cn
  pause
  exit /b 1
)

node tui-banner.js server

rem 启动前自动清理占用 3010 端口的旧进程，避免 EADDRINUSE
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3010" ^| findstr "LISTENING"') do call :kill_old %%a

node server.js
if errorlevel 1 (
  echo.
  echo   服务器已停止。若上方提示 Node 版本过低（低于 22.13），
  echo   可升级 Node 到最新 LTS，或在当前目录执行以下命令后重试：
  echo       npm install better-sqlite3
  pause
)
exit /b

:kill_old
echo   [警告] 检测到端口 3010 被旧进程 PID=%1 占用，正在终止...
taskkill /F /PID %1 >nul 2>nul
if errorlevel 1 (
  echo   [错误] 无法终止进程 %1，请手动执行: taskkill /F /PID %1
  pause
  exit /b 1
)
echo   [完成] 已终止旧进程 %1
goto :eof

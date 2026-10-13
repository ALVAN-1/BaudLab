@echo off
chcp 65001 >nul 2>&1
title 串口协议管理工具 - 第二实例
cd /d "%~dp0"

rem 用法：启动第二实例.bat [实例名]（默认 second）
rem 每个实例拥有独立的数据目录（Chromium 缓存 / 本地数据库 / 登录会话），
rem 可与 start.bat 启动的主实例同时运行、各登一个账号互不干扰；
rem 数据源配置（连接哪台服务器）全实例共享。
set INSTANCE=%~1
if "%INSTANCE%"=="" set INSTANCE=second

if not exist "dist\renderer\index.html" (
  echo   [错误] 尚未构建界面：请先运行一次 start.bat 完成构建，再启动第二实例。
  pause
  exit /b 1
)

echo.
echo   启动实例 [%INSTANCE%]（独立数据目录 data\instances\%INSTANCE%）
echo   关闭 Electron 窗口即停止该实例。
echo.
npx electron . --instance=%INSTANCE%
if errorlevel 1 pause

echo off
chcp 65001 >nul 2>&1
cd /d "%~dp0"

rem ── 依赖检测与自动安装 ──
rem 关键文件：vite（构建）、electron（运行时）、better-sqlite3 原生模块（数据库）
rem .deps-ready 指纹文件：完整安装链（npm install + electron-rebuild）完成后才写入。
rem 只有部分文件存在（如安装中断）同样视为未装好，会重跑完整安装链。
if exist "node_modules\.bin\vite.cmd" if exist "node_modules\electron\dist\electron.exe" if exist "node_modules\better-sqlite3\build\Release\better_sqlite3.node" if exist "node_modules\.deps-ready" goto :deps_ok

echo   [依赖] 检测到依赖未安装或不完整，开始自动安装...
echo   [依赖] 首次安装需要几分钟（下载 Electron 约 100MB 并编译原生模块），请耐心等待。
echo.
call npm install --no-audit --no-fund
if errorlevel 1 goto :fail_deps

echo.
echo   [依赖] 正在按 Electron ABI 重建原生模块（better-sqlite3）...
echo   [依赖] npm install 装的是 Node 版原生模块，在 Electron 里无法加载，此步必须执行。
echo.
call npx electron-rebuild
if errorlevel 1 goto :fail_deps

>node_modules\.deps-ready echo done
echo.
echo   [依赖] 安装完成，继续启动...
echo.

:deps_ok
node tui-banner.js start
if errorlevel 1 goto :fail
node start.js
if %errorlevel% neq 0 goto :fail
goto :eof

:fail
echo.
echo   [错误] 启动失败，请检查上方日志。
pause
goto :eof

:fail_deps
echo.
echo   [错误] 依赖安装失败，窗口保持打开以便查看上方错误信息。
echo   常见原因：网络不稳定（需从 GitHub 下载 Electron 约 100MB）。
echo   请检查网络后重试，或在本目录手动执行以下命令：
echo       npm install
echo       npx electron-rebuild
pause

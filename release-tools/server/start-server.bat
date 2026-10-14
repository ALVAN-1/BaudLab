@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22.13+ is required. Install an LTS release from nodejs.org and enable PATH.
  pause
  exit /b 1
)
node -e "const v=process.versions.node.split('.').map(Number); if(v[0]<22 || (v[0]===22 && v[1]<13)) process.exit(1); require('node:sqlite');"
if errorlevel 1 (
  echo This server requires Node.js 22.13+ with node:sqlite.
  pause
  exit /b 1
)
node server.js
if errorlevel 1 pause

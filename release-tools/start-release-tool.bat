@echo off
setlocal
cd /d "%~dp0"
where py >nul 2>nul
if not errorlevel 1 (
  py -3 -c "import sys, tkinter; assert sys.version_info >= (3,10)" >nul 2>nul
  if not errorlevel 1 (
    py -3 release_gui.py
    goto :finish
  )
)
where python >nul 2>nul
if not errorlevel 1 (
  python -c "import sys, tkinter; assert sys.version_info >= (3,10)" >nul 2>nul
  if not errorlevel 1 (
    python release_gui.py
    goto :finish
  )
)
echo Python 3.10+ with Tkinter is required. Install Python from python.org and enable PATH.
pause
exit /b 1
:finish
if errorlevel 1 pause

@echo off
setlocal
rem Pick a trustworthy interpreter. Bare `python` is not: LibreOffice and
rem other bundles put a crippled python.exe on PATH that dies with WinError 5
rem the moment it needs to spawn a child. The official `py` launcher is the
rem reliable entry point on Windows; bare `python` is only a last resort.
set "PY="
py -3 -c "import sys; assert sys.version_info >= (3, 10)" >nul 2>nul
if not errorlevel 1 set "PY=py -3"
if not defined PY (
  python -c "import sys; assert sys.version_info >= (3, 10)" >nul 2>nul
  if not errorlevel 1 set "PY=python"
)
if not defined PY (
  echo Python 3.10+ is required to install this plugin.
  echo Install it from https://www.python.org/downloads/ and re-run.
  exit /b 1
)
%PY% "%~dp0install.py" %*
if errorlevel 1 (
  echo.
  echo Installation failed. See the messages above.
  exit /b 1
)
echo.
echo Done. Restart Codex or open a new task to pick up the plugin.
endlocal

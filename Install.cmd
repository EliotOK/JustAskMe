@echo off
setlocal
where python >nul 2>nul
if errorlevel 1 (
  echo Python 3.10+ is required to install this plugin.
  echo Install it from https://www.python.org/downloads/ and re-run.
  exit /b 1
)
python "%~dp0install.py" %*
if errorlevel 1 (
  echo.
  echo Installation failed. See the messages above.
  exit /b 1
)
echo.
echo Done. Restart Codex or open a new task to pick up the plugin.
endlocal

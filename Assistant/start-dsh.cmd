@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-dsh.ps1" %*
set CODE=%ERRORLEVEL%
if not "%CODE%"=="0" (
  echo.
  echo [start-dsh] exited with code %CODE%
  pause
)
exit /b %CODE%

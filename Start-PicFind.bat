@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-picfind.ps1" %*
set "PICFIND_EXIT=%ERRORLEVEL%"
if not "%PICFIND_EXIT%"=="0" pause
exit /b %PICFIND_EXIT%

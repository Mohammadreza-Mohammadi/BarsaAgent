@echo off
rem shim ِ cmd: barsa <فرمان> ← node server\src\remote-cli.js (BARSA_APP_DIR، یا کنار همین فایل، یا D:\BarsaAgent)
setlocal
if defined BARSA_APP_DIR (
  set "APP=%BARSA_APP_DIR%"
) else if exist "%~dp0..\server\src\remote-cli.js" (
  set "APP=%~dp0.."
) else (
  set "APP=D:\BarsaAgent"
)
node "%APP%\server\src\remote-cli.js" %*
exit /b %ERRORLEVEL%

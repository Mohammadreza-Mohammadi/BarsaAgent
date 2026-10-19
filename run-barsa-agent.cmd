@echo off
setlocal

set "PROJECT_DIR=%~dp0"
set "CLIENT_URL=http://localhost:4400/"

if not exist "%PROJECT_DIR%package.json" goto missing_project
where npm.cmd >nul 2>&1
if errorlevel 1 goto missing_npm
if not exist "%PROJECT_DIR%node_modules\.bin\ng.cmd" goto missing_dependencies

start "BarsaAgent Server" /D "%PROJECT_DIR%" cmd /k "npm run dev:server"
if errorlevel 1 goto start_failed
start "BarsaAgent Client" /D "%PROJECT_DIR%" cmd /k "npm run dev:client"
if errorlevel 1 goto start_failed

echo Waiting for the client at %CLIENT_URL% ...
powershell.exe -NoProfile -Command "$url='%CLIENT_URL%'; $deadline=(Get-Date).AddSeconds(120); while ((Get-Date) -lt $deadline) { try { $response=Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 2; if ($response.StatusCode -eq 200) { exit 0 } } catch {} ; Start-Sleep -Seconds 1 }; exit 1"
if errorlevel 1 goto client_timeout

start "" "%CLIENT_URL%"
exit /b 0

:missing_project
echo Project files were not found next to this launcher.
goto failed

:missing_npm
echo npm was not found. Install Node.js and try again.
goto failed

:missing_dependencies
echo Dependencies are missing. Run npm ci in the project folder first.
goto failed

:start_failed
echo A server window could not be started.
goto failed

:client_timeout
echo The client did not become ready within 120 seconds. Check the server and client windows for errors.

:failed
pause
exit /b 1

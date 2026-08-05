@echo off
rem Launcher to start Antigravity with a CDP debugging port
rem Automatically detects and uses an available port
rem Plain setlocal: delayed expansion would corrupt %LOCALAPPDATA% paths
rem containing '!' during the parse phase, and no !var! expansion is used here.
setlocal

set PORTS=9222 9333 9444 9555 9666
set SELECTED_PORT=

for %%p in (%PORTS%) do (
    netstat -ano | find "LISTENING" | find ":%%p " >nul
    if errorlevel 1 (
        set SELECTED_PORT=%%p
        goto :found
    )
)

:notfound
echo [ERROR] No available ports were found (%PORTS%)
echo    Please stop any process using one of these ports.
pause
exit /b 1

:found
echo [INFO] Starting Antigravity on port %SELECTED_PORT%...
rem Antigravity v2 installs as "Antigravity IDE\Antigravity IDE.exe"; v1 as "Antigravity\Antigravity.exe".
rem First existing wins, v2 before v1. The empty "" is start's window title and
rem must be kept in every branch, otherwise the quoted path is parsed as a title.
if exist "%LOCALAPPDATA%\Programs\Antigravity IDE\Antigravity IDE.exe" (
    start "" "%LOCALAPPDATA%\Programs\Antigravity IDE\Antigravity IDE.exe" --remote-debugging-port=%SELECTED_PORT%
) else if exist "%LOCALAPPDATA%\Programs\Antigravity\Antigravity.exe" (
    start "" "%LOCALAPPDATA%\Programs\Antigravity\Antigravity.exe" --remote-debugging-port=%SELECTED_PORT%
) else (
    rem Not in the standard install folders - fall back to PATH lookup.
    where "Antigravity IDE.exe" >nul 2>&1
    if errorlevel 1 (
        start "" "Antigravity.exe" --remote-debugging-port=%SELECTED_PORT%
    ) else (
        start "" "Antigravity IDE.exe" --remote-debugging-port=%SELECTED_PORT%
    )
)
echo [OK] Launch complete! CDP port: %SELECTED_PORT%
timeout /t 2 >nul
exit /b 0

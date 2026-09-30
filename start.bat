@echo off
setlocal EnableExtensions

title SignBridge - AI Sign Language Platform
color 0B
cd /d "%~dp0"

echo.
echo ==========================================
echo   SignBridge - AI Sign Language Platform
echo ==========================================
echo.

if not exist "requirements.txt" (
    echo [ERROR] requirements.txt was not found.
    pause
    exit /b 1
)

if not exist "backend\server.py" (
    echo [ERROR] backend\server.py was not found.
    pause
    exit /b 1
)

python -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)" >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Python 3.10 or newer is required.
    echo Install Python and enable "Add Python to PATH".
    pause
    exit /b 1
)

set "VENV_DIR=%~dp0.venv"
set "VENV_PYTHON=%VENV_DIR%\Scripts\python.exe"
set "DEPS_MARKER=%VENV_DIR%\.requirements.sha256"

if not exist "%VENV_PYTHON%" (
    echo [1/4] Creating local Python environment...
    python -m venv "%VENV_DIR%"
    if errorlevel 1 (
        echo [ERROR] Could not create the virtual environment.
        pause
        exit /b 1
    )
)

set "REQUIREMENTS_HASH="
for /f %%H in ('powershell -NoProfile -Command "(Get-FileHash -Algorithm SHA256 -LiteralPath 'requirements.txt').Hash"') do set "REQUIREMENTS_HASH=%%H"
if not defined REQUIREMENTS_HASH (
    echo [ERROR] Could not calculate the dependency file checksum.
    pause
    exit /b 1
)
set "INSTALLED_HASH="
if exist "%DEPS_MARKER%" set /p INSTALLED_HASH=<"%DEPS_MARKER%"

if /I "%REQUIREMENTS_HASH%" NEQ "%INSTALLED_HASH%" (
    echo [2/4] Installing or updating dependencies...
    "%VENV_PYTHON%" -m pip install --disable-pip-version-check --upgrade pip
    "%VENV_PYTHON%" -m pip install --disable-pip-version-check -r requirements.txt
    if errorlevel 1 (
        echo.
        echo [ERROR] Dependency installation failed.
        echo Close other Python applications and run start.bat again.
        pause
        exit /b 1
    )
    echo %REQUIREMENTS_HASH%>"%DEPS_MARKER%"
) else (
    echo [2/4] Dependencies are already installed.
)

echo [3/4] Checking the hand-landmark model...
"%VENV_PYTHON%" -m backend.download_models
if errorlevel 1 (
    echo [WARNING] The model could not be downloaded. The server will use its OpenCV fallback.
)

set "PORT="
for /f %%P in ('powershell -NoProfile -Command "$port = 8000; try { $requested = [int]$env:SIGNBRIDGE_PORT; if ($requested -ge 1 -and $requested -le 65535) { $port = $requested } } catch {}; while ($port -le 65535 -and (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)) { $port++ }; if ($port -gt 65535) { exit 1 }; Write-Output $port"') do set "PORT=%%P"
if not defined PORT (
    echo [ERROR] Could not find a free TCP port.
    pause
    exit /b 1
)
if not defined SIGNBRIDGE_CORS_ORIGINS set "SIGNBRIDGE_CORS_ORIGINS=http://localhost:%PORT%,http://127.0.0.1:%PORT%"

echo.
echo [4/4] Starting SignBridge server...
echo.
echo   Server: http://localhost:%PORT%
echo   Docs:   http://localhost:%PORT%/docs
echo.
echo   Press Ctrl+C to stop the server.
echo.

if /I not "%SIGNBRIDGE_NO_BROWSER%"=="1" (
    if /I not "%SIGNBRIDGE_NO_BROWSER%"=="true" (
        start "" /B powershell -NoProfile -WindowStyle Hidden -Command "$url = 'http://localhost:%PORT%'; $deadline = (Get-Date).AddSeconds(30); do { try { if ((Invoke-WebRequest -UseBasicParsing -Uri ($url + '/health') -TimeoutSec 2).StatusCode -eq 200) { Start-Process $url; exit } } catch {}; Start-Sleep -Milliseconds 500 } while ((Get-Date) -lt $deadline); Start-Process $url"
    )
)

if /I "%SIGNBRIDGE_ENV%"=="production" (
    "%VENV_PYTHON%" -m uvicorn backend.server:app --host 0.0.0.0 --port %PORT% --proxy-headers
) else (
    "%VENV_PYTHON%" -m uvicorn backend.server:app --host 0.0.0.0 --port %PORT% --reload
)

echo.
echo SignBridge server stopped.
pause
endlocal

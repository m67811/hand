@echo off
title SignBridge — AI Sign Language Platform
color 0B
cls

echo.
echo  ==========================================
echo      _____  _            ____       _     _
echo     / ____|(_)          |  _ \     (_)   | |
echo    ^| (___   _  __ _ _ __ ^| |_) |_ __ _  __| | __ _  ___
echo     \___ \ ^| ^|/ _` ^| '_ \^|  _ /^| '__^| ^|/ _` ^|/ _` ^|/ _ \
echo     ____) ^|^| ^| (_^| ^| ^| ^| ^| ^|_) ^|^| ^|  ^| ^| (_^| ^| (_^| ^|  __/
echo    ^|_____/ ^|_^\__,_^|_^| ^|_^|____/ ^|_^|  ^|_^\__,_^\__, ^|^\___^|
echo                                              __/ ^|
echo                                             ^|___/
echo  ==========================================
echo  AI Sign Language Translation Platform v1.0
echo  ==========================================
echo.

REM Check Python
python --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Python not found! Please install Python 3.10+
    pause
    exit /b 1
)

echo [1/3] Checking dependencies...
pip install -r requirements.txt -q --exists-action i

echo [2/3] Starting SignBridge server...
echo.
echo  Server: http://localhost:8000
echo  Docs:   http://localhost:8000/docs
echo.
echo  Opening browser in 3 seconds...
echo  Press Ctrl+C to stop the server
echo.

REM Open browser after 3 second delay (in background)
start /B cmd /C "timeout /t 3 >nul && start http://localhost:8000"

REM Start the FastAPI server
cd backend
python -m uvicorn server:app --host 0.0.0.0 --port 8000 --reload

pause

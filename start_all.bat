@echo off
title Project Catalogue Launcher
cd /d "%~dp0"

echo.
echo   ^<^> PROJECT CATALOGUE - starting backend and frontend
echo.

if not exist "backend\.env" (
    echo [ERROR] backend\.env not found. Copy backend\.env.example to backend\.env and add your keys.
    pause
    exit /b 1
)

rem --- Do not accidentally open another app already using the API port ---
netstat -ano | findstr /R /C:":8000 .*LISTENING" >nul
if not errorlevel 1 (
    echo [ERROR] Port 8000 is already in use. Another backend may be running there.
    echo Close that server and run this launcher again so this project uses its own API.
    pause
    exit /b 1
)

rem --- Find an available frontend port instead of showing another app on :5500 ---
set "FRONTEND_PORT=5500"
:find_frontend_port
netstat -ano | findstr /R /C:":%FRONTEND_PORT% .*LISTENING" >nul
if not errorlevel 1 (
    set /a FRONTEND_PORT+=1
    goto find_frontend_port
)

rem --- First run: create the virtual environment and install dependencies ---
if not exist "backend\venv\Scripts\python.exe" (
    echo Creating virtual environment...
    python -m venv backend\venv
    if errorlevel 1 (
        echo [ERROR] Could not create the virtual environment. Is Python installed and on PATH?
        pause
        exit /b 1
    )
    echo Installing dependencies...
    backend\venv\Scripts\python.exe -m pip install -r backend\requirements.txt
    if errorlevel 1 (
        echo [ERROR] Dependency installation failed.
        pause
        exit /b 1
    )
)

rem --- Backend: FastAPI on http://localhost:8000 ---
start "Project Catalogue - Backend (FastAPI :8000)" /D "%~dp0backend" cmd /k "set FRONTEND_ORIGINS=http://localhost:%FRONTEND_PORT%&& venv\Scripts\python.exe -m uvicorn app:app --reload --port 8000"

rem --- Frontend: static server on the selected available port ---
start "Project Catalogue - Frontend (:%FRONTEND_PORT%)" /D "%~dp0frontend" cmd /k ""%~dp0backend\venv\Scripts\python.exe" -m http.server %FRONTEND_PORT%"

rem --- Give the servers a moment, then open the app ---
ping -n 5 127.0.0.1 >nul
start "" http://localhost:%FRONTEND_PORT%

echo   Backend : http://localhost:8000   (API docs: http://localhost:8000/docs)
echo   Frontend: http://localhost:%FRONTEND_PORT%
echo.
echo   Close the two server windows to stop the app.
echo.
pause

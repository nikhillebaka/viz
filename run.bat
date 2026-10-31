@echo off
rem ==============================================================================
rem Launch FluSight Sandbox Forecast Visualizer & Evaluation Suite (Windows)
rem ==============================================================================

setlocal enabledelayedexpansion

set "DIR=%~dp0"
set "ROOT_DIR=%DIR%.."

rem Locate Python executable
if defined VIRTUAL_ENV if exist "%VIRTUAL_ENV%\Scripts\python.exe" (
    set "PYTHON_BIN=%VIRTUAL_ENV%\Scripts\python.exe"
    goto :found_python
)
if exist "%ROOT_DIR%\.venv\Scripts\python.exe" (
    set "PYTHON_BIN=%ROOT_DIR%\.venv\Scripts\python.exe"
    goto :found_python
)
if exist "%ROOT_DIR%\venv\Scripts\python.exe" (
    set "PYTHON_BIN=%ROOT_DIR%\venv\Scripts\python.exe"
    goto :found_python
)
if exist "%ROOT_DIR%\env\Scripts\python.exe" (
    set "PYTHON_BIN=%ROOT_DIR%\env\Scripts\python.exe"
    goto :found_python
)

rem Check if python or py is on PATH
where python >nul 2>nul
if %errorlevel% equ 0 (
    set "PYTHON_BIN=python"
    goto :found_python
)

where py >nul 2>nul
if %errorlevel% equ 0 (
    set "PYTHON_BIN=py"
    goto :found_python
)

echo ERROR: Could not locate Python. Please install Python or activate your virtual environment.
exit /b 1

:found_python
set "PORT=%~1"
if "%PORT%"=="" set "PORT=8501"

set "HOST=%~2"
if "%HOST%"=="" set "HOST=127.0.0.1"

echo Starting Sandbox Visualization Server on http://%HOST%:%PORT%...
"%PYTHON_BIN%" "%DIR%server.py" --port %PORT% --host %HOST%

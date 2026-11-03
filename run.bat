@echo off
rem ==============================================================================
rem Launch the FluSight Sandbox dashboard (Windows).
rem   Usage: viz\run.bat [PORT] [HOST]   (defaults: 8501 127.0.0.1)
rem Run viz\setup.bat once first.
rem ==============================================================================

setlocal enabledelayedexpansion

set "DIR=%~dp0"
set "ROOT_DIR=%DIR%.."

rem Locate a Python that has the viz dependencies installed
if defined VIRTUAL_ENV if exist "%VIRTUAL_ENV%\Scripts\python.exe" (
    set "PYTHON_BIN=%VIRTUAL_ENV%\Scripts\python.exe"
    goto :found_python
)
if exist "%DIR%.venv\Scripts\python.exe" (
    set "PYTHON_BIN=%DIR%.venv\Scripts\python.exe"
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

echo ERROR: Could not locate Python. Run viz\setup.bat first.
exit /b 1

:found_python
"%PYTHON_BIN%" -c "import polars, pyarrow, yaml" >nul 2>nul
if errorlevel 1 (
    echo ERROR: viz dependencies are not installed for %PYTHON_BIN%.
    echo Run viz\setup.bat first ^(or: pip install -r viz\requirements.txt^).
    exit /b 1
)

set "PORT=%~1"
if "%PORT%"=="" set "PORT=8501"

set "HOST=%~2"
if "%HOST%"=="" set "HOST=127.0.0.1"

echo Starting viz on port %PORT% ^(the server prints its URL once it is listening^)...
"%PYTHON_BIN%" "%DIR%server.py" --port %PORT% --host %HOST%

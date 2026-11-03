@echo off
rem ==============================================================================
rem One-time setup for viz (Windows). Run from anywhere:  viz\setup.bat
rem   1. Creates viz\.venv (skipped if a virtual environment is already active)
rem   2. Installs the Python dependencies
rem   3. Builds the surveillance data (NHSN admissions, as-of snapshots)
rem   4. Hides viz/ from the hub's git status via .git\info\exclude
rem Safe to re-run.
rem ==============================================================================

setlocal enabledelayedexpansion

set "DIR=%~dp0"
set "DIR=%DIR:~0,-1%"
for %%I in ("%DIR%") do set "DIRNAME=%%~nxI"
for %%I in ("%DIR%\..") do set "ROOT_DIR=%%~fI"

if /I not "%DIRNAME%"=="viz" (
    echo ERROR: this folder must be named 'viz' ^(it is '%DIRNAME%'^).
    echo Clone it with:  git clone https://github.com/nikhillebaka/viz.git viz
    exit /b 1
)

if not exist "%ROOT_DIR%\model-output" if not exist "%ROOT_DIR%\target-data" (
    echo WARNING: %ROOT_DIR% does not look like a Hubverse hub ^(no model-output\ or target-data\^).
    echo          viz reads forecasts from the folder that contains it.
)

rem 1. Python environment
if defined VIRTUAL_ENV if exist "%VIRTUAL_ENV%\Scripts\python.exe" (
    set "PYTHON_BIN=%VIRTUAL_ENV%\Scripts\python.exe"
    echo ==^> Using active virtual environment: %VIRTUAL_ENV%
    goto :have_python
)
if not exist "%DIR%\.venv\Scripts\python.exe" (
    set "BASE_PY="
    where py >nul 2>nul && set "BASE_PY=py -3"
    if not defined BASE_PY where python >nul 2>nul && set "BASE_PY=python"
    if not defined BASE_PY (
        echo ERROR: Python not found. Install Python 3.10 or newer from python.org.
        exit /b 1
    )
    echo ==^> Creating virtual environment in viz\.venv
    !BASE_PY! -m venv "%DIR%\.venv" || exit /b 1
)
set "PYTHON_BIN=%DIR%\.venv\Scripts\python.exe"

:have_python
"%PYTHON_BIN%" -c "import sys; sys.exit(sys.version_info < (3, 10))"
if errorlevel 1 (
    echo ERROR: Python 3.10 or newer is required.
    exit /b 1
)

rem 2. Dependencies
echo ==^> Installing dependencies
"%PYTHON_BIN%" -m pip install --quiet --upgrade pip
"%PYTHON_BIN%" -m pip install --quiet -r "%DIR%\requirements.txt" || exit /b 1

rem 3. Surveillance data
echo ==^> Building surveillance data ^(falls back to local target-data\ if offline^)
"%PYTHON_BIN%" "%DIR%\rebuild_surveillance.py" --force
if errorlevel 1 echo WARNING: surveillance rebuild failed; the dashboard still runs without those streams.

rem 4. Keep viz/ out of the hub's git status
if exist "%ROOT_DIR%\.git\info" (
    findstr /x /c:"viz/" "%ROOT_DIR%\.git\info\exclude" >nul 2>nul
    if errorlevel 1 (
        echo viz/>> "%ROOT_DIR%\.git\info\exclude"
        echo ==^> Added viz/ to .git\info\exclude
    )
)

echo.
echo Setup complete. Start the dashboard with:  viz\run.bat

@echo off
rem ==============================================================================
rem One-time setup for viz (Windows). Run from anywhere:  viz\setup.bat
rem   1. Creates viz\.venv (skipped if a virtual environment is already active)
rem   2. Installs the Python dependencies
rem   3. Builds the surveillance data (NHSN admissions, as-of snapshots)
rem   4. Creates the hub's local-output\ folder for uncommitted model runs
rem   5. Hides viz/ and local-output/ from the hub's git status via .git\info\exclude
rem Safe to re-run. Stops if the parent folder isn't a hub (override with --force).
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

rem viz reads hub data from its parent folder, so it must be cloned directly inside the hub.
rem Pass --force to skip this check (e.g. for a hub whose model-output\ doesn't exist yet).
if /I "%~1"=="--force" goto :hub_ok
if exist "%ROOT_DIR%\model-output" goto :hub_ok
if exist "%ROOT_DIR%\target-data" goto :hub_ok
echo ERROR: viz must be inside a Hubverse hub, but %ROOT_DIR%
echo        has no model-output\ or target-data\ folder.
set "HUB_COUNT=0"
for /d %%H in ("%ROOT_DIR%\*") do (
    if /I not "%%~fH"=="%DIR%" (
        set "IS_HUB="
        if exist "%%~fH\model-output" set "IS_HUB=1"
        if exist "%%~fH\target-data" set "IS_HUB=1"
        if defined IS_HUB (
            set /a HUB_COUNT+=1
            if !HUB_COUNT!==1 (
                echo.
                echo Found a hub next to it. Move viz into it ^(pick one if several are listed^), then re-run setup:
            )
            echo   move "%DIR%" "%%~fH\viz"
        )
    )
)
if %HUB_COUNT%==0 (
    echo.
    echo Clone it from inside your hub instead:
    echo   cd path\to\your-hub
    echo   git clone https://github.com/nikhillebaka/viz.git viz
)
echo.
echo ^(To set up here anyway, run: "%DIR%\setup.bat" --force^)
exit /b 1

:hub_ok

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

rem 4. Staging folder for uncommitted model runs (shown as [LOCAL] in the dashboard)
if not exist "%ROOT_DIR%\local-output" (
    mkdir "%ROOT_DIR%\local-output"
    echo ==^> Created local-output\ ^(put uncommitted runs in local-output\^<model_id^>\^)
)

rem 5. Keep viz/ and local-output/ out of the hub's git status
if exist "%ROOT_DIR%\.git\info" (
    for %%E in (viz/ local-output/) do (
        findstr /x /c:"%%E" "%ROOT_DIR%\.git\info\exclude" >nul 2>nul
        if errorlevel 1 (
            echo %%E>> "%ROOT_DIR%\.git\info\exclude"
            echo ==^> Added %%E to .git\info\exclude
        )
    )
)

echo.
echo Setup complete. Start the dashboard with:  viz\run.bat

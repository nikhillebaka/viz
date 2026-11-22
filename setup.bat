@echo off
rem ==============================================================================
rem One-time setup for viz (Windows). Works standalone or inside a Hubverse hub.
rem   1. Creates .venv inside this checkout (skipped if VIRTUAL_ENV is active)
rem   2. Installs Python dependencies from requirements.txt
rem   3. When inside a Hubverse hub, builds surveillance data, creates
rem      local-output\, and updates .git\info\exclude
rem ==============================================================================

setlocal enabledelayedexpansion

set "DIR=%~dp0"
set "DIR=%DIR:~0,-1%"
for %%I in ("%DIR%") do set "DIRNAME=%%~nxI"
for %%I in ("%DIR%\..") do set "ROOT_DIR=%%~fI"

set "IS_HUB="
if exist "%ROOT_DIR%\hub-config\tasks.json" set "IS_HUB=1"
if exist "%ROOT_DIR%\model-output" set "IS_HUB=1"
if exist "%ROOT_DIR%\target-data" set "IS_HUB=1"

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
    echo ==^> Creating virtual environment in %DIR%\.venv
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

echo.
if defined IS_HUB (
    rem 3. Surveillance data (inside enclosing hub)
    echo ==^> Enclosing Hubverse hub detected: %ROOT_DIR%
    echo ==^> Building surveillance data ^(falls back to local target-data\ if offline^)
    "%PYTHON_BIN%" "%DIR%\rebuild_surveillance.py" --hub "%ROOT_DIR%" --force
    if errorlevel 1 echo WARNING: surveillance rebuild failed; the dashboard still runs without those streams.

    rem 4. Staging folder for uncommitted model runs ^(shown as [LOCAL] in the dashboard^)
    if not exist "%ROOT_DIR%\local-output" (
        mkdir "%ROOT_DIR%\local-output"
        echo ==^> Created local-output\ ^(put uncommitted runs in local-output\^<model_id^>\^)
    )

    rem 5. Keep this tool folder and local-output\ out of the hub's git status
    if exist "%ROOT_DIR%\.git\info" (
        for %%E in ("%DIRNAME%/" "local-output/") do (
            findstr /x /c:%%E "%ROOT_DIR%\.git\info\exclude" >nul 2>nul
            if errorlevel 1 (
                echo %%~E>> "%ROOT_DIR%\.git\info\exclude"
                echo ==^> Added %%~E to .git\info\exclude
            )
        )
    )

    echo.
    echo Setup complete. Start the dashboard with:  "%DIR%\run.bat"
) else (
    echo Setup complete ^(standalone mode^).
    echo Start the dashboard, then connect a local Hubverse folder or sync a public hub ^(FluSight, MetroCast, ...^) in the UI:
    echo   "%DIR%\run.bat"
    echo Or launch directly against a local hub folder:
    echo   "%DIR%\run.bat" --hub C:\path\to\your-hub
)

@echo off
rem ==============================================================================
rem Launch the viz Hubverse dashboard (Windows).
rem   Usage:
rem     run.bat [PORT] [HOST] [EXTRA_FLAGS...]   (defaults: 8501 127.0.0.1)
rem     run.bat --hub C:\path\to\hub --port 8600
rem Run setup.bat once first.
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

echo ERROR: Could not locate Python. Run setup.bat first.
exit /b 1

:found_python
"%PYTHON_BIN%" -c "import polars, pyarrow, numpy" >nul 2>nul
if errorlevel 1 (
    echo ERROR: viz dependencies are not installed for %PYTHON_BIN%.
    echo Run setup.bat first ^(or: pip install -r "%DIR%requirements.txt"^).
    exit /b 1
)

set "FIRST=%~1"
if not defined FIRST (
    echo Starting viz on port 8501 ^(the server prints its URL once it is listening^)...
    "%PYTHON_BIN%" "%DIR%server.py" --port 8501 --host 127.0.0.1
    exit /b !errorlevel!
)
if "!FIRST:~0,1!"=="-" (
    echo Starting viz ^(the server prints its URL once it is listening^)...
    "%PYTHON_BIN%" "%DIR%server.py" %*
    exit /b !errorlevel!
)

set "PORT=%~1"
shift
set "HOST=127.0.0.1"
set "EXTRA_ARGS="
set "SECOND=%~1"
if defined SECOND if not "!SECOND:~0,1!"=="-" (
    set "HOST=%~1"
    shift
)
:collect_extra
if "%~1"=="" goto :run_positional
set "EXTRA_ARGS=!EXTRA_ARGS! "%~1""
shift
goto :collect_extra

:run_positional
echo Starting viz on port %PORT% ^(the server prints its URL once it is listening^)...
"%PYTHON_BIN%" "%DIR%server.py" --port %PORT% --host %HOST% !EXTRA_ARGS!

@echo off
REM Bootstrap the trajectory-viz module: create .venv-viz, install Python and npm deps.
REM Run once from any directory — script changes to its own location.
setlocal

cd /d "%~dp0"

echo =^> Creating Python virtual environment (.venv-viz)...
python -m venv .venv-viz
if errorlevel 1 (
    echo [ERROR] python -m venv failed. Ensure Python 3.11 is on PATH.
    exit /b 1
)

echo =^> Installing project (editable mode)...
.venv-viz\Scripts\python.exe -m pip install -e .
if errorlevel 1 (
    echo [ERROR] pip install failed. If pip is broken from a partial upgrade, run:
    echo   .venv-viz\Scripts\python.exe -m ensurepip --upgrade
    exit /b 1
)

echo =^> Installing frontend npm dependencies...
cd frontend
npm install
if errorlevel 1 (
    echo [ERROR] npm install failed. Ensure Node 20+ is on PATH.
    exit /b 1
)
cd ..

REM Sprint B2: ensure data\ exists (mount target for docker-compose.yml)
if not exist "data" (
    echo =^> Creating data\ directory (docker-compose mount target)...
    mkdir data
    echo Docker compose mounts ./data for uploads (demo DB is baked in the image). > data\.gitkeep
)

echo.
echo Bootstrap complete.
echo.
echo Default path is demo/universal (no PFLOW_HOME required):
echo   .venv-viz\Scripts\trajectory-viz-demo.exe --serve
echo   rem or: .venv-viz\Scripts\trajectory-viz-ingest.exe --reset
echo   rem     .venv-viz\Scripts\trajectory-viz-serve.exe
echo.
echo Opt-in PFLOW lab profile:
echo   set TRAJECTORY_VIZ_PROFILE=pflow
echo   set PFLOW_HOME=C:\path\to\PFLOW
echo   .venv-viz\Scripts\trajectory-viz-ingest.exe --profile pflow --reset
echo.
echo Standalone DB:
echo   set TRAJECTORY_VIZ_DB=C:\path\to\viz.duckdb
echo   .venv-viz\Scripts\trajectory-viz-serve.exe
echo.
echo Start the frontend (from trajectory-viz\frontend\):
echo   npm run dev

endlocal

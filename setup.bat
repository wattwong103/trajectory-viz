@echo off
REM Bootstrap the viz module: create .venv-viz, install Python and npm deps.
REM Run once from any directory — script changes to its own location.
setlocal

cd /d "%~dp0"

echo =^> Creating Python virtual environment (.venv-viz)...
python -m venv .venv-viz
if errorlevel 1 (
    echo [ERROR] python -m venv failed. Ensure Python 3.11 is on PATH.
    exit /b 1
)

echo =^> Installing Python dependencies...
.venv-viz\Scripts\python.exe -m pip install --upgrade pip
.venv-viz\Scripts\python.exe -m pip install fastapi uvicorn duckdb scikit-learn pydantic
if errorlevel 1 (
    echo [ERROR] pip install failed.
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

echo.
echo Bootstrap complete.
echo.
echo Start the backend (monorepo mode):
echo   .venv-viz\Scripts\python.exe -m uvicorn viz.backend.app:app --host 127.0.0.1 --port 9999
echo.
echo Start the backend (standalone mode):
echo   set PFLOW_VIZ_DB=C:\path\to\pflow.duckdb
echo   .venv-viz\Scripts\python.exe -m uvicorn viz.backend.app:app --host 127.0.0.1 --port 9999
echo.
echo Start the frontend (from viz\frontend\):
echo   npm run dev

endlocal

@echo off
REM ============================================================
REM  start-gufm-viz.bat -- launch trajectory-viz on the GUFM vs
REM  PFLOW ground-truth fleets (400 heldout ward-13101 persons).
REM
REM  Isolation: uses ONLY env vars + our own files. The repo's
REM  sources.yaml and pflow.duckdb are never touched.
REM
REM  Fleets:   gufm  = GUFM c100 checkpoint, greedy decode
REM            pflow = PFLOW ground truth, same 400 person_ids
REM  Data:     data\gufm\  (converter: gufm repo,
REM            scripts\data_prep\viz_export_gufm_fleets.py)
REM
REM  Re-ingest after re-running the converter:
REM    .venv-viz\Scripts\python.exe -m backend.ingest --reset
REM    (from the repo root, with the three env vars below set)
REM ============================================================

set PFLOW_VIZ_SOURCES=H:\Dropbox\PFLOW\trajectory-viz\sources.gufm.yaml
set PFLOW_VIZ_DB=H:\Dropbox\PFLOW\trajectory-viz\data\gufm\gufm.duckdb
set PFLOW_VIZ_OUTPUT_ROOT=H:\Dropbox\PFLOW\trajectory-viz\data\gufm\output

cd /d H:\Dropbox\PFLOW\trajectory-viz\frontend
echo.
echo  Dashboard:  http://localhost:5173
echo  API docs:   http://127.0.0.1:9999/docs
echo  (Ctrl+C stops both the API and the dev server)
echo.
npm run dev

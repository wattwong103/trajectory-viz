"""
FastAPI application — PFLOW Trajectory Visualization & Mining API.

Serves trip and trajectory data from DuckDB to the React/DeckGL frontend.
Run with: uvicorn backend.app:app --host 0.0.0.0 --port 9999 --reload
"""

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .routers import stats, trips, trajectories
from .analysis import temporal, od_flows, spatial, clustering, trip_chains

app = FastAPI(
    title="PFLOW Viz API",
    description="Trajectory visualization and mining for Pseudo-PFLOW truck/taxi simulations",
    version="0.1.0",
)

# Allow frontend dev server (Vite default: 5173) and any localhost
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:3000", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(stats.router, prefix="/api", tags=["stats"])
app.include_router(trips.router, prefix="/api", tags=["trips"])
app.include_router(trajectories.router, prefix="/api", tags=["trajectories"])

# Phase 2: Analysis
app.include_router(temporal.router, prefix="/api", tags=["analysis"])
app.include_router(od_flows.router, prefix="/api", tags=["analysis"])
app.include_router(spatial.router, prefix="/api", tags=["analysis"])

# Phase 3: Mining
app.include_router(clustering.router, prefix="/api", tags=["mining"])
app.include_router(trip_chains.router, prefix="/api", tags=["mining"])


@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    """Return JSON error instead of 500 HTML for all unhandled exceptions."""
    print(f"[ERROR] {request.url}: {exc}")
    return JSONResponse(
        status_code=500,
        content={"error": str(exc), "detail": "Query failed — database may be empty or locked"},
    )


@app.get("/")
async def root():
    return {
        "name": "PFLOW Viz API",
        "docs": "/docs",
        "stats": "/api/stats",
    }


def serve():
    """Entry point for `trajectory-viz-serve`.

    Reads host/port from env (default 127.0.0.1:9999). Use `--reload` via uvicorn
    directly for dev; this wrapper is the production-style single-command start.
    """
    import os
    import uvicorn

    host = os.environ.get("TRAJECTORY_VIZ_HOST", "127.0.0.1")
    port = int(os.environ.get("TRAJECTORY_VIZ_PORT", "9999"))
    uvicorn.run("backend.app:app", host=host, port=port, reload=False)

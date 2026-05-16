"""
FastAPI application — PFLOW Trajectory Visualization & Mining API.

Serves trip and trajectory data from DuckDB to the React/DeckGL frontend.
Run with: uvicorn backend.app:app --host 0.0.0.0 --port 9999 --reload

In Docker (Phase 3 Step 3.1), the built React app is served at / via
StaticFiles. In native dev, the Vite dev server on :5173 is primary and the
StaticFiles mount is skipped because frontend/dist/ doesn't exist yet.
"""

from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from .routers import stats, trips, trajectories
from .analysis import temporal, od_flows, spatial, clustering, trip_chains

app = FastAPI(
    title="trajectory-viz API",
    description="Interactive visualization for agent-based mobility model outputs (v0.2)",
    version="0.2.0a1",
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


# Conditional StaticFiles mount — only when the built frontend exists.
# In Docker, the Dockerfile builds the frontend into <project>/frontend/dist/
# and FastAPI serves it at /. In native dev, this directory is absent and
# the mount is a no-op; the root JSON endpoint below handles GET /.
_FRONTEND_DIST = Path(__file__).resolve().parent.parent / "frontend" / "dist"
_STATIC_MOUNTED = _FRONTEND_DIST.is_dir() and (_FRONTEND_DIST / "index.html").is_file()
if _STATIC_MOUNTED:
    # `html=True` makes any unmatched route fall through to index.html so React
    # Router (or hash routing) works. Mounting LAST means /api/* routes win.
    app.mount(
        "/",
        StaticFiles(directory=str(_FRONTEND_DIST), html=True),
        name="frontend",
    )
else:
    @app.get("/")
    async def root():
        return {
            "name": "trajectory-viz API",
            "version": "0.2.0a1",
            "docs": "/docs",
            "stats": "/api/stats",
            "note": (
                "Frontend dist/ not bundled. Run the Vite dev server on :5173 "
                "(or build with `npm run build` to embed)."
            ),
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

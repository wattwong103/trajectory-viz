# trajectory-viz Dockerfile — multi-stage build.
#
# Stage 1 (node:20-alpine): build the Vite frontend → static dist/ output.
# Stage 2 (python:3.11-slim): install backend, copy demo sources, bake
#   demo/demo.duckdb, copy built dist/, serve API + UI on port 8080.
#
# First run: `docker compose up --build` → http://localhost:8080 (map + demo).
# No pre-built host DuckDB required. Override TRAJECTORY_VIZ_DB / set
# TRAJECTORY_VIZ_SEED_DEMO=0 for a custom or intentionally empty DB.
#
# Why single-port + single-container in Docker but dual-process in native dev:
#   - In native dev: Vite HMR is valuable; two processes is fine.
#   - In Docker: reviewers expect one `docker run`; serving dist/ via FastAPI's
#     StaticFiles is the cleanest deploy topology.
# The StaticFiles mount in backend/app.py is conditional on the dist/ directory
# existing, so this Dockerfile and the native setup.{sh,bat} flow coexist.

# ============================================================================
# Stage 1: Frontend build
# ============================================================================
FROM node:20-alpine AS frontend-build

WORKDIR /app/frontend

# Layer-cache deps separately from source — avoids `npm ci` on every code change.
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY frontend/ ./
RUN npm run build && ls -la dist/

# ============================================================================
# Stage 2: Backend runtime + bundled frontend + baked demo DB
# ============================================================================
FROM python:3.11-slim AS runtime

# System deps. python:3.11-slim is the smallest reasonable image (~125 MB);
# we add only what FastAPI/DuckDB/scikit-learn need at runtime.
RUN apt-get update && apt-get install -y --no-install-recommends \
        curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python deps first (layer-cache). pyproject declares `readme = "README.md"`,
# so hatchling needs the file present to build the editable metadata.
COPY pyproject.toml README.md ./
COPY backend/__init__.py ./backend/__init__.py
RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir -e .

# Now copy the rest of the source.
COPY backend/ ./backend/
# Full demo tree (GPX/GeoJSON/CSV + registry) — needed to bake/seed demo.duckdb.
COPY demo/ ./demo/
COPY profiles/ ./profiles/
COPY scripts/docker-entrypoint.sh ./scripts/docker-entrypoint.sh
RUN chmod +x ./scripts/docker-entrypoint.sh
COPY LICENSE ./LICENSE

# Copy the built frontend from stage 1 into the location app.py mounts.
COPY --from=frontend-build /app/frontend/dist ./frontend/dist

# Bake the demo DuckDB into the image so first `compose up` has trips without
# a host-side ingest. Runtime entrypoint re-seeds only if the target DB is
# missing/empty (e.g. empty volume mount) unless TRAJECTORY_VIZ_SEED_DEMO=0.
ENV TRAJECTORY_VIZ_DB=/app/demo/demo.duckdb \
    PFLOW_VIZ_DB=/app/demo/demo.duckdb \
    TRAJECTORY_VIZ_SOURCES=/app/demo/sources.demo.yaml \
    PFLOW_VIZ_SOURCES=/app/demo/sources.demo.yaml \
    TRAJECTORY_VIZ_OUTPUT_ROOT=/app/demo \
    PFLOW_VIZ_OUTPUT_ROOT=/app/demo \
    TRAJECTORY_VIZ_PROFILE=demo \
    TRAJECTORY_VIZ_SEED_DEMO=1 \
    TRAJECTORY_VIZ_HOST=0.0.0.0 \
    TRAJECTORY_VIZ_PORT=8080

RUN trajectory-viz-demo --db-path /app/demo/demo.duckdb \
    && python -c "import duckdb; c=duckdb.connect('/app/demo/demo.duckdb', read_only=True); n=c.execute('SELECT COUNT(*) FROM trips').fetchone()[0]; assert n>0, n; print(f'baked demo trips={n}')"

EXPOSE 8080

# Health endpoint is /api/stats; the wrapper script handles graceful shutdown.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD curl -sf http://127.0.0.1:8080/api/stats || exit 1

ENTRYPOINT ["/app/scripts/docker-entrypoint.sh"]
# Use the pip-installed entry point so PYTHONPATH/working-dir match the wheel.
CMD ["trajectory-viz-serve"]

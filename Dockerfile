# trajectory-viz Dockerfile — multi-stage build.
#
# Stage 1 (node:20-alpine): build the Vite frontend → static dist/ output.
# Stage 2 (python:3.11-slim): install backend, copy in built dist/, serve both
#   API and static assets from one uvicorn process on port 8080.
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
# Stage 2: Backend runtime + bundled frontend
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
COPY sources.yaml ./sources.yaml
COPY LICENSE ./LICENSE

# Copy the built frontend from stage 1 into the location app.py mounts.
COPY --from=frontend-build /app/frontend/dist ./frontend/dist

# Standalone mode by default: serve from a pre-built DuckDB mounted at this path.
# Override with -e PFLOW_VIZ_DB=/data/your.duckdb or set PFLOW_HOME for monorepo.
ENV PFLOW_VIZ_DB=/data/pflow.duckdb \
    TRAJECTORY_VIZ_HOST=0.0.0.0 \
    TRAJECTORY_VIZ_PORT=8080

EXPOSE 8080

# Health endpoint is /api/stats; the wrapper script handles graceful shutdown.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -sf http://127.0.0.1:8080/api/stats || exit 1

# Use the pip-installed entry point so PYTHONPATH/working-dir match the wheel.
CMD ["trajectory-viz-serve"]

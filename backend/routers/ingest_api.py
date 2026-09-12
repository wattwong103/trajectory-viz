"""Upload-and-go ingest API (upload-and-go change).

POST /api/ingest/upload  — multipart upload of one or more trajectory files.
    Files are staged to <db dir>/uploads/, sniffed, validated, and ingested
    into the current DB as a background job. Source configs are auto-generated
    and persisted to sources.uploads.yaml next to the DB (the user's
    hand-written sources.yaml is never mutated).
GET  /api/ingest/jobs/{job_id} — job status/progress/result/error.
GET  /api/ingest/jobs — last 20 jobs, newest first.

Job orchestration mirrors backend.ingest.main(): waypoints ingest → epoch
anchor resolution → synthesize_trips → compute_derived_metrics →
build_density_hourly → uploads-registry write.
"""

from __future__ import annotations

import json
import re
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, File, HTTPException, UploadFile

from ..config import uploads_dir, uploads_registry_path
from ..db import get_connection, get_epoch_anchor
from ..ingest import (
    build_density_hourly,
    compute_derived_metrics,
    ensure_epoch_anchor,
    ingest_source_trajectories,
    synthesize_trips,
)
from ..sources_schema import TimeConfig
from ..upload_config import (
    UploadConfigError,
    census_geojson_geometry,
    generate_source_config,
    load_uploads_registry_ids,
    slugify_source_id,
    sniff_columns,
    write_uploads_registry,
)

router = APIRouter()

MAX_UPLOAD_BYTES = 200 * 1024 * 1024  # 200 MB per file (proposal's sane cap)
_CHUNK = 1024 * 1024

_ALLOWED_EXTENSIONS = {
    ".csv": "csv",
    ".txt": "csv",  # common CSV alias
    ".geojson": "geojson",
    ".gpx": "gpx",
    ".ndjson": "ndjson",
    ".jsonl": "ndjson",
    ".parquet": "parquet",
    ".pq": "parquet",
    # ".json" is content-sniffed (geojson vs ndjson)
}

_GEOJSON_HEAD_RE = re.compile(r'^\s*\{\s*"type"\s*:')

# One upload job at a time — ingest is a bulk, DB-wide operation.
_executor = ThreadPoolExecutor(max_workers=1)
_JOBS: dict[str, dict] = {}
# Tests flip this to run jobs synchronously inside the request.
_RUN_JOBS_INLINE = False


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


def _new_job() -> dict:
    job_id = uuid.uuid4().hex[:12]
    job = {
        "job_id": job_id,
        "status": "queued",  # queued | running | done | error
        "progress": None,
        "result": None,
        "error": None,
        "created_at": _now_iso(),
    }
    _JOBS[job_id] = job
    return job


def _set_progress(job: dict, phase: str, **extra) -> None:
    job["progress"] = {"phase": phase, **extra}


async def _save_upload(uf: UploadFile, dest: Path) -> int:
    """Stream an upload to disk with the size cap enforced mid-flight."""
    total = 0
    try:
        with open(dest, "wb") as fh:
            while chunk := await uf.read(_CHUNK):
                total += len(chunk)
                if total > MAX_UPLOAD_BYTES:
                    raise HTTPException(
                        status_code=413,
                        detail=(
                            f"{uf.filename}: file exceeds the "
                            f"{MAX_UPLOAD_BYTES // (1024 * 1024)} MB upload cap."
                        ),
                    )
                fh.write(chunk)
    except Exception:
        dest.unlink(missing_ok=True)
        raise
    return total


def _detect_upload_format(path: Path, ext: str) -> str:
    """Resolve format for a staged file. `.json` is content-sniffed."""
    if ext == ".json":
        head = path.read_bytes()[:64 * 1024].decode("utf-8", errors="replace")
        if _GEOJSON_HEAD_RE.match(head):
            return "geojson"
        for line in head.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                if isinstance(json.loads(line), dict):
                    return "ndjson"
            except json.JSONDecodeError:
                break
        raise UploadConfigError([
            "could not determine .json format — expected GeoJSON "
            '(a "type" key at the root) or NDJSON (one JSON object per line)'
        ])
    fmt = _ALLOWED_EXTENSIONS.get(ext)
    if fmt is None:  # pragma: no cover - guarded by the extension check
        raise UploadConfigError([f"unsupported file type {ext!r}"])
    return fmt


def _existing_source_ids(conn) -> set[str]:
    ids = load_uploads_registry_ids(uploads_registry_path())
    try:
        ids |= {
            r[0]
            for r in conn.execute(
                "SELECT DISTINCT source_id FROM trips WHERE source_id IS NOT NULL"
            ).fetchall()
        }
    except Exception:
        pass
    return ids


def _resolve_known_anchor(conn) -> int | None:
    """Return the DB's epoch anchor when it is already pinned, else None.

    Pinned means: viz_meta carries epoch_anchor, or the DB already has trips
    (legacy DB without viz_meta — the get_epoch_anchor fallback applies).
    A fresh DB (no viz_meta row AND no trips) returns None and the anchor is
    derived from the uploaded data after waypoint ingest.
    """
    row = conn.execute(
        "SELECT value FROM viz_meta WHERE key = 'epoch_anchor'"
    ).fetchone()
    if row is not None:
        return int(row[0])
    n_trips = conn.execute("SELECT COUNT(*) FROM trips").fetchone()[0]
    if n_trips > 0:
        return int(get_epoch_anchor(conn))
    return None


def _run_job(job_id: str, prepared: list[dict]) -> None:
    job = _JOBS[job_id]
    job["status"] = "running"
    try:
        conn = get_connection()
        anchor = _resolve_known_anchor(conn)
        fresh_db = anchor is None
        if anchor is not None:
            ensure_epoch_anchor(conn, anchor)
            anchor_iso = datetime.fromtimestamp(anchor, UTC).isoformat()
            for p in prepared:
                p["cfg"].time = TimeConfig(epoch_anchor=anchor_iso)

        # 1) Waypoint ingest (absolute ms — anchor-independent).
        total_files = len(prepared)
        for i, p in enumerate(prepared, start=1):
            _set_progress(
                job, "ingest", file=p["filename"], done_files=i - 1,
                total_files=total_files,
            )
            # Idempotent re-upload: replace this source's waypoints.
            conn.execute(
                "DELETE FROM waypoints WHERE source_id = ?", [p["source_id"]]
            )
            n = ingest_source_trajectories(
                conn, p["staged_path"], p["source_id"], p["cfg"], anchor
            )
            p["waypoints"] = n

        # 2) Deferred anchor for a fresh DB: midnight UTC of the first day.
        if fresh_db:
            min_ms = conn.execute("SELECT MIN(unix_time_ms) FROM waypoints").fetchone()[0]
            if min_ms is None:
                raise ValueError("upload produced no waypoints — nothing to anchor")
            anchor = int(min_ms // 1000)
            anchor -= anchor % 86400
            ensure_epoch_anchor(conn, anchor)
            anchor_iso = datetime.fromtimestamp(anchor, UTC).isoformat()
            for p in prepared:
                p["cfg"].time = TimeConfig(epoch_anchor=anchor_iso)

        # 3) Trip synthesis (needs the anchor for mod-86400 math).
        _set_progress(job, "synthesize", done_files=total_files, total_files=total_files)
        for p in prepared:
            p["trips"] = synthesize_trips(conn, p["cfg"], anchor)
            p["vehicles"] = conn.execute(
                "SELECT COUNT(DISTINCT vehicle_key) FROM trips WHERE source_id = ?",
                [p["source_id"]],
            ).fetchone()[0]

        # 4) Derived metrics + pulse aggregate (whole-DB passes, as in CLI).
        _set_progress(job, "derived")
        compute_derived_metrics(conn)
        _set_progress(job, "density")
        build_density_hourly(conn)

        # 5) Persist generated configs — only now that anchors are stamped.
        _set_progress(job, "registry")
        write_uploads_registry(uploads_registry_path(), [p["cfg"] for p in prepared])

        job["result"] = {
            "trips": sum(p["trips"] for p in prepared),
            "waypoints": sum(p["waypoints"] for p in prepared),
            "source_ids": [p["source_id"] for p in prepared],
            "files": [
                {
                    "filename": p["filename"],
                    "source_id": p["source_id"],
                    "label": p["cfg"].label,
                    "trips": p["trips"],
                    "waypoints": p["waypoints"],
                    "vehicles": p["vehicles"],
                }
                for p in prepared
            ],
        }
        job["status"] = "done"
        _set_progress(job, "done")
    except Exception as exc:
        job["status"] = "error"
        job["error"] = f"{type(exc).__name__}: {exc}"


@router.post("/upload", status_code=202)
async def upload(files: Annotated[list[UploadFile], File(...)]):
    """Accept one or more trajectory files and ingest them as a job."""
    if not files:
        raise HTTPException(status_code=422, detail="no files uploaded")

    staged_dir = uploads_dir()
    conn = get_connection()
    existing = _existing_source_ids(conn)

    prepared: list[dict] = []
    reasons: list[str] = []
    for uf in files:
        # Filename guard: strip any directory components from the client name.
        name = Path(uf.filename or "upload").name
        ext = Path(name).suffix.lower()
        if ext not in _ALLOWED_EXTENSIONS and ext != ".json":
            reasons.append(
                f"{name}: unsupported file type {ext!r} — accepted: "
                + ", ".join(sorted([*_ALLOWED_EXTENSIONS, ".json"]))
            )
            continue

        source_id = slugify_source_id(Path(name).stem, existing)
        staged_path = staged_dir / f"{source_id}{ext}"
        await _save_upload(uf, staged_path)  # raises 413 on size cap

        try:
            fmt = _detect_upload_format(staged_path, ext)
            sniff = None
            if fmt not in ("geojson", "gpx"):
                sniff = sniff_columns(staged_path, fmt)
            if fmt == "geojson":
                # Upfront geometry census: polygon layers must not reach the
                # background job, where one bad file would abort the whole
                # batch after earlier files already mutated the DB.
                census_geojson_geometry(staged_path)
            cfg = generate_source_config(
                source_id=source_id,
                fmt=fmt,
                staged_rel_path=f"uploads/{staged_path.name}",
                label=Path(name).stem,
                sniff=sniff,
            )
        except UploadConfigError as exc:
            reasons.extend(f"{name}: {r}" for r in exc.reasons)
            staged_path.unlink(missing_ok=True)
            continue
        except Exception as exc:
            reasons.append(f"{name}: {type(exc).__name__}: {exc}")
            staged_path.unlink(missing_ok=True)
            continue

        existing.add(source_id)
        prepared.append({
            "filename": name,
            "source_id": source_id,
            "format": fmt,
            "staged_path": staged_path,
            "cfg": cfg,
        })

    if reasons:
        for p in prepared:
            p["staged_path"].unlink(missing_ok=True)
        raise HTTPException(status_code=422, detail={"reasons": reasons})
    if not prepared:
        raise HTTPException(status_code=422, detail="no valid files uploaded")

    job = _new_job()
    if _RUN_JOBS_INLINE:
        _run_job(job["job_id"], prepared)
    else:
        _executor.submit(_run_job, job["job_id"], prepared)

    return {
        "job_id": job["job_id"],
        "status": job["status"],
        "files": [
            {"filename": p["filename"], "source_id": p["source_id"], "format": p["format"]}
            for p in prepared
        ],
    }


def _job_view(job: dict) -> dict:
    return {
        "job_id": job["job_id"],
        "status": job["status"],
        "progress": job["progress"],
        "result": job["result"],
        "error": job["error"],
        "created_at": job["created_at"],
    }


@router.get("/jobs")
async def list_jobs():
    jobs = sorted(_JOBS.values(), key=lambda j: j["created_at"], reverse=True)
    return {"jobs": [_job_view(j) for j in jobs[:20]]}


@router.get("/jobs/{job_id}")
async def job_status(job_id: str):
    job = _JOBS.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail=f"unknown job_id {job_id!r}")
    return _job_view(job)

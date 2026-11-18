"""Upload-and-go ingest API (upload-and-go change).

POST /api/ingest/upload  — multipart upload of trajectory and/or overlay files.
    Files are staged to <db dir>/uploads/, sniffed/classified, and ingested
    into the current DB as a background job. Source / POI / zone configs are
    auto-generated and persisted to sources.uploads.yaml next to the DB (the
    user's hand-written sources.yaml is never mutated).
    Optional form field ``roles`` (JSON object filename→role) selects
    trajectories | pois | zones for GeoJSON; omitted roles are auto-detected.
    When tabular sniff fails, returns 422 with ``mapping_required`` + column
    census (staged file kept) so the UI can show an interactive mapping sheet.
    Ambiguous Point GeoJSON (no role) returns ``role_choice_required``.
POST /api/ingest/upload/confirm — apply column mapping to staged tabular files
    and run the same ingest job pipeline.
POST /api/ingest/upload/confirm-overlay — apply role/label/color to staged
    GeoJSON and ingest as trajectories / pois / zones.
GET  /api/ingest/jobs/{job_id} — job status/progress/result/error.
GET  /api/ingest/jobs — last 20 jobs, newest first.

Job orchestration mirrors backend.ingest.main() for trajectories, plus
ingest_pois / ingest_zones for overlays.
"""

from __future__ import annotations

import json
import re
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from pathlib import Path
from typing import Annotated, Any, Literal

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from pydantic import BaseModel, Field

from ..config import uploads_dir, uploads_registry_path
from ..db import get_connection, get_epoch_anchor
from ..ingest import (
    build_density_hourly,
    compute_derived_metrics,
    ensure_epoch_anchor,
    ingest_pois,
    ingest_source_trajectories,
    ingest_zones,
    synthesize_trips,
)
from ..sources_schema import TimeConfig
from ..upload_config import (
    UploadConfigError,
    census_geojson_types,
    census_tabular,
    census_to_api_dict,
    generate_poi_config,
    generate_source_config,
    generate_zone_config,
    geojson_property_keys,
    load_uploads_registry_ids,
    slugify_source_id,
    sniff_failure_reasons,
    sniff_from_mapping,
    suggest_geojson_role,
    validate_geojson_role,
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
    """Ids claimed by uploads registry + already-ingested sources/overlays."""
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
    for table in ("pois", "zones"):
        try:
            ids |= {
                r[0]
                for r in conn.execute(
                    f"SELECT DISTINCT source_key FROM {table} WHERE source_key IS NOT NULL"
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
    """Run an upload job for trajectories and/or POI/zone overlays."""
    job = _JOBS[job_id]
    job["status"] = "running"
    try:
        conn = get_connection()
        traj = [p for p in prepared if p.get("kind", "trajectory") == "trajectory"]
        overlays = [p for p in prepared if p.get("kind") in ("poi", "zone")]
        total_files = len(prepared)
        done = 0

        # --- Trajectories (optional) ----------------------------------------
        if traj:
            anchor = _resolve_known_anchor(conn)
            fresh_db = anchor is None
            if anchor is not None:
                ensure_epoch_anchor(conn, anchor)
                anchor_iso = datetime.fromtimestamp(anchor, UTC).isoformat()
                for p in traj:
                    p["cfg"].time = TimeConfig(epoch_anchor=anchor_iso)

            for p in traj:
                _set_progress(
                    job, "ingest", file=p["filename"], done_files=done,
                    total_files=total_files,
                )
                conn.execute(
                    "DELETE FROM waypoints WHERE source_id = ?", [p["source_id"]]
                )
                n = ingest_source_trajectories(
                    conn, p["staged_path"], p["source_id"], p["cfg"], anchor
                )
                p["waypoints"] = n
                done += 1

            if fresh_db:
                min_ms = conn.execute(
                    "SELECT MIN(unix_time_ms) FROM waypoints"
                ).fetchone()[0]
                if min_ms is None:
                    raise ValueError("upload produced no waypoints — nothing to anchor")
                anchor = int(min_ms // 1000)
                anchor -= anchor % 86400
                ensure_epoch_anchor(conn, anchor)
                anchor_iso = datetime.fromtimestamp(anchor, UTC).isoformat()
                for p in traj:
                    p["cfg"].time = TimeConfig(epoch_anchor=anchor_iso)

            _set_progress(
                job, "synthesize", done_files=done, total_files=total_files,
            )
            for p in traj:
                p["trips"] = synthesize_trips(conn, p["cfg"], anchor)
                p["vehicles"] = conn.execute(
                    "SELECT COUNT(DISTINCT vehicle_key) FROM trips WHERE source_id = ?",
                    [p["source_id"]],
                ).fetchone()[0]

            _set_progress(job, "derived")
            compute_derived_metrics(conn)
            _set_progress(job, "density")
            build_density_hourly(conn)
        else:
            for p in traj:  # pragma: no cover
                p.setdefault("trips", 0)
                p.setdefault("waypoints", 0)
                p.setdefault("vehicles", 0)

        # --- Overlays (POIs / zones) ----------------------------------------
        for p in overlays:
            _set_progress(
                job, "ingest", file=p["filename"], done_files=done,
                total_files=total_files,
            )
            if p["kind"] == "poi":
                n = ingest_pois(conn, p["source_id"], p["cfg"], p["staged_path"])
                p["pois"] = n
                p["zones"] = 0
            else:
                n = ingest_zones(conn, p["source_id"], p["cfg"], p["staged_path"])
                p["zones"] = n
                p["pois"] = 0
            p.setdefault("trips", 0)
            p.setdefault("waypoints", 0)
            p.setdefault("vehicles", 0)
            done += 1

        for p in traj:
            p.setdefault("pois", 0)
            p.setdefault("zones", 0)

        # --- Registry -------------------------------------------------------
        _set_progress(job, "registry")
        write_uploads_registry(
            uploads_registry_path(),
            [p["cfg"] for p in traj],
            pois={p["source_id"]: p["cfg"] for p in overlays if p["kind"] == "poi"},
            zones={p["source_id"]: p["cfg"] for p in overlays if p["kind"] == "zone"},
        )

        job["result"] = {
            "trips": sum(p.get("trips", 0) for p in prepared),
            "waypoints": sum(p.get("waypoints", 0) for p in prepared),
            "pois": sum(p.get("pois", 0) for p in prepared),
            "zones": sum(p.get("zones", 0) for p in prepared),
            "source_ids": [p["source_id"] for p in prepared],
            "files": [
                {
                    "filename": p["filename"],
                    "source_id": p["source_id"],
                    "label": p["cfg"].label,
                    "role": p.get("kind", "trajectory"),
                    "trips": p.get("trips", 0),
                    "waypoints": p.get("waypoints", 0),
                    "vehicles": p.get("vehicles", 0),
                    "pois": p.get("pois", 0),
                    "zones": p.get("zones", 0),
                }
                for p in prepared
            ],
        }
        job["status"] = "done"
        _set_progress(job, "done")
    except Exception as exc:
        job["status"] = "error"
        job["error"] = f"{type(exc).__name__}: {exc}"


class ColumnMappingPayload(BaseModel):
    """Interactive column mapping for one staged tabular upload."""

    lon: str
    lat: str
    time: str
    vehicle_id: str | None = None
    agent_id: str | None = None  # alias for vehicle_id
    name: str | None = None
    mode: str | None = None
    time_kind: str | None = None
    mode_map: dict[str, str] | None = None


class ConfirmFilePayload(BaseModel):
    staged_name: str = Field(description="Basename under uploads/ (e.g. mystery.csv)")
    source_id: str | None = None
    filename: str | None = None
    mapping: ColumnMappingPayload


class ConfirmUploadPayload(BaseModel):
    files: list[ConfirmFilePayload] = Field(min_length=1)


def _start_job(prepared: list[dict]) -> dict:
    job = _new_job()
    if _RUN_JOBS_INLINE:
        _run_job(job["job_id"], prepared)
    else:
        _executor.submit(_run_job, job["job_id"], prepared)
    return {
        "job_id": job["job_id"],
        "status": job["status"],
        "files": [
            {
                "filename": p["filename"],
                "source_id": p["source_id"],
                "format": p["format"],
                "role": (
                    "pois" if p.get("kind") == "poi"
                    else "zones" if p.get("kind") == "zone"
                    else "trajectories"
                ),
            }
            for p in prepared
        ],
    }


# Point-only GeoJSON can be trajectories or pois when suggestion is ambiguous.
_TRAJECTORY_OR_POI = frozenset({"Point"})


def _parse_json_object_form(raw: str | None, field: str) -> dict:
    if not raw or not str(raw).strip():
        return {}
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise HTTPException(
            status_code=422, detail=f"{field} must be JSON object: {exc}"
        ) from exc
    if not isinstance(parsed, dict):
        raise HTTPException(status_code=422, detail=f"{field} must be a JSON object")
    return parsed


def _parse_roles_form(roles_json: str | None) -> dict[str, str]:
    raw = _parse_json_object_form(roles_json, "roles")
    return {str(k): str(v) for k, v in raw.items()}


def _parse_labels_form(labels_json: str | None) -> dict[str, str]:
    raw = _parse_json_object_form(labels_json, "labels")
    return {str(k): str(v) for k, v in raw.items()}


def _parse_colors_form(colors_json: str | None) -> dict[str, list[int]]:
    raw = _parse_json_object_form(colors_json, "colors")
    out: dict[str, list[int]] = {}
    for k, v in raw.items():
        if not isinstance(v, (list, tuple)) or len(v) != 3:
            raise HTTPException(
                status_code=422,
                detail=f"colors[{k!r}] must be an RGB triple [r,g,b]",
            )
        out[str(k)] = [int(c) for c in v]
    return out


def _prepare_geojson_item(
    *,
    name: str,
    source_id: str,
    staged_path: Path,
    role: str | None,
    label: str | None = None,
    color: list[int] | None = None,
) -> dict | tuple[str, dict]:
    """Classify a staged GeoJSON file into a prepared job item.

    Returns a prepared dict on success, or ``("role_choice", census_dict)``
    when the client must pick a role (mixed/ambiguous geometry).
    """
    types = census_geojson_types(staged_path)
    props = geojson_property_keys(staged_path)
    resolved = role or suggest_geojson_role(types, props)
    if resolved is None:
        if types <= _TRAJECTORY_OR_POI:
            options = ["trajectories", "pois"]
        elif types <= {"Polygon", "MultiPolygon"}:
            options = ["zones"]
        else:
            options = ["trajectories", "pois", "zones"]
        return ("role_choice", {
            "filename": name,
            "source_id": source_id,
            "format": "geojson",
            "staged_name": staged_path.name,
            "geometry_types": sorted(str(t) for t in types),
            "property_keys": sorted(props),
            "suggested_role": None,
            "options": options,
            "reasons": [
                "could not auto-detect overlay role — choose trajectories, "
                "pois, or zones"
            ],
        })

    validate_geojson_role(resolved, types)
    layer_label = label or Path(name).stem
    staged_rel = f"uploads/{staged_path.name}"

    if resolved == "trajectories":
        cfg = generate_source_config(
            source_id=source_id,
            fmt="geojson",
            staged_rel_path=staged_rel,
            label=layer_label,
            sniff=None,
        )
        return {
            "filename": name,
            "source_id": source_id,
            "format": "geojson",
            "staged_path": staged_path,
            "cfg": cfg,
            "kind": "trajectory",
        }

    if resolved == "pois":
        cfg = generate_poi_config(
            layer_key=source_id,
            staged_rel_path=staged_rel,
            label=layer_label,
            prop_keys=props,
            color=color,
        )
        return {
            "filename": name,
            "source_id": source_id,
            "format": "geojson",
            "staged_path": staged_path,
            "cfg": cfg,
            "kind": "poi",
        }

    cfg = generate_zone_config(
        layer_key=source_id,
        staged_rel_path=staged_rel,
        label=layer_label,
        prop_keys=props,
        color=color,
    )
    return {
        "filename": name,
        "source_id": source_id,
        "format": "geojson",
        "staged_path": staged_path,
        "cfg": cfg,
        "kind": "zone",
    }


def _resolve_staged_path(staged_name: str) -> Path:
    """Resolve a confirm staged_name under uploads_dir (no path traversal)."""
    name = Path(staged_name).name
    if name != staged_name or ".." in staged_name or "/" in staged_name or "\\" in staged_name:
        raise HTTPException(status_code=422, detail=f"invalid staged_name {staged_name!r}")
    path = uploads_dir() / name
    if not path.is_file():
        raise HTTPException(
            status_code=422,
            detail=f"staged file {name!r} not found — re-upload, then map columns",
        )
    return path


@router.post("/upload", status_code=202)
async def upload(
    files: Annotated[list[UploadFile], File(...)],
    roles: Annotated[str | None, Form()] = None,
    labels: Annotated[str | None, Form()] = None,
    colors: Annotated[str | None, Form()] = None,
):
    """Accept trajectory and/or overlay files and ingest them as a job.

    Optional form fields (JSON objects keyed by original filename):
      - ``roles`` → ``trajectories`` | ``pois`` | ``zones``
      - ``labels`` → layer label string
      - ``colors`` → RGB triple ``[r,g,b]`` (overlay roles only)

    When ``roles`` is omitted, GeoJSON roles are auto-detected
    (polygons→zones, lines→trajectories, timeless points→pois).

    Heuristic tabular happy path returns 202. Tabular sniff failure → 422
    ``mapping_required``. Ambiguous GeoJSON without a role → 422
    ``role_choice_required``.
    """
    if not files:
        raise HTTPException(status_code=422, detail="no files uploaded")

    role_by_name = _parse_roles_form(roles)
    label_by_name = _parse_labels_form(labels)
    color_by_name = _parse_colors_form(colors)
    staged_dir = uploads_dir()
    conn = get_connection()
    existing = _existing_source_ids(conn)

    prepared: list[dict] = []
    hard_reasons: list[str] = []
    mapping_files: list[dict] = []
    role_choice_files: list[dict] = []
    keep_staged: list[Path] = []

    for uf in files:
        # Filename guard: strip any directory components from the client name.
        name = Path(uf.filename or "upload").name
        ext = Path(name).suffix.lower()
        if ext not in _ALLOWED_EXTENSIONS and ext != ".json":
            hard_reasons.append(
                f"{name}: unsupported file type {ext!r} — accepted: "
                + ", ".join(sorted([*_ALLOWED_EXTENSIONS, ".json"]))
            )
            continue

        source_id = slugify_source_id(Path(name).stem, existing)
        staged_path = staged_dir / f"{source_id}{ext}"
        await _save_upload(uf, staged_path)  # raises 413 on size cap

        try:
            fmt = _detect_upload_format(staged_path, ext)
            if fmt == "geojson":
                result = _prepare_geojson_item(
                    name=name,
                    source_id=source_id,
                    staged_path=staged_path,
                    role=role_by_name.get(name),
                    label=label_by_name.get(name),
                    color=color_by_name.get(name),
                )
                if isinstance(result, tuple) and result[0] == "role_choice":
                    role_choice_files.append(result[1])
                    keep_staged.append(staged_path)
                    existing.add(source_id)
                    continue
                prepared.append(result)  # type: ignore[arg-type]
                existing.add(source_id)
                continue

            sniff = None
            if fmt == "gpx":
                pass
            else:
                census = census_tabular(staged_path, fmt)
                sniff = census.sniff
                missing = sniff_failure_reasons(sniff)
                if missing:
                    mapping_files.append(census_to_api_dict(
                        filename=name,
                        source_id=source_id,
                        fmt=fmt,
                        staged_name=staged_path.name,
                        census=census,
                    ))
                    keep_staged.append(staged_path)
                    existing.add(source_id)
                    continue

            cfg = generate_source_config(
                source_id=source_id,
                fmt=fmt,
                staged_rel_path=f"uploads/{staged_path.name}",
                label=Path(name).stem,
                sniff=sniff,
            )
        except UploadConfigError as exc:
            hard_reasons.extend(f"{name}: {r}" for r in exc.reasons)
            staged_path.unlink(missing_ok=True)
            continue
        except Exception as exc:
            hard_reasons.append(f"{name}: {type(exc).__name__}: {exc}")
            staged_path.unlink(missing_ok=True)
            continue

        existing.add(source_id)
        prepared.append({
            "filename": name,
            "source_id": source_id,
            "format": fmt,
            "staged_path": staged_path,
            "cfg": cfg,
            "kind": "trajectory",
        })

    # Prefer interactive affordances over starting a partial job.
    if role_choice_files or mapping_files:
        for p in prepared:
            p["staged_path"].unlink(missing_ok=True)
        reasons = list(hard_reasons)
        for mf in mapping_files:
            reasons.extend(f"{mf['filename']}: {r}" for r in mf["reasons"])
        for rf in role_choice_files:
            reasons.extend(f"{rf['filename']}: {r}" for r in rf["reasons"])
        detail: dict[str, Any] = {"reasons": reasons}
        if mapping_files:
            detail["mapping_required"] = True
            detail["files"] = mapping_files
        if role_choice_files:
            detail["role_choice_required"] = True
            detail["overlay_files"] = role_choice_files
        raise HTTPException(status_code=422, detail=detail)

    if hard_reasons:
        for p in prepared:
            p["staged_path"].unlink(missing_ok=True)
        for path in keep_staged:
            path.unlink(missing_ok=True)
        raise HTTPException(status_code=422, detail={"reasons": hard_reasons})
    if not prepared:
        raise HTTPException(status_code=422, detail="no valid files uploaded")

    return _start_job(prepared)


@router.post("/upload/confirm", status_code=202)
async def upload_confirm(body: ConfirmUploadPayload):
    """Apply interactive column mapping to staged tabular uploads and ingest."""
    conn = get_connection()
    existing = _existing_source_ids(conn)
    prepared: list[dict] = []
    reasons: list[str] = []

    for item in body.files:
        try:
            staged_path = _resolve_staged_path(item.staged_name)
        except HTTPException as exc:
            detail = exc.detail
            reasons.append(str(detail))
            continue

        ext = staged_path.suffix.lower()
        try:
            fmt = _detect_upload_format(staged_path, ext if ext != ".json" else ".json")
        except UploadConfigError as exc:
            reasons.extend(f"{item.staged_name}: {r}" for r in exc.reasons)
            continue

        if fmt in ("geojson", "gpx"):
            reasons.append(
                f"{item.staged_name}: column mapping applies to "
                "CSV/NDJSON/Parquet only"
            )
            continue

        mapping: dict[str, Any] = item.mapping.model_dump(exclude_none=True)
        # Prefer explicit vehicle_id; accept agent_id alias from the sheet.
        if not mapping.get("vehicle_id") and mapping.get("agent_id"):
            mapping["vehicle_id"] = mapping["agent_id"]
        mapping.pop("agent_id", None)

        try:
            sniff, mode_map = sniff_from_mapping(
                path=staged_path, fmt=fmt, mapping=mapping,
            )
            source_id = item.source_id or slugify_source_id(
                staged_path.stem, existing
            )
            # Re-slug if caller-supplied id collides with a different stem.
            if source_id in existing and source_id != staged_path.stem:
                # Same staged stem re-upload: allow replacing that source_id.
                pass
            label = Path(item.filename or staged_path.stem).stem
            cfg = generate_source_config(
                source_id=source_id,
                fmt=fmt,
                staged_rel_path=f"uploads/{staged_path.name}",
                label=label,
                sniff=sniff,
                mode_map=mode_map,
            )
        except UploadConfigError as exc:
            reasons.extend(f"{item.staged_name}: {r}" for r in exc.reasons)
            continue
        except Exception as exc:
            reasons.append(f"{item.staged_name}: {type(exc).__name__}: {exc}")
            continue

        existing.add(source_id)
        prepared.append({
            "filename": item.filename or staged_path.name,
            "source_id": source_id,
            "format": fmt,
            "staged_path": staged_path,
            "cfg": cfg,
            "kind": "trajectory",
        })

    if reasons:
        raise HTTPException(status_code=422, detail={"reasons": reasons})
    if not prepared:
        raise HTTPException(status_code=422, detail="no valid files to confirm")

    return _start_job(prepared)


class ConfirmOverlayFilePayload(BaseModel):
    staged_name: str
    source_id: str | None = None
    filename: str | None = None
    role: Literal["trajectories", "pois", "zones"]
    label: str | None = None
    color: list[int] | None = None


class ConfirmOverlayPayload(BaseModel):
    files: list[ConfirmOverlayFilePayload] = Field(min_length=1)


@router.post("/upload/confirm-overlay", status_code=202)
async def upload_confirm_overlay(body: ConfirmOverlayPayload):
    """Apply overlay role (and optional label/color) to staged GeoJSON uploads."""
    conn = get_connection()
    existing = _existing_source_ids(conn)
    prepared: list[dict] = []
    reasons: list[str] = []

    for item in body.files:
        try:
            staged_path = _resolve_staged_path(item.staged_name)
        except HTTPException as exc:
            reasons.append(str(exc.detail))
            continue

        ext = staged_path.suffix.lower()
        try:
            fmt = _detect_upload_format(staged_path, ext if ext != ".json" else ".json")
        except UploadConfigError as exc:
            reasons.extend(f"{item.staged_name}: {r}" for r in exc.reasons)
            continue
        if fmt != "geojson":
            reasons.append(
                f"{item.staged_name}: overlay confirm applies to GeoJSON only"
            )
            continue

        source_id = item.source_id or slugify_source_id(staged_path.stem, existing)
        try:
            result = _prepare_geojson_item(
                name=item.filename or staged_path.name,
                source_id=source_id,
                staged_path=staged_path,
                role=item.role,
                label=item.label,
                color=item.color,
            )
        except UploadConfigError as exc:
            reasons.extend(f"{item.staged_name}: {r}" for r in exc.reasons)
            continue
        except Exception as exc:
            reasons.append(f"{item.staged_name}: {type(exc).__name__}: {exc}")
            continue

        if isinstance(result, tuple):
            reasons.append(
                f"{item.staged_name}: role {item.role!r} still ambiguous for geometry"
            )
            continue

        existing.add(source_id)
        prepared.append(result)

    if reasons:
        raise HTTPException(status_code=422, detail={"reasons": reasons})
    if not prepared:
        raise HTTPException(status_code=422, detail="no valid overlays to confirm")

    return _start_job(prepared)


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

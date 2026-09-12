"""Upload heuristics and source-config generation (upload-and-go).

Sniffs uploaded CSV/NDJSON/Parquet files for lon/lat/time/id columns and
generates a validated ``SourceConfig`` per file — the same schema hand-written
`sources.yaml` blocks use, so the ingest pipeline runs verbatim. Generated
configs are persisted in `sources.uploads.yaml` next to the DB (never in the
user's own registry) and merged into style/POI lookups at read time.
"""

from __future__ import annotations

import csv
import io
import re
import zlib
from dataclasses import dataclass, field
from itertools import islice
from pathlib import Path

import yaml
from pydantic import ValidationError

from backend.sources_schema import SourceConfig

# ---------------------------------------------------------------------------
# Heuristic column candidates (aligned with scripts/csv_to_duckdb.py aliases)
# ---------------------------------------------------------------------------

LON_CANDIDATES = ("lon", "lng", "longitude", "x", "gps_lon")
LAT_CANDIDATES = ("lat", "latitude", "y", "gps_lat")
TIME_CANDIDATES = ("timestamp", "time", "ts", "datetime", "epoch", "created_at")
ID_CANDIDATES = (
    "vehicle_id",
    "device_id",
    "track_id",
    "agent_id",
    "objectid",
    "id",
    "mmsi",
    "trip_id",
    "entity_id",
    "vehicle",
)
NAME_CANDIDATES = ("vehicle_name", "name", "label")

# Deterministic per-source colors (first entry is the source's color).
_PALETTE = [
    (59, 130, 246),
    (16, 185, 129),
    (249, 115, 22),
    (168, 85, 247),
    (244, 63, 94),
    (20, 184, 166),
]

_EPOCH_S_RANGE = (946_684_800, 4_102_444_800)  # 2000-01-01 .. 2100-01-01
_EPOCH_MS_RANGE = (946_684_800_000, 4_102_444_800_000)
_ISO_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}")


class UploadConfigError(Exception):
    """Raised when an uploaded file cannot be turned into a source config."""

    def __init__(self, reasons: list[str]):
        self.reasons = reasons
        super().__init__("; ".join(reasons))


# Geometry types upload-and-go can ingest as trajectories. Anything else
# (Polygon/MultiPolygon/...) is rejected upfront by census_geojson_geometry
# instead of failing mid-job after earlier batch files already mutated the DB.
_TRAJECTORY_GEOM_TYPES = frozenset({"Point", "LineString"})


def census_geojson_geometry(path: Path) -> None:
    """Reject GeoJSON files upload-and-go cannot ingest — right now, at
    upload time (422 with reasons), not mid-job.

    Streams every feature's geometry type via formats.iter_geojson_features
    (ijson when available, whole-doc fallback otherwise). Raises
    UploadConfigError naming the offending types, with the zones: pointer
    for the polygon case.
    """
    from backend.formats import iter_geojson_features

    types: set[str] = set()
    for _idx, feature in iter_geojson_features(path):
        geom = feature.get("geometry") or {}
        types.add(geom.get("type"))

    bad = {t for t in types if t not in _TRAJECTORY_GEOM_TYPES}
    if not bad:
        return
    names = ", ".join(sorted(str(t) for t in bad))
    hint = (
        "declare polygon layers under `zones:` in sources.yaml instead"
        if bad & {"Polygon", "MultiPolygon"}
        else "upload-and-go ingests Point/LineString trajectory geometries only"
    )
    raise UploadConfigError(
        [f"unsupported GeoJSON geometry type(s): {names} — {hint}"]
    )


@dataclass
class ColumnSniff:
    """Sniffed column roles. Names keep the file's original casing."""

    lon: str | None = None
    lat: str | None = None
    time: str | None = None
    vehicle_id: str | None = None
    name: str | None = None
    extra: list[str] = field(default_factory=list)
    encoding: str = "utf-8"
    time_kind: str | None = None  # "iso" | "epoch_ms" | "epoch_s"


def _decode_head(path: Path, limit: int = 256 * 1024) -> tuple[str, str]:
    raw = path.read_bytes()[:limit]
    for enc in ("utf-8", "utf-8-sig", "gb18030", "latin-1"):
        try:
            return raw.decode(enc), enc
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace"), "utf-8"


def _looks_numeric(samples: list[str]) -> bool:
    vals = [s.strip() for s in samples if s.strip()]
    if not vals:
        return False
    ok = 0
    for s in vals:
        try:
            float(s)
            ok += 1
        except ValueError:
            pass
    return ok >= max(1, len(vals) // 2)


def _timestamp_kind(samples: list[str]) -> str | None:
    vals = [s.strip() for s in samples if s.strip()][:100]
    if not vals:
        return None
    if all(_ISO_DATE_RE.match(v) for v in vals):
        return "iso"
    nums: list[float] = []
    for v in vals:
        try:
            nums.append(float(v))
        except ValueError:
            return None
    lo, hi = min(nums), max(nums)
    if _EPOCH_MS_RANGE[0] <= lo and hi <= _EPOCH_MS_RANGE[1]:
        return "epoch_ms"
    if _EPOCH_S_RANGE[0] <= lo and hi <= _EPOCH_S_RANGE[1]:
        return "epoch_s"
    return None


def sniff_columns(path: Path, fmt: str) -> ColumnSniff:
    """Sniff a staged CSV/NDJSON/Parquet file for lon/lat/time/id columns.

    GeoJSON/GPX are NOT sniffed — they normalize to the canonical staging
    fields (_lon/_lat/_time_ms/_trk_name/_feature_id) at ingest. GeoJSON
    geometry compatibility is checked separately by census_geojson_geometry
    (called by the upload endpoint before accepting the file).
    """
    import json

    sniff = ColumnSniff()
    header: list[str] = []
    col_samples: dict[str, list[str]] = {}

    if fmt == "csv":
        text, enc = _decode_head(path)
        sniff.encoding = enc
        reader = csv.reader(io.StringIO(text))
        rows = [r for r in islice(reader, 201) if r]
        if not rows:
            return sniff
        header = [h.strip() for h in rows[0]]
        body = rows[1:]
        for i, h in enumerate(header):
            col_samples[h] = [r[i] for r in body if i < len(r)][:100]
    elif fmt == "ndjson":
        records: list[dict] = []
        with open(path, encoding="utf-8", errors="replace") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(rec, dict):
                    records.append(rec)
                if len(records) >= 100:
                    break
        header = sorted({k for r in records for k in r})
        for h in header:
            col_samples[h] = [
                str(r[h]) for r in records if r.get(h) is not None
            ][:100]
    elif fmt == "parquet":
        import duckdb

        con = duckdb.connect(":memory:")
        try:
            rel = con.execute(
                f"SELECT * FROM read_parquet('{path.as_posix()}') LIMIT 100"
            )
            header = [d[0] for d in rel.description]
            rows = rel.fetchall()
            for i, h in enumerate(header):
                col_samples[h] = [str(r[i]) for r in rows if r[i] is not None]
        finally:
            con.close()
    else:
        return sniff

    # Case-insensitive candidate match; the ORIGINAL name is what ColumnSpec
    # `csv:` keys and SQL quoting reference downstream.
    by_lower = {h.lower(): h for h in header}
    used: set[str] = set()
    for field_name, candidates in (
        ("lon", LON_CANDIDATES),
        ("lat", LAT_CANDIDATES),
        ("time", TIME_CANDIDATES),
        ("vehicle_id", ID_CANDIDATES),
        ("name", NAME_CANDIDATES),
    ):
        for cand in candidates:
            original = by_lower.get(cand)
            if original is not None and original not in used:
                setattr(sniff, field_name, original)
                used.add(original)
                break

    # lon/lat must look numeric; drop the match if clearly not.
    for field_name in ("lon", "lat"):
        col = getattr(sniff, field_name)
        if col and col_samples.get(col) and not _looks_numeric(col_samples[col]):
            setattr(sniff, field_name, None)
            used.discard(col)

    if sniff.time:
        sniff.time_kind = _timestamp_kind(col_samples.get(sniff.time, []))
        if sniff.time_kind is None:
            used.discard(sniff.time)
            sniff.time = None

    role_cols = {sniff.lon, sniff.lat, sniff.time, sniff.vehicle_id, sniff.name}
    role_cols.discard(None)
    sniff.extra = [h for h in header if h not in role_cols]
    return sniff


def slugify_source_id(name: str, existing: set[str] | None = None) -> str:
    """Slugify a filename stem into a source_id matching ^[a-z][a-z0-9_]*$.

    The leading-letter constraint is load-bearing: several endpoints regex-
    validate source ids that way. Numeric-leading stems get an `upload_`
    prefix; collisions get a `_2`, `_3`, ... suffix.
    """
    base = re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_") or "upload"
    if not base[0].isalpha():
        base = f"upload_{base}"
    existing = existing or set()
    candidate = base
    n = 2
    while candidate in existing:
        candidate = f"{base}_{n}"
        n += 1
    return candidate


# Derived SQL for waypoints.unix_time_ms from the sniffed time column. Values
# are absolute epoch milliseconds, so no {epoch_anchor} substitution is needed
# here — the anchor is carried on SourceConfig.time.epoch_anchor instead.
_UNIX_TIME_SQL = {
    "iso": 'CAST(epoch_ms(CAST("{col}" AS TIMESTAMPTZ)) AS BIGINT)',
    "epoch_ms": 'CAST("{col}" AS BIGINT)',
    "epoch_s": 'CAST("{col}" AS BIGINT) * 1000',
}

# Canonical staging roles for normalized formats (no sniffing required).
_STAGED_VEHICLE_ID_COL = {"gpx": "_trk_name", "geojson": "_feature_id"}


def generate_source_config(
    *,
    source_id: str,
    fmt: str,
    staged_rel_path: str,
    label: str,
    sniff: ColumnSniff | None = None,
    anchor_iso: str | None = None,
) -> SourceConfig:
    """Build (and validate) a SourceConfig for one uploaded file.

    CSV/NDJSON/Parquet require a ColumnSniff and raise UploadConfigError
    listing every unidentifiable role. GeoJSON/GPX map the canonical staging
    fields directly.
    """
    if fmt in _STAGED_VEHICLE_ID_COL:
        vehicle_id_col = _STAGED_VEHICLE_ID_COL[fmt]
        waypoints = {
            "unix_time_ms": {"csv": "_time_ms", "type": "bigint"},
            "lon": {"csv": "_lon", "type": "double"},
            "lat": {"csv": "_lat", "type": "double"},
        }
    else:
        if sniff is None:  # pragma: no cover - caller contract
            raise UploadConfigError(["internal: sniff required for csv/ndjson/parquet"])
        reasons: list[str] = []
        if not sniff.lon or not sniff.lat:
            reasons.append(
                "could not identify longitude/latitude columns "
                f"(looked for {LON_CANDIDATES} / {LAT_CANDIDATES})"
            )
        if not sniff.time:
            reasons.append(
                f"could not identify a timestamp column (looked for {TIME_CANDIDATES})"
            )
        if not sniff.vehicle_id:
            reasons.append(
                f"could not identify a vehicle/device id column (looked for {ID_CANDIDATES})"
            )
        if reasons:
            raise UploadConfigError(reasons)
        vehicle_id_col = sniff.vehicle_id
        waypoints = {
            "unix_time_ms": {"derived": _UNIX_TIME_SQL[sniff.time_kind].format(col=sniff.time)},
            "lon": {"csv": sniff.lon, "type": "double"},
            "lat": {"csv": sniff.lat, "type": "double"},
        }

    color = _PALETTE[zlib.crc32(source_id.encode("utf-8")) % len(_PALETTE)]

    try:
        return SourceConfig.model_validate({
            "label": label,
            "source_id": source_id,
            "discovery": {
                "trajectories_glob": staged_rel_path,
                "latest_only": False,
                "format": fmt,
            },
            # {source_id} is not a template placeholder — the slug is baked in
            # literally, yielding keys like "track:morning-run".
            "vehicle_key_template": f"{source_id}:{{vehicle_id}}",
            "trips_synthesis": {"strategy": "gap_split", "gap_minutes": 30},
            "render": {"mode": "trails", "color": list(color)},
            "time": {"epoch_anchor": anchor_iso} if anchor_iso else None,
            "columns": {
                "vehicle_id_col": vehicle_id_col,
                "waypoints": waypoints,
            },
        })
    except ValidationError as exc:  # pragma: no cover - defensive
        raise UploadConfigError([
            "; ".join(
                f"{'.'.join(str(p) for p in e['loc'])}: {e['msg']}" for e in exc.errors()
            )
        ]) from exc


def write_uploads_registry(registry_path: Path, configs: list[SourceConfig]) -> None:
    """Merge generated configs into the uploads registry YAML (uploads win).

    The registry is a standard SourcesFile-shaped document
    ({version: 1, sources: {...}}) so load_sources can read it directly.
    """
    data: dict = {"version": 1, "sources": {}}
    if registry_path.exists():
        loaded = yaml.safe_load(registry_path.read_text(encoding="utf-8")) or {}
        if isinstance(loaded, dict):
            data["version"] = loaded.get("version", 1)
            data["sources"] = dict(loaded.get("sources") or {})

    for cfg in configs:
        data["sources"][cfg.source_id] = cfg.model_dump(mode="json", exclude_none=True)

    registry_path.parent.mkdir(parents=True, exist_ok=True)
    registry_path.write_text(
        yaml.safe_dump(data, sort_keys=False, allow_unicode=True), encoding="utf-8"
    )


def load_uploads_registry_ids(registry_path: Path) -> set[str]:
    """Source ids already claimed by the uploads registry (for dedupe)."""
    if not registry_path.exists():
        return set()
    loaded = yaml.safe_load(registry_path.read_text(encoding="utf-8")) or {}
    if isinstance(loaded, dict):
        return set((loaded.get("sources") or {}).keys())
    return set()

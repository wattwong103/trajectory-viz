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

from backend.sources_schema import PoiConfig, SourceConfig, ZoneConfig

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
MODE_CANDIDATES = (
    "mode",
    "transport_mode",
    "travel_mode",
    "modality",
    "transportation_mode",
)

# Roles the interactive mapping sheet can assign.
MAPPING_ROLES = frozenset({
    "lon", "lat", "time", "agent_id", "name", "mode", "ignore",
})
TIME_KINDS = frozenset({"iso", "epoch_ms", "epoch_s"})

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


# Geometry allow-lists per upload role (TV-29 S2 overlays + trajectories).
_TRAJECTORY_GEOM_TYPES = frozenset({"Point", "LineString"})
_POI_GEOM_TYPES = frozenset({"Point"})
_ZONE_GEOM_TYPES = frozenset({"Polygon", "MultiPolygon"})
_OVERLAY_ROLES = frozenset({"trajectories", "pois", "zones"})

_POI_NAME_PROPS = ("name", "label", "title", "poi_name")
_POI_CATEGORY_PROPS = ("category", "type", "kind", "class")
_TIME_PROPS = ("time", "timestamp", "datetime", "coordTimes", "times")


def census_geojson_types(path: Path) -> set[str]:
    """Return the set of GeoJSON geometry types present in ``path``."""
    from backend.formats import iter_geojson_features

    types: set[str] = set()
    for _idx, feature in iter_geojson_features(path):
        geom = feature.get("geometry") or {}
        gtype = geom.get("type")
        if gtype is not None:
            types.add(gtype)
    return types


def geojson_property_keys(path: Path, limit: int = 50) -> set[str]:
    """Sample property keys from the first ``limit`` GeoJSON features."""
    from backend.formats import iter_geojson_features

    keys: set[str] = set()
    for idx, feature in iter_geojson_features(path):
        props = feature.get("properties") or {}
        if isinstance(props, dict):
            keys.update(str(k) for k in props)
        if idx + 1 >= limit:
            break
    return keys


def suggest_geojson_role(types: set[str], prop_keys: set[str] | None = None) -> str | None:
    """Heuristic role for a GeoJSON upload when the client omits ``role``.

    - Polygon/MultiPolygon only → zones
    - Any LineString → trajectories
    - Point only, no time-like props → pois
    - Point only with time-like props → trajectories (backward-compatible)
    - Mixed polygon + point/line → None (caller must ask / reject)
    """
    if not types:
        return None
    if types <= _ZONE_GEOM_TYPES:
        return "zones"
    if types & _ZONE_GEOM_TYPES and types - _ZONE_GEOM_TYPES:
        return None
    if types & {"LineString"}:
        return "trajectories"
    if types <= _POI_GEOM_TYPES:
        props = {k.lower() for k in (prop_keys or set())}
        if props & {p.lower() for p in _TIME_PROPS}:
            return "trajectories"
        return "pois"
    return None


def validate_geojson_role(role: str, types: set[str]) -> None:
    """Raise UploadConfigError when ``role`` is incompatible with geometry."""
    if role not in _OVERLAY_ROLES:
        raise UploadConfigError([
            f"unknown upload role {role!r} — expected one of "
            f"{sorted(_OVERLAY_ROLES)}"
        ])
    if not types:
        raise UploadConfigError(["GeoJSON file has no features with geometry"])
    if role == "trajectories":
        bad = types - _TRAJECTORY_GEOM_TYPES
        if bad:
            raise UploadConfigError([
                f"role=trajectories cannot ingest geometry type(s): "
                f"{', '.join(sorted(str(t) for t in bad))} — use role=zones "
                f"for Polygon/MultiPolygon or role=pois for Point overlays"
            ])
    elif role == "pois":
        if types != _POI_GEOM_TYPES and not types <= _POI_GEOM_TYPES:
            raise UploadConfigError([
                f"role=pois requires Point features only, got "
                f"{', '.join(sorted(str(t) for t in types))}"
            ])
        if not types:
            raise UploadConfigError(["role=pois requires Point features"])
    elif role == "zones":
        bad = types - _ZONE_GEOM_TYPES
        if bad or not types:
            raise UploadConfigError([
                f"role=zones requires Polygon/MultiPolygon only, got "
                f"{', '.join(sorted(str(t) for t in types)) or '(none)'}"
            ])


def census_geojson_geometry(path: Path) -> None:
    """Legacy trajectory-only guard (kept for callers/tests).

    Prefer ``census_geojson_types`` + ``validate_geojson_role`` for S2 overlays.
    Rejects non-trajectory geometries with a zones: pointer for polygons.
    """
    types = census_geojson_types(path)
    bad = {t for t in types if t not in _TRAJECTORY_GEOM_TYPES}
    if not bad:
        return
    names = ", ".join(sorted(str(t) for t in bad))
    hint = (
        "upload with role=zones (or declare under `zones:` in sources.yaml)"
        if bad & {"Polygon", "MultiPolygon"}
        else "upload-and-go trajectories accept Point/LineString only"
    )
    raise UploadConfigError(
        [f"unsupported GeoJSON geometry type(s): {names} — {hint}"]
    )


def _pick_prop(prop_keys: set[str], candidates: tuple[str, ...]) -> str | None:
    by_lower = {k.lower(): k for k in prop_keys}
    for cand in candidates:
        if cand.lower() in by_lower:
            return by_lower[cand.lower()]
    return None


def _parse_color(color: list[int] | tuple[int, ...] | None, key: str) -> list[int]:
    if color is not None:
        if len(color) != 3:
            raise UploadConfigError(["color must be an RGB triple [r,g,b]"])
        for c in color:
            if not (0 <= int(c) <= 255):
                raise UploadConfigError([f"color components must be 0-255, got {color}"])
        return [int(c) for c in color]
    return list(_PALETTE[zlib.crc32(key.encode("utf-8")) % len(_PALETTE)])


def generate_poi_config(
    *,
    layer_key: str,
    staged_rel_path: str,
    label: str,
    prop_keys: set[str] | None = None,
    color: list[int] | tuple[int, ...] | None = None,
) -> PoiConfig:
    """Build a PoiConfig for an uploaded Point GeoJSON overlay."""
    props = prop_keys or set()
    name_prop = _pick_prop(props, _POI_NAME_PROPS)
    cat_prop = _pick_prop(props, _POI_CATEGORY_PROPS)
    columns: dict = {
        "lon": {"csv": "_lon", "type": "double"},
        "lat": {"csv": "_lat", "type": "double"},
    }
    if name_prop:
        columns["name"] = {"csv": name_prop, "type": "varchar"}
    if cat_prop:
        columns["category"] = {"csv": cat_prop, "type": "varchar"}
    else:
        # Ensure category chips have something to group on when props omit it.
        columns["category"] = {"derived": "'uploaded'"}

    try:
        return PoiConfig.model_validate({
            "label": label,
            "glob": staged_rel_path,
            "format": "geojson",
            "color": _parse_color(color, layer_key),
            "columns": columns,
        })
    except ValidationError as exc:
        raise UploadConfigError([
            "; ".join(
                f"{'.'.join(str(p) for p in e['loc'])}: {e['msg']}" for e in exc.errors()
            )
        ]) from exc


def generate_zone_config(
    *,
    layer_key: str,
    staged_rel_path: str,
    label: str,
    prop_keys: set[str] | None = None,
    color: list[int] | tuple[int, ...] | None = None,
) -> ZoneConfig:
    """Build a ZoneConfig for an uploaded Polygon GeoJSON overlay."""
    props = prop_keys or set()
    name_prop = _pick_prop(props, _POI_NAME_PROPS)
    cat_prop = _pick_prop(props, _POI_CATEGORY_PROPS)
    columns: dict = {}
    if name_prop:
        columns["name"] = {"csv": name_prop, "type": "varchar"}
    if cat_prop:
        columns["category"] = {"csv": cat_prop, "type": "varchar"}

    try:
        return ZoneConfig.model_validate({
            "label": label,
            "glob": staged_rel_path,
            "format": "geojson",
            "color": _parse_color(color, layer_key),
            "columns": columns,
        })
    except ValidationError as exc:
        raise UploadConfigError([
            "; ".join(
                f"{'.'.join(str(p) for p in e['loc'])}: {e['msg']}" for e in exc.errors()
            )
        ]) from exc


@dataclass
class ColumnSniff:
    """Sniffed column roles. Names keep the file's original casing."""

    lon: str | None = None
    lat: str | None = None
    time: str | None = None
    vehicle_id: str | None = None
    name: str | None = None
    mode: str | None = None
    extra: list[str] = field(default_factory=list)
    encoding: str = "utf-8"
    time_kind: str | None = None  # "iso" | "epoch_ms" | "epoch_s"
    # When True, the mode column is treated as int transport_mode + mode_map.
    mode_as_int: bool = False


@dataclass
class ColumnCensusEntry:
    """One column in a tabular upload census (for the mapping sheet)."""

    name: str
    sample_type: str  # "number" | "string" | "mixed" | "empty"
    samples: list[str] = field(default_factory=list)
    guessed_role: str | None = None  # lon|lat|time|agent_id|name|mode
    time_kind: str | None = None


@dataclass
class TabularCensus:
    """Full column census + heuristic guesses for one staged tabular file."""

    columns: list[ColumnCensusEntry]
    sniff: ColumnSniff
    reasons: list[str] = field(default_factory=list)


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


def _infer_sample_type(samples: list[str]) -> str:
    vals = [s.strip() for s in samples if s.strip()]
    if not vals:
        return "empty"
    numeric = 0
    for s in vals:
        try:
            float(s)
            numeric += 1
        except ValueError:
            pass
    if numeric == len(vals):
        return "number"
    if numeric == 0:
        return "string"
    return "mixed"


def _read_tabular_samples(path: Path, fmt: str) -> tuple[list[str], dict[str, list[str]], str]:
    """Return (header, col_samples, encoding) for CSV/NDJSON/Parquet."""
    import json

    header: list[str] = []
    col_samples: dict[str, list[str]] = {}
    encoding = "utf-8"

    if fmt == "csv":
        text, encoding = _decode_head(path)
        reader = csv.reader(io.StringIO(text))
        rows = [r for r in islice(reader, 201) if r]
        if not rows:
            return [], {}, encoding
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
        return [], {}, encoding
    return header, col_samples, encoding


def _apply_heuristic_roles(
    header: list[str], col_samples: dict[str, list[str]], sniff: ColumnSniff
) -> None:
    """Fill sniff roles from candidate name lists + sample validation."""
    by_lower = {h.lower(): h for h in header}
    used: set[str] = set()
    for field_name, candidates in (
        ("lon", LON_CANDIDATES),
        ("lat", LAT_CANDIDATES),
        ("time", TIME_CANDIDATES),
        ("vehicle_id", ID_CANDIDATES),
        ("name", NAME_CANDIDATES),
        ("mode", MODE_CANDIDATES),
    ):
        for cand in candidates:
            original = by_lower.get(cand)
            if original is not None and original not in used:
                setattr(sniff, field_name, original)
                used.add(original)
                break

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

    role_cols = {
        sniff.lon, sniff.lat, sniff.time, sniff.vehicle_id, sniff.name, sniff.mode,
    }
    role_cols.discard(None)
    sniff.extra = [h for h in header if h not in role_cols]


def sniff_failure_reasons(sniff: ColumnSniff) -> list[str]:
    """Human-readable reasons when required roles are missing (or time_kind)."""
    reasons: list[str] = []
    if not sniff.lon or not sniff.lat:
        reasons.append(
            "could not identify longitude/latitude columns "
            f"(looked for {LON_CANDIDATES} / {LAT_CANDIDATES})"
        )
    if not sniff.time or not sniff.time_kind:
        reasons.append(
            f"could not identify a timestamp column (looked for {TIME_CANDIDATES})"
        )
    if not sniff.vehicle_id:
        reasons.append(
            f"could not identify a vehicle/device id column (looked for {ID_CANDIDATES})"
        )
    return reasons


def sniff_columns(path: Path, fmt: str) -> ColumnSniff:
    """Sniff a staged CSV/NDJSON/Parquet file for lon/lat/time/id columns.

    GeoJSON/GPX are NOT sniffed — they normalize to the canonical staging
    fields (_lon/_lat/_time_ms/_trk_name/_feature_id) at ingest. GeoJSON
    geometry compatibility is checked separately by census_geojson_geometry
    (called by the upload endpoint before accepting the file).
    """
    sniff = ColumnSniff()
    header, col_samples, encoding = _read_tabular_samples(path, fmt)
    sniff.encoding = encoding
    if not header:
        return sniff
    _apply_heuristic_roles(header, col_samples, sniff)
    return sniff


def census_tabular(path: Path, fmt: str) -> TabularCensus:
    """Column census + heuristic guesses for the interactive mapping sheet.

    Always returns every column (name, sample type, sample values) plus the
    same role guesses ``sniff_columns`` would produce and the failure reasons
    when required roles are missing.
    """
    sniff = ColumnSniff()
    header, col_samples, encoding = _read_tabular_samples(path, fmt)
    sniff.encoding = encoding
    if header:
        _apply_heuristic_roles(header, col_samples, sniff)

    role_by_col: dict[str, str] = {}
    for role, col in (
        ("lon", sniff.lon),
        ("lat", sniff.lat),
        ("time", sniff.time),
        ("agent_id", sniff.vehicle_id),
        ("name", sniff.name),
        ("mode", sniff.mode),
    ):
        if col:
            role_by_col[col] = role

    columns: list[ColumnCensusEntry] = []
    for h in header:
        samples = col_samples.get(h, [])
        entry = ColumnCensusEntry(
            name=h,
            sample_type=_infer_sample_type(samples),
            samples=[s.strip() for s in samples if s.strip()][:5],
            guessed_role=role_by_col.get(h),
            time_kind=sniff.time_kind if role_by_col.get(h) == "time" else None,
        )
        columns.append(entry)

    return TabularCensus(
        columns=columns,
        sniff=sniff,
        reasons=sniff_failure_reasons(sniff),
    )


def census_to_api_dict(
    *,
    filename: str,
    source_id: str,
    fmt: str,
    staged_name: str,
    census: TabularCensus,
) -> dict:
    """Serialize a TabularCensus for the 422 mapping_required payload."""
    return {
        "filename": filename,
        "source_id": source_id,
        "format": fmt,
        "staged_name": staged_name,
        "columns": [
            {
                "name": c.name,
                "sample_type": c.sample_type,
                "samples": c.samples,
                "guessed_role": c.guessed_role,
                "time_kind": c.time_kind,
            }
            for c in census.columns
        ],
        "guesses": {
            "lon": census.sniff.lon,
            "lat": census.sniff.lat,
            "time": census.sniff.time,
            "vehicle_id": census.sniff.vehicle_id,
            "name": census.sniff.name,
            "mode": census.sniff.mode,
            "time_kind": census.sniff.time_kind,
        },
        "reasons": census.reasons,
        "tried_candidates": {
            "lon": list(LON_CANDIDATES),
            "lat": list(LAT_CANDIDATES),
            "time": list(TIME_CANDIDATES),
            "vehicle_id": list(ID_CANDIDATES),
            "name": list(NAME_CANDIDATES),
            "mode": list(MODE_CANDIDATES),
        },
    }


def sniff_from_mapping(
    *,
    path: Path,
    fmt: str,
    mapping: dict,
) -> tuple[ColumnSniff, dict[str, str] | None]:
    """Build a ColumnSniff from an interactive mapping payload.

    ``mapping`` keys: lon, lat, time, vehicle_id (or agent_id), optional
    name/mode, optional time_kind, optional mode_map (dict[str,str]).

    Returns (sniff, mode_map). Raises UploadConfigError on invalid mapping.
    """
    header, col_samples, encoding = _read_tabular_samples(path, fmt)
    header_set = set(header)
    reasons: list[str] = []

    def _col(key: str, *aliases: str) -> str | None:
        for k in (key, *aliases):
            if k in mapping and mapping[k]:
                return str(mapping[k])
        return None

    lon = _col("lon")
    lat = _col("lat")
    time_col = _col("time")
    vehicle_id = _col("vehicle_id", "agent_id")
    name = _col("name")
    mode = _col("mode")

    for role, col in (
        ("lon", lon), ("lat", lat), ("time", time_col), ("vehicle_id", vehicle_id),
        ("name", name), ("mode", mode),
    ):
        if col is None:
            continue
        if col not in header_set:
            reasons.append(f"mapped {role} column {col!r} is not in the file")

    if not lon or not lat:
        reasons.append("mapping must assign lon and lat columns")
    if not time_col:
        reasons.append("mapping must assign a time column")
    if not vehicle_id:
        reasons.append("mapping must assign a vehicle_id / agent_id column")

    # Role uniqueness (ignore is not a column assignment).
    assigned = [c for c in (lon, lat, time_col, vehicle_id, name, mode) if c]
    if len(assigned) != len(set(assigned)):
        reasons.append("each column may be assigned to at most one role")

    time_kind = mapping.get("time_kind")
    if time_kind is not None:
        time_kind = str(time_kind)
        if time_kind not in TIME_KINDS:
            reasons.append(
                f"time_kind must be one of {sorted(TIME_KINDS)}, got {time_kind!r}"
            )
    elif time_col and time_col in header_set:
        time_kind = _timestamp_kind(col_samples.get(time_col, []))
        if time_kind is None:
            reasons.append(
                f"could not infer time_kind for {time_col!r} — "
                "set time_kind to iso, epoch_ms, or epoch_s"
            )

    mode_map_raw = mapping.get("mode_map")
    mode_map: dict[str, str] | None = None
    if mode_map_raw is not None:
        if not isinstance(mode_map_raw, dict):
            reasons.append("mode_map must be an object of string→string entries")
        else:
            mode_map = {str(k): str(v) for k, v in mode_map_raw.items()}
            if mode is None:
                reasons.append("mode_map requires a mode column mapping")

    if reasons:
        raise UploadConfigError(reasons)

    sniff = ColumnSniff(
        lon=lon,
        lat=lat,
        time=time_col,
        vehicle_id=vehicle_id,
        name=name,
        mode=mode,
        encoding=encoding,
        time_kind=time_kind,
        mode_as_int=bool(mode_map),
        extra=[h for h in header if h not in set(assigned)],
    )
    return sniff, mode_map


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
    mode_map: dict[str, str] | None = None,
) -> SourceConfig:
    """Build (and validate) a SourceConfig for one uploaded file.

    CSV/NDJSON/Parquet require a ColumnSniff and raise UploadConfigError
    listing every unidentifiable role. GeoJSON/GPX map the canonical staging
    fields directly.

    When ``sniff.mode`` is set: string ``mode`` column by default; if
    ``mode_map`` / ``sniff.mode_as_int`` is set, map as int ``transport_mode``
    + ``mode_map`` (lab int codes → string labels at ingest).
    """
    if fmt in _STAGED_VEHICLE_ID_COL:
        vehicle_id_col = _STAGED_VEHICLE_ID_COL[fmt]
        waypoints: dict = {
            "unix_time_ms": {"csv": "_time_ms", "type": "bigint"},
            "lon": {"csv": "_lon", "type": "double"},
            "lat": {"csv": "_lat", "type": "double"},
        }
    else:
        if sniff is None:  # pragma: no cover - caller contract
            raise UploadConfigError(["internal: sniff required for csv/ndjson/parquet"])
        reasons = sniff_failure_reasons(sniff)
        if reasons:
            raise UploadConfigError(reasons)
        if not sniff.time_kind or sniff.time_kind not in _UNIX_TIME_SQL:
            raise UploadConfigError([
                f"internal: missing/invalid time_kind {sniff.time_kind!r}"
            ])
        vehicle_id_col = sniff.vehicle_id
        waypoints = {
            "unix_time_ms": {
                "derived": _UNIX_TIME_SQL[sniff.time_kind].format(col=sniff.time)
            },
            "lon": {"csv": sniff.lon, "type": "double"},
            "lat": {"csv": sniff.lat, "type": "double"},
        }
        if sniff.mode:
            if mode_map or sniff.mode_as_int:
                waypoints["transport_mode"] = {"csv": sniff.mode, "type": "int"}
            else:
                waypoints["mode"] = {"csv": sniff.mode, "type": "varchar"}

    color = _PALETTE[zlib.crc32(source_id.encode("utf-8")) % len(_PALETTE)]

    payload: dict = {
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
    }
    if mode_map:
        payload["mode_map"] = mode_map

    try:
        return SourceConfig.model_validate(payload)
    except ValidationError as exc:  # pragma: no cover - defensive
        raise UploadConfigError([
            "; ".join(
                f"{'.'.join(str(p) for p in e['loc'])}: {e['msg']}" for e in exc.errors()
            )
        ]) from exc


def write_uploads_registry(
    registry_path: Path,
    configs: list[SourceConfig] | None = None,
    *,
    pois: dict | None = None,
    zones: dict | None = None,
) -> None:
    """Merge generated configs into the uploads registry YAML (uploads win).

    The registry is a standard SourcesFile-shaped document
    ({version: 1, sources: {...}, pois?: {...}, zones?: {...}}) so
    load_sources / load_sources_merged can read it directly.
    """
    data: dict = {"version": 1, "sources": {}, "pois": {}, "zones": {}}
    if registry_path.exists():
        loaded = yaml.safe_load(registry_path.read_text(encoding="utf-8")) or {}
        if isinstance(loaded, dict):
            data["version"] = loaded.get("version", 1)
            data["sources"] = dict(loaded.get("sources") or {})
            data["pois"] = dict(loaded.get("pois") or {})
            data["zones"] = dict(loaded.get("zones") or {})

    for cfg in configs or []:
        data["sources"][cfg.source_id] = cfg.model_dump(mode="json", exclude_none=True)

    if pois:
        for key, cfg in pois.items():
            dump = cfg.model_dump(mode="json", exclude_none=True) if hasattr(cfg, "model_dump") else cfg
            data["pois"][key] = dump
    if zones:
        for key, cfg in zones.items():
            dump = cfg.model_dump(mode="json", exclude_none=True) if hasattr(cfg, "model_dump") else cfg
            data["zones"][key] = dump

    # Drop empty overlay maps so the file stays SourcesFile-valid and tidy.
    if not data["pois"]:
        data.pop("pois")
    if not data["zones"]:
        data.pop("zones")

    registry_path.parent.mkdir(parents=True, exist_ok=True)
    registry_path.write_text(
        yaml.safe_dump(data, sort_keys=False, allow_unicode=True), encoding="utf-8"
    )


def load_uploads_registry_ids(registry_path: Path) -> set[str]:
    """Ids already claimed by the uploads registry (sources + pois + zones)."""
    if not registry_path.exists():
        return set()
    loaded = yaml.safe_load(registry_path.read_text(encoding="utf-8")) or {}
    if not isinstance(loaded, dict):
        return set()
    ids = set((loaded.get("sources") or {}).keys())
    ids |= set((loaded.get("pois") or {}).keys())
    ids |= set((loaded.get("zones") or {}).keys())
    return ids

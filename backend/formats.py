"""
Universal trajectory format normalizers (universal-trajectory-support Phase 1).

Non-CSV ingest formats are parsed in Python into flat row dicts with a
canonical staging shape, then staged into a TEMP DuckDB table by
`ingest._table_source` and run through the same `_select_clause` /
`_column_expr` / `_vehicle_key_sql` pipeline as CSV. Parquet has NO
normalizer — DuckDB reads it natively via `read_parquet`.

Canonical staging fields (the `_` prefix avoids collisions with source
property names):

    _lon, _lat    point coordinates (DOUBLE)
    _time_ms      epoch milliseconds (BIGINT), or NULL when the source has
                  no per-point time
    _seq          intra-feature coordinate index (geojson) / cumulative index
                  (gpx) / line number (ndjson)
    _feature_id   geojson feature index / "{trk}:{seg}" (gpx) / line number
    _trk_name     GPX <trk><name> (or "trk{idx}"); absent elsewhere
    _props_json   JSON object string of the properties not consumed above

Plus first-level scalar properties (str/int/float/bool) flattened as plain
fields — nested objects/arrays appear only inside _props_json.

Timestamp contract: ISO-8601 strings parse via datetime.fromisoformat; naive
timestamps are ASSUMED UTC (documented — GPX mandates Z, GeoJSON producers
vary); aware timestamps convert to UTC epoch ms. Numeric timestamps are epoch
seconds when < 1e11, epoch milliseconds otherwise.

GeoJSON memory profile: FeatureCollections stream feature-by-feature via ijson
when installed (optional extra `speed`; C-accelerated), so peak memory is one
feature regardless of file size. Without ijson the file falls back to a whole-
document json.load — same rows, higher peak memory. Bare `Feature` roots and
any ijson import failure take the fallback path.
"""

from __future__ import annotations

import json
import re
import xml.etree.ElementTree as ET
from collections.abc import Iterator
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .sources_schema import _FORMAT_BY_EXT, FormatType

try:  # optional streaming backend (see module docstring)
    import ijson  # type: ignore[import-untyped]

    _HAS_IJSON = True
except ImportError:
    _HAS_IJSON = False

__all__ = [
    "detect_format",
    "normalize_geojson",
    "normalize_gpx",
    "normalize_ndjson",
    "extract_geojson_polygons",
    "iter_geojson_features",
]


def detect_format(path: Path | str, declared: str | None) -> FormatType:
    """Resolve the ingest format for one file: explicit declaration wins,
    otherwise the extension decides. `.json` raises — geojson vs ndjson is
    undecidable by extension and must be declared in sources.yaml."""
    if declared is not None:
        return declared  # type: ignore[return-value]
    ext = Path(path).suffix.lower()
    if ext == ".json":
        raise ValueError(
            f"Cannot auto-detect format of {path}: `.json` is ambiguous "
            f"(geojson vs ndjson). Set an explicit `format:` in sources.yaml."
        )
    fmt = _FORMAT_BY_EXT.get(ext)
    if fmt is None:
        raise ValueError(
            f"Cannot auto-detect format of {path}: unknown extension {ext!r}. "
            f"Set an explicit `format:` in sources.yaml. "
            f"Known: {sorted(_FORMAT_BY_EXT)}."
        )
    return fmt  # type: ignore[return-value]


# --- Timestamp parsing ---------------------------------------------------------


def parse_time_to_ms(value: Any) -> int | None:
    """Parse one timestamp value to UTC epoch milliseconds.

    Accepts ISO-8601 strings (naive → assumed UTC; aware → converted to UTC)
    and epoch numbers (seconds when < 1e11, milliseconds otherwise).
    Returns None for None; raises ValueError on unparseable input.
    """
    if value is None:
        return None
    if isinstance(value, bool):
        raise ValueError(f"Not a timestamp: {value!r}")
    if isinstance(value, (int, float)):
        # Heuristic: epoch ms values are >= ~1973 in ms (~1e11); anything
        # smaller is epoch seconds.
        return int(value if value >= 1e11 else value * 1000)
    if isinstance(value, str):
        dt = datetime.fromisoformat(value)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=UTC)
        return int(dt.timestamp() * 1000)
    raise ValueError(f"Not a timestamp: {value!r}")


# --- Property flattening --------------------------------------------------------


def _flatten_scalars(props: dict) -> dict:
    """First-level scalar properties only; nested objects/arrays are dropped
    (they survive inside _props_json)."""
    return {
        k: v for k, v in props.items() if isinstance(v, (str, int, float, bool))
    }


def _props_json(props: dict) -> str:
    return json.dumps(props, ensure_ascii=False, separators=(",", ":"))


# --- GeoJSON ---------------------------------------------------------------------


def _geojson_features(doc: Any) -> Iterator[dict]:
    """Yield Feature dicts from a GeoJSON document (FeatureCollection or a
    bare Feature)."""
    gtype = doc.get("type") if isinstance(doc, dict) else None
    if gtype == "FeatureCollection":
        yield from (f for f in doc.get("features", []) if isinstance(f, dict))
    elif gtype == "Feature":
        yield doc
    else:
        raise ValueError(
            f"Unsupported GeoJSON root type {gtype!r} — expected "
            f"FeatureCollection or Feature."
        )


def _geojson_feature_rows(
    feature_idx: int,
    feature: dict,
    coord_times_prop: str | None,
) -> Iterator[dict]:
    """Yield canonical staging rows for one GeoJSON feature.

    Point features yield one row per feature; LineString features yield one
    row per coordinate. Per-point time resolution order for LineStrings:
    `coord_times_prop[i]` → feature `time` property → NULL. For Points: the
    feature `time` property or NULL.
    """
    geom = feature.get("geometry") or {}
    gtype = geom.get("type")
    coords = geom.get("coordinates") or []
    props = dict(feature.get("properties") or {})

    consumed = {"time"}
    if coord_times_prop:
        consumed.add(coord_times_prop)
    feature_time_ms = parse_time_to_ms(props.get("time"))
    coord_times = props.get(coord_times_prop) if coord_times_prop else None
    flat = {k: v for k, v in _flatten_scalars(props).items() if k not in consumed}
    props_json = _props_json({k: v for k, v in props.items() if k not in consumed})

    base = {
        "_feature_id": feature_idx,
        "_props_json": props_json,
        **flat,
    }

    if gtype == "Point":
        yield {
            **base,
            "_lon": coords[0] if len(coords) > 0 else None,
            "_lat": coords[1] if len(coords) > 1 else None,
            "_time_ms": feature_time_ms,
            "_seq": 0,
        }
    elif gtype == "LineString":
        for i, coord in enumerate(coords):
            if coord_times is not None and i < len(coord_times):
                t_ms = parse_time_to_ms(coord_times[i])
            else:
                t_ms = feature_time_ms
            yield {
                **base,
                "_lon": coord[0] if len(coord) > 0 else None,
                "_lat": coord[1] if len(coord) > 1 else None,
                "_time_ms": t_ms,
                "_seq": i,
            }
    else:
        raise ValueError(
            f"Unsupported GeoJSON geometry type {gtype!r} "
            f"(feature {feature_idx}) — Point and LineString only."
        )


# A FeatureCollection root — the only shape the ijson streaming path handles.
_FC_ROOT_RE = re.compile(rb'"type"\s*:\s*"FeatureCollection"')


def iter_geojson_features(path: Path | str) -> Iterator[tuple[int, dict]]:
    """Yield (index, feature dict) from a GeoJSON file.

    FeatureCollections stream via ijson when available (one-feature peak
    memory); otherwise the whole document loads first. Bare `Feature`
    documents always take the whole-document path (they are one feature).
    Shared by normalize_geojson, extract_geojson_polygons, and the upload
    geometry census — one branch to maintain.
    """
    if _HAS_IJSON and _looks_like_feature_collection(path):
        with open(path, "rb") as fh:
            # use_float: emit floats, not Decimal (Decimal breaks json.dumps
            # in _props_json downstream).
            for idx, feature in enumerate(
                ijson.items(fh, "features.item", use_float=True)
            ):
                if isinstance(feature, dict):
                    yield idx, feature
        return

    with open(path, encoding="utf-8") as fh:
        doc = json.load(fh)

    for feature_idx, feature in enumerate(_geojson_features(doc)):
        yield feature_idx, feature


def normalize_geojson(
    path: Path | str,
    coord_times_prop: str | None = None,
) -> Iterator[dict]:
    """Yield canonical staging rows from a GeoJSON file.

    Point features yield one row per feature; LineString features yield one
    row per coordinate (see _geojson_feature_rows for the time contract).
    Feature iteration streams via iter_geojson_features.
    """
    for feature_idx, feature in iter_geojson_features(path):
        yield from _geojson_feature_rows(feature_idx, feature, coord_times_prop)


def _looks_like_feature_collection(path: Path | str) -> bool:
    """Cheap root-type sniff on the file head; anything ambiguous → False,
    which selects the whole-document fallback (correct, just slower)."""
    try:
        with open(path, "rb") as fh:
            return bool(_FC_ROOT_RE.search(fh.read(4096)))
    except OSError:
        return False


# --- GPX -------------------------------------------------------------------------


def _local_name(tag: str) -> str:
    """Strip the XML namespace from a tag: '{ns}trkpt' -> 'trkpt'."""
    return tag.rsplit("}", 1)[-1]


def normalize_gpx(path: Path | str) -> Iterator[dict]:
    """Yield canonical staging rows from a GPX file via iterparse.

    One row per <trkpt>. `_feature_id` is "{trk}:{seg}" (0-based indexes);
    `_trk_name` is the track's <name> or "trk{idx}"; `_seq` is cumulative
    across the whole file so waypoint ordering never depends on track
    boundaries. Track-point <time> values honor their UTC offset.
    """
    trk_idx = -1
    seg_idx = -1
    trk_name: str | None = None
    seq = 0
    stack: list[str] = []

    for event, elem in ET.iterparse(path, events=("start", "end")):
        tag = _local_name(elem.tag)
        if event == "start":
            stack.append(tag)
            if tag == "trk":
                trk_idx += 1
                seg_idx = -1
                trk_name = None
            elif tag == "trkseg" and "trk" in stack:
                seg_idx += 1
            continue

        # event == "end"
        if tag == "name" and len(stack) >= 2 and stack[-2] == "trk":
            if elem.text and elem.text.strip():
                trk_name = elem.text.strip()
        elif tag == "trkpt":
            props: dict[str, Any] = {}
            time_ms: int | None = None
            for child in elem:
                ctag = _local_name(child.tag)
                if ctag == "time":
                    time_ms = parse_time_to_ms(child.text)
                elif ctag == "ele":
                    try:
                        props["ele"] = float(child.text)  # type: ignore[arg-type]
                    except (TypeError, ValueError):
                        props["ele"] = child.text
                elif ctag == "extensions":
                    props["extensions"] = {
                        _local_name(e.tag): (e.text or "") for e in child
                    }
                else:
                    if child.text and child.text.strip():
                        props[ctag] = child.text.strip()
            yield {
                "_lon": float(elem.get("lon")),  # type: ignore[arg-type]
                "_lat": float(elem.get("lat")),  # type: ignore[arg-type]
                "_time_ms": time_ms,
                "_seq": seq,
                "_feature_id": f"{trk_idx}:{max(seg_idx, 0)}",
                "_trk_name": trk_name or f"trk{trk_idx}",
                "_props_json": _props_json(props),
                **_flatten_scalars(props),
            }
            seq += 1
            elem.clear()
        stack.pop()


# --- NDJSON -----------------------------------------------------------------------


def normalize_ndjson(path: Path | str) -> Iterator[dict]:
    """Yield canonical staging rows from an NDJSON file (one JSON object per
    line). Field names are producer-defined — the YAML ColumnSpec `csv:` keys
    reference them directly (e.g. {csv: vehicle} reads row["vehicle"]); the
    whole original row is also preserved in _props_json."""
    with open(path, encoding="utf-8") as fh:
        for line_no, line in enumerate(fh):
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            if not isinstance(row, dict):
                raise ValueError(
                    f"NDJSON line {line_no} of {path} is not a JSON object."
                )
            yield {
                "_seq": line_no,
                "_feature_id": line_no,
                "_props_json": _props_json(row),
                **_flatten_scalars(row),
            }


# --- GeoJSON polygons (zones) -----------------------------------------------------


def extract_geojson_polygons(path: Path | str) -> Iterator[dict]:
    """Yield polygon records from a GeoJSON file (zones/polygons layer).

    Accepts FeatureCollections and bare Features whose geometry is Polygon
    or MultiPolygon; anything else raises. Each record carries the full
    geometry under `_geometry` ({type, coordinates}) plus the usual property
    flattening (`_props_json` + first-level scalars) so sources.yaml can
    map name/category columns exactly like POI layers.
    """
    def _rows(feature: dict, feature_idx: int) -> Iterator[dict]:
        geom = feature.get("geometry") or {}
        gtype = geom.get("type")
        coords = geom.get("coordinates")
        props = dict(feature.get("properties") or {})
        if gtype not in ("Polygon", "MultiPolygon"):
            raise ValueError(
                f"Unsupported zone geometry type {gtype!r} "
                f"(feature {feature_idx}) — Polygon and MultiPolygon only."
            )
        if not coords:
            raise ValueError(
                f"Zone geometry has no coordinates (feature {feature_idx})."
            )
        yield {
            "_feature_id": feature_idx,
            "_props_json": _props_json(props),
            "_geometry": {"type": gtype, "coordinates": coords},
            **_flatten_scalars(props),
        }

    for idx, feature in iter_geojson_features(path):
        yield from _rows(feature, idx)

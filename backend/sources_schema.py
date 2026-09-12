"""
sources.yaml schema + loader + validator.

The dashboard ingests trips/waypoint CSVs from any agent-based model that can
be described by a config block in `sources.yaml`. This module defines the
schema, loads YAML files, and validates them.

CLI usage:
    python -m backend.sources_schema --validate path/to/sources.yaml
    python -m backend.sources_schema --print-example
"""

from __future__ import annotations

import argparse
import os
import sys
from glob import glob
from pathlib import Path
from typing import Literal

import yaml
from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

# DuckDB types we accept in column specs.
ColumnType = Literal["int", "bigint", "double", "varchar", "bool"]

# Universal trajectory support: ingest formats. `csv` is the original format;
# the others are normalized by backend/formats.py (or read natively by DuckDB
# for parquet) before flowing through the same ColumnSpec pipeline.
FormatType = Literal["csv", "geojson", "gpx", "ndjson", "parquet"]

# Extension → format auto-detection map. `.json` is deliberately absent: it is
# ambiguous between geojson and ndjson and requires an explicit `format:`.
_FORMAT_BY_EXT: dict[str, str] = {
    ".csv": "csv",
    ".geojson": "geojson",
    ".gpx": "gpx",
    ".ndjson": "ndjson",
    ".jsonl": "ndjson",
    ".parquet": "parquet",
    ".pq": "parquet",
}


# Core required trip columns. Every source must map something to each of these
# (either via {csv: ...} or via {derived: ...}), or the ingester won't have
# enough info to build a valid trips row.
REQUIRED_TRIP_COLUMNS: set[str] = {
    "starttime",
    "start_lon",
    "start_lat",
    "end_lon",
    "end_lat",
}

# Core required waypoint columns when trajectories are ingested.
REQUIRED_WAYPOINT_COLUMNS: set[str] = {
    "unix_time_ms",
    "lon",
    "lat",
}


class ColumnSpec(BaseModel):
    """One DB column = either pulled from a CSV column, or derived via SQL."""

    model_config = ConfigDict(extra="forbid")

    csv: str | None = Field(
        default=None,
        description="CSV column name to read (when not a derived column).",
    )
    type: ColumnType | None = Field(
        default=None,
        description="DuckDB type (int|bigint|double|varchar|bool). Required if `csv` is set.",
    )
    transform: str | None = Field(
        default=None,
        description=(
            "Optional SQL expression applied to the CSV column. "
            "Use `value` as the placeholder for the CSV column reference. "
            "Example for boolean coercion: \"lower(value) = 'true'\"."
        ),
    )
    derived: str | None = Field(
        default=None,
        description=(
            "SQL expression computed from other CSV columns. "
            "Mutually exclusive with `csv`/`transform`. "
            "Example: \"CAST(starttime / 3600 AS INTEGER)\"."
        ),
    )

    @model_validator(mode="after")
    def _exactly_one_source(self) -> ColumnSpec:
        has_csv = self.csv is not None
        has_derived = self.derived is not None
        if has_csv == has_derived:
            raise ValueError(
                "Exactly one of `csv` or `derived` must be set on a column spec."
            )
        if has_csv and self.type is None:
            raise ValueError("`type` is required when `csv` is set.")
        if has_derived and (self.type is not None or self.transform is not None):
            raise ValueError(
                "`derived` columns must not set `type` or `transform` "
                "(the SQL expression encodes both)."
            )
        return self


class RenderConfig(BaseModel):
    """Optional per-source rendering hints for the frontend (Phase 2A).

    `mode` picks the visual treatment:
      - trails: animated TripsLayer paths (default; trucks/taxis)
      - points: moving dots at the interpolated position (people)
      - arcs:   time-windowed OD arcs (trip-only sources with no waypoints)
    `color` is an RGB triple; when omitted the frontend falls back to its
    deterministic hash palette.
    """

    model_config = ConfigDict(extra="forbid")

    mode: Literal["trails", "points", "arcs"] = Field(
        default="trails",
        description="Visual treatment: trails | points | arcs.",
    )
    color: tuple[int, int, int] | None = Field(
        default=None,
        description="RGB color triple (0-255 each). Omit for palette fallback.",
    )

    @model_validator(mode="after")
    def _validate_color_range(self) -> RenderConfig:
        if self.color is not None:
            for c in self.color:
                if not (0 <= c <= 255):
                    raise ValueError(
                        f"render.color components must be 0-255, got {self.color}."
                    )
        return self


class ScopeConfig(BaseModel):
    """Optional scope qualifier for sources whose vehicle IDs only make sense
    within a sub-population (e.g. per-city taxi fleets)."""

    model_config = ConfigDict(extra="forbid")

    value: str = Field(description="Scope value (e.g. 'tokyo' for Tokyo taxis).")


class DiscoveryConfig(BaseModel):
    """How to discover data files on disk for this source."""

    model_config = ConfigDict(extra="forbid")

    trips_glob: str | None = Field(
        default=None,
        description=(
            "Glob (relative to PFLOW_VIZ_OUTPUT_ROOT) matching this source's "
            "trip files. Example: 'trips/truck/run_*/trips_pseudo_pflow.csv'. "
            "Optional for points-only sources — when omitted, trips are "
            "synthesized from waypoints at ingest (see trips_synthesis)."
        ),
    )
    trajectories_glob: str | None = Field(
        default=None,
        description="Glob for trajectory/waypoint files. Optional.",
    )
    format: FormatType | None = Field(
        default=None,
        description=(
            "Ingest format applied to both trips and trajectories files "
            "(csv|geojson|gpx|ndjson|parquet). Auto-detected from the file "
            "extension when omitted; `.json` files require an explicit format."
        ),
    )
    trips_format: FormatType | None = Field(
        default=None,
        description="Per-side format override for trips files (wins over `format`).",
    )
    trajectories_format: FormatType | None = Field(
        default=None,
        description="Per-side format override for trajectory files (wins over `format`).",
    )
    latest_only: bool = Field(
        default=True,
        description="If True, use only the most recent matching run_* directory.",
    )
    scope: ScopeConfig | None = Field(
        default=None,
        description="Optional scope value (used in vehicle_key_template and city column).",
    )
    validation_relative: str | None = Field(
        default=None,
        description=(
            "Filename of the validation CSV relative to each trips CSV's directory. "
            "Example: 'validation.csv'."
        ),
    )


class ColumnsConfig(BaseModel):
    """Column mapping for this source."""

    model_config = ConfigDict(extra="forbid")

    trip_id_col: str | None = Field(
        default=None,
        description=(
            "Column whose value becomes trips.trip_id. Required unless "
            "trips_synthesis is set (synthesized trips get ordinals)."
        ),
    )
    vehicle_id_col: str = Field(
        description="Column whose value becomes trips.vehicle_id."
    )
    trips: dict[str, ColumnSpec] = Field(
        default_factory=dict,
        description="Map of DB column name -> ColumnSpec for the `trips` table.",
    )
    waypoints: dict[str, ColumnSpec] | None = Field(
        default=None,
        description="Map of DB column name -> ColumnSpec for the `waypoints` table.",
    )


class TripsSynthesisConfig(BaseModel):
    """How to synthesize trips from raw waypoints for points-only sources.

    gap_split: a new trip starts whenever consecutive pings of one vehicle are
        more than `gap_minutes` apart.
    day: a new trip starts on every simulation-day boundary (anchor-relative).
    single: every vehicle gets exactly one trip.
    """

    model_config = ConfigDict(extra="forbid")

    strategy: Literal["gap_split", "day", "single"] = Field(
        default="gap_split",
        description="Trip boundary strategy: gap_split | day | single.",
    )
    gap_minutes: float = Field(
        default=30.0,
        gt=0,
        le=1440,
        description="Gap threshold in minutes for the gap_split strategy.",
    )


class TimeConfig(BaseModel):
    """Absolute-time handling for universal (non-PFLOW) sources."""

    model_config = ConfigDict(extra="forbid")

    epoch_anchor: str | None = Field(
        default=None,
        description=(
            "ISO-8601 timestamp (must be timezone-aware) anchoring unix_time_ms "
            "values to absolute time, e.g. '2024-05-01T00:00:00+09:00'. At most "
            "one distinct anchor across the whole file; stored in viz_meta."
        ),
    )
    coord_times_prop: str | None = Field(
        default=None,
        description=(
            "GeoJSON LineString property holding the per-coordinate time array "
            "(e.g. 'coordTimes'). Each entry maps to the coordinate at the same "
            "index; entries are ISO-8601 strings or epoch numbers."
        ),
    )


def _validate_epoch_anchor(value: str) -> None:
    """Parse an epoch_anchor ISO string; raises ValueError on naive/bad input."""
    from datetime import datetime

    try:
        dt = datetime.fromisoformat(value)
    except ValueError as e:
        raise ValueError(
            f"epoch_anchor {value!r} is not a valid ISO-8601 timestamp: {e}"
        ) from e
    if dt.tzinfo is None:
        raise ValueError(
            f"epoch_anchor {value!r} must be timezone-aware "
            f"(e.g. '2024-05-01T00:00:00+09:00' or '...Z')."
        )


class SourceConfig(BaseModel):
    """One ABM data source.

    The source key in `sources.yaml` (e.g. 'pflow-truck') is the unique
    identifier used in the `source_id` column. `source_id` (this field) is a
    short label that may collide across sources (e.g. multiple cities of
    taxis can all share source_id='taxi' but have different source keys).
    """

    model_config = ConfigDict(extra="forbid")

    label: str = Field(description="Human-readable label shown in the dashboard.")
    source_id: str = Field(
        description=(
            "Short label that goes into trips.source_id (and vehicle_type for "
            "back-compat). May collide across sources of the same kind."
        )
    )
    discovery: DiscoveryConfig
    vehicle_key_template: str = Field(
        description=(
            "Template for the cross-source-unique vehicle key. Placeholders: "
            "`{vehicle_id}` (required), `{scope}` (required iff discovery.scope is set), "
            "`{source_id}`. Example: 'truck:{vehicle_id}' or 'taxi:{scope}:{vehicle_id}'."
        )
    )
    columns: ColumnsConfig
    render: RenderConfig | None = Field(
        default=None,
        description="Optional frontend rendering hints (mode + color).",
    )
    trips_synthesis: TripsSynthesisConfig | None = Field(
        default=None,
        description=(
            "Points-only source: synthesize trips from waypoints at ingest. "
            "Mutually exclusive with discovery.trips_glob."
        ),
    )
    time: TimeConfig | None = Field(
        default=None,
        description="Optional absolute-time handling (epoch anchor, coord-times prop).",
    )

    @model_validator(mode="after")
    def _validate_template(self) -> SourceConfig:
        # Verify required placeholders.
        if "{vehicle_id}" not in self.vehicle_key_template:
            raise ValueError(
                f"vehicle_key_template '{self.vehicle_key_template}' must include "
                f"`{{vehicle_id}}` placeholder."
            )
        # Verify scope alignment.
        has_scope = self.discovery.scope is not None
        uses_scope = "{scope}" in self.vehicle_key_template
        if has_scope and not uses_scope:
            raise ValueError(
                "discovery.scope is set but vehicle_key_template does not use {scope}."
            )
        if uses_scope and not has_scope:
            raise ValueError(
                "vehicle_key_template uses {scope} but discovery.scope is not set."
            )
        return self

    @model_validator(mode="after")
    def _validate_discovery_and_synthesis(self) -> SourceConfig:
        """Points-only sources: trips_glob omitted ⇒ trips synthesized at ingest."""
        d = self.discovery
        if d.trips_glob is None and d.trajectories_glob is None:
            raise ValueError(
                "At least one of discovery.trips_glob / discovery.trajectories_glob "
                "is required."
            )
        if d.trips_glob is not None and self.trips_synthesis is not None:
            raise ValueError(
                "trips_synthesis and discovery.trips_glob are mutually exclusive — "
                "a source either ingests trip files or synthesizes trips from "
                "waypoints, never both."
            )
        if d.trips_glob is None and self.trips_synthesis is None:
            # Points-only source: default to gap_split synthesis.
            self.trips_synthesis = TripsSynthesisConfig()
        if d.trips_glob is not None and self.columns.trip_id_col is None:
            raise ValueError(
                "columns.trip_id_col is required when discovery.trips_glob is set."
            )
        return self

    @model_validator(mode="after")
    def _validate_formats(self) -> SourceConfig:
        """Every globbed side must resolve to a format without ambiguity.

        `.json` files cannot be auto-detected (geojson vs ndjson) — an
        explicit `format:` / `trips_format:` / `trajectories_format:` is
        required. This mirrors backend/formats.detect_format but runs at
        schema-validation time so typos fail at --validate, not mid-ingest.
        """
        d = self.discovery
        sides = (
            ("trips_glob", d.trips_glob, d.trips_format or d.format),
            ("trajectories_glob", d.trajectories_glob, d.trajectories_format or d.format),
        )
        for side_name, glob_pattern, declared in sides:
            if glob_pattern is None or declared is not None:
                continue
            # The glob's filename suffix decides auto-detection (same rule as
            # backend/formats.detect_format applies per matched file).
            ext = Path(glob_pattern).suffix.lower()
            if ext == ".json":
                raise ValueError(
                    f"discovery.{side_name} {glob_pattern!r} has a `.json` "
                    f"extension, which is ambiguous (geojson vs ndjson). "
                    f"Set an explicit `format:` (or {side_name.removesuffix('_glob')}"
                    f"_format:)."
                )
        return self

    @model_validator(mode="after")
    def _validate_time(self) -> SourceConfig:
        if self.time is not None and self.time.epoch_anchor is not None:
            _validate_epoch_anchor(self.time.epoch_anchor)
        return self

    @model_validator(mode="after")
    def _validate_required_columns(self) -> SourceConfig:
        if self.trips_synthesis is not None:
            # Synthesized trips derive starttime/endpoints from waypoints at
            # ingest — no trip column mapping required (empty allowed).
            pass
        else:
            missing = REQUIRED_TRIP_COLUMNS - set(self.columns.trips.keys())
            if missing:
                raise ValueError(
                    f"Missing required trip columns: {sorted(missing)}. "
                    f"Every source must map: {sorted(REQUIRED_TRIP_COLUMNS)}."
                )
        if self.discovery.trajectories_glob and self.columns.waypoints is not None:
            wp_missing = REQUIRED_WAYPOINT_COLUMNS - set(self.columns.waypoints.keys())
            if wp_missing:
                raise ValueError(
                    f"Missing required waypoint columns: {sorted(wp_missing)}. "
                    f"When trajectories_glob is set, waypoints must map: "
                    f"{sorted(REQUIRED_WAYPOINT_COLUMNS)}."
                )
        return self


class PoiColumnsConfig(BaseModel):
    """Column mapping for a POI layer. lon/lat are required; name/category
    are optional display attributes."""

    model_config = ConfigDict(extra="forbid")

    name: ColumnSpec | None = Field(default=None)
    category: ColumnSpec | None = Field(default=None)
    lon: ColumnSpec
    lat: ColumnSpec


class PoiConfig(BaseModel):
    """One static POI layer (restaurants, stations, chargers, ...).

    Ingested into the `pois` table under the `pois:` block key (source_key);
    served via /api/pois and /api/pois/categories.
    """

    model_config = ConfigDict(extra="forbid")

    label: str = Field(description="Human-readable label shown in the dashboard.")
    glob: str = Field(
        description="Glob (relative to PFLOW_VIZ_OUTPUT_ROOT) matching POI files."
    )
    format: FormatType | None = Field(
        default=None,
        description="Ingest format; auto-detected from extension when omitted.",
    )
    columns: PoiColumnsConfig
    color: tuple[int, int, int] | None = Field(
        default=None,
        description="RGB color triple (0-255 each). Omit for palette fallback.",
    )

    @model_validator(mode="after")
    def _validate_color_range(self) -> PoiConfig:
        if self.color is not None:
            for c in self.color:
                if not (0 <= c <= 255):
                    raise ValueError(
                        f"pois color components must be 0-255, got {self.color}."
                    )
        return self

    @model_validator(mode="after")
    def _validate_format_unambiguous(self) -> PoiConfig:
        if self.format is None and Path(self.glob).suffix.lower() == ".json":
            raise ValueError(
                f"pois glob {self.glob!r} has a `.json` extension, which is "
                f"ambiguous (geojson vs ndjson). Set an explicit `format:`."
            )
        return self


class ZoneColumnsConfig(BaseModel):
    """Column mapping for a zone layer. Geometry comes from the GeoJSON
    coordinates; name/category are optional display attributes."""

    model_config = ConfigDict(extra="forbid")

    name: ColumnSpec | None = Field(default=None)
    category: ColumnSpec | None = Field(default=None)


class ZoneConfig(BaseModel):
    """One static polygon/zone layer (wards, service areas, districts...).

    Ingested into the `zones` table under the `zones:` block key (source_key);
    served via /api/zones. GeoJSON only — polygons need real geometry.
    """

    model_config = ConfigDict(extra="forbid")

    label: str = Field(description="Human-readable label shown in the dashboard.")
    glob: str = Field(
        description="Glob (relative to PFLOW_VIZ_OUTPUT_ROOT) matching zone files."
    )
    format: FormatType | None = Field(
        default=None,
        description="Ingest format; auto-detected from extension when omitted.",
    )
    columns: ZoneColumnsConfig
    color: tuple[int, int, int] | None = Field(
        default=None,
        description="RGB color triple (0-255 each). Omit for palette fallback.",
    )

    @model_validator(mode="after")
    def _validate_color_range(self) -> ZoneConfig:
        if self.color is not None:
            for c in self.color:
                if not (0 <= c <= 255):
                    raise ValueError(
                        f"zones color components must be 0-255, got {self.color}."
                    )
        return self

    @model_validator(mode="after")
    def _validate_format_unambiguous(self) -> ZoneConfig:
        if self.format is None and Path(self.glob).suffix.lower() == ".json":
            raise ValueError(
                f"zones glob {self.glob!r} has a `.json` extension, which is "
                f"ambiguous (geojson vs ndjson). Set an explicit `format:`."
            )
        return self

    @model_validator(mode="after")
    def _validate_columns_csv_only(self) -> ZoneConfig:
        """Zone name/category must map plain `csv:` properties.

        Zones ingest through a pure-Python path (no staged SQL table), so
        `derived:`/`transform:` expressions — evaluated in SQL for trips,
        waypoints, and POIs — cannot run here. Fail at validation time with
        a clear message instead of silently dropping the mapping at ingest.
        """
        for dim in ("name", "category"):
            spec = getattr(self.columns, dim)
            if spec is not None and (spec.derived is not None or spec.transform is not None):
                raise ValueError(
                    f"zones columns.{dim} must use a plain `csv:` property — "
                    f"`derived:`/`transform:` are not supported on zone layers."
                )
        return self


class SourcesFile(BaseModel):
    """Top-level structure of sources.yaml."""

    model_config = ConfigDict(extra="forbid")

    version: int = Field(description="Schema version. Current: 1.")
    sources: dict[str, SourceConfig] = Field(
        description="Map of source key (e.g. 'pflow-truck') -> SourceConfig."
    )
    pois: dict[str, PoiConfig] | None = Field(
        default=None,
        description="Optional map of POI layer key -> PoiConfig.",
    )
    zones: dict[str, ZoneConfig] | None = Field(
        default=None,
        description="Optional map of zone/polygon layer key -> ZoneConfig.",
    )
    time: TimeConfig | None = Field(
        default=None,
        description="Optional top-level default epoch anchor for all sources.",
    )

    @model_validator(mode="after")
    def _validate_version(self) -> SourcesFile:
        if self.version != 1:
            raise ValueError(
                f"Unsupported sources.yaml schema version {self.version}. "
                f"This build expects version 1."
            )
        return self

    @model_validator(mode="after")
    def _validate_single_epoch_anchor(self) -> SourcesFile:
        """At most one distinct epoch_anchor across the whole file.

        The anchor is per-DB (viz_meta), not per-source — mixing anchors would
        make mod-86400 animation math inconsistent between sources.
        """
        anchors: set[str] = set()
        if self.time is not None and self.time.epoch_anchor is not None:
            _validate_epoch_anchor(self.time.epoch_anchor)
            anchors.add(self.time.epoch_anchor)
        for src in self.sources.values():
            if src.time is not None and src.time.epoch_anchor is not None:
                anchors.add(src.time.epoch_anchor)
        if len(anchors) > 1:
            raise ValueError(
                f"Multiple distinct epoch_anchor values {sorted(anchors)} — at most "
                f"one anchor per sources.yaml (per database) is allowed."
            )
        return self


def load_sources(path: Path | str) -> SourcesFile:
    """Load and validate a sources.yaml file. Raises ValidationError on bad input."""
    path = Path(path)
    if not path.is_file():
        raise FileNotFoundError(f"sources.yaml not found: {path}")
    with open(path, encoding="utf-8") as fh:
        raw = yaml.safe_load(fh)
    return SourcesFile.model_validate(raw)


def load_sources_merged(
    primary: Path | str, uploads: Path | str | None = None
) -> SourcesFile:
    """Load the primary sources.yaml merged with the uploads registry.

    `uploads` defaults to config.uploads_registry_path(); when that path
    cannot be resolved (standalone test envs without PFLOW_VIZ_DB/PFLOW_HOME)
    or the file does not exist, the primary file alone is returned.

    Upload entries win on key collision. Both files are validated individually
    (upload blocks are validated at generation time and again here); the MERGED
    document is constructed via model_construct to skip cross-file validators
    (single-epoch-anchor) — this is a display-only read path (style/POI hints),
    not an ingest path.
    """
    base = load_sources(primary)
    if uploads is None:
        try:
            from backend.config import uploads_registry_path

            uploads = uploads_registry_path()
        except Exception:
            uploads = None
    if uploads is None or not Path(uploads).is_file():
        return base
    up = load_sources(uploads)
    sources = {**base.sources, **up.sources}
    pois = {**(base.pois or {}), **(up.pois or {})}
    zones = {**(base.zones or {}), **(up.zones or {})}
    return SourcesFile.model_construct(
        version=base.version,
        sources=sources,
        pois=pois or None,
        zones=zones or None,
        time=base.time or up.time,
    )


def default_sources_path() -> Path:
    """Default location of sources.yaml.

    Priority:
      1. PFLOW_VIZ_SOURCES env var (absolute path)
      2. ./sources.yaml relative to the project root (one level above backend/)
    """
    env = os.environ.get("PFLOW_VIZ_SOURCES")
    if env:
        return Path(env)
    return Path(__file__).resolve().parent.parent / "sources.yaml"


def dryrun_discovery(sources: SourcesFile, output_root: Path) -> dict[str, int]:
    """Count matching files per source (and POI layer) under output_root.

    Returns {source_key: matched_file_count}. For each source the count covers
    both the trips glob and the trajectories glob (any format). POI layers are
    reported under a `poi:<key>` key. Zero counts indicate the glob matches no
    files on disk — usually a sign of a misconfigured PFLOW_VIZ_OUTPUT_ROOT or
    stale glob pattern.
    """
    counts: dict[str, int] = {}
    for key, src in sources.sources.items():
        n = 0
        if src.discovery.trips_glob:
            n += len(glob(str(output_root / src.discovery.trips_glob)))
        if src.discovery.trajectories_glob:
            n += len(glob(str(output_root / src.discovery.trajectories_glob)))
        counts[key] = n
    for key, poi in (sources.pois or {}).items():
        counts[f"poi:{key}"] = len(glob(str(output_root / poi.glob)))
    for key, zone in (sources.zones or {}).items():
        counts[f"zone:{key}"] = len(glob(str(output_root / zone.glob)))
    return counts


# --- CLI ----------------------------------------------------------------


_EXAMPLE_YAML = """\
version: 1
sources:
  pflow-truck:
    label: "PFLOW Truck (Kanto)"
    source_id: truck
    discovery:
      trips_glob: "trips/truck/run_*/trips_pseudo_pflow.csv"
      trajectories_glob: "trajectory/truck/**/waypoints.csv"
      latest_only: true
      validation_relative: "validation.csv"
    vehicle_key_template: "truck:{vehicle_id}"
    columns:
      trip_id_col: id
      vehicle_id_col: truck_id
      trips:
        starttime:       { csv: starttime,      type: int }
        start_lon:       { csv: start_lon,      type: double }
        start_lat:       { csv: start_lat,      type: double }
        end_lon:         { csv: end_lon,        type: double }
        end_lat:         { csv: end_lat,        type: double }
        transport_mode:  { csv: transport_mode, type: int }
        purpose:         { csv: purpose,        type: int }
        distance_km:     { csv: distance_km,    type: double }
        dep_hour:        { derived: "CAST(starttime / 3600 AS INTEGER)" }
        simulation_day:  { csv: sim_day,        type: int }
        goods_type:      { csv: goods_type,     type: varchar }
        vehicle_size:    { csv: vehicle_size,   type: varchar }
        cargo_loaded:    { csv: cargo_loaded,   type: bool, transform: "lower(value) = 'true'" }
      waypoints:
        unix_time_ms:    { csv: unix_time_ms,   type: bigint }
        lon:             { csv: lon,            type: double }
        lat:             { csv: lat,            type: double }
        link_id:         { csv: link_id,        type: varchar }
        transport_mode:  { csv: transport_mode, type: int }
        purpose:         { csv: purpose,        type: int }
        goods_type:      { csv: goods_type,     type: varchar }
        vehicle_size:    { csv: vehicle_size,   type: varchar }

  pflow-taxi-tokyo:
    label: "Tokyo Taxi"
    source_id: taxi
    discovery:
      trips_glob: "trips/taxi/tokyo/run_*/trips_pseudo_pflow.csv"
      trajectories_glob: "trajectory/taxi/tokyo/**/waypoints.csv"
      latest_only: true
      scope: { value: tokyo }
      validation_relative: "validation.csv"
    vehicle_key_template: "taxi:{scope}:{vehicle_id}"
    columns:
      trip_id_col: id
      vehicle_id_col: taxi_id
      trips:
        starttime:       { csv: starttime,      type: int }
        start_lon:       { csv: start_lon,      type: double }
        start_lat:       { csv: start_lat,      type: double }
        end_lon:         { csv: end_lon,        type: double }
        end_lat:         { csv: end_lat,        type: double }
        transport_mode:  { csv: transport_mode, type: int }
        purpose:         { csv: purpose,        type: int }
        distance_km:     { csv: distance_km,    type: double }
        dep_hour:        { derived: "CAST(EXTRACT(HOUR FROM CAST(starttime_h AS TIMESTAMP)) AS INTEGER)" }
        simulation_day:  { csv: simulation_day, type: int }
        fare_yen:        { csv: fare_yen,       type: double }
        is_night_trip:   { csv: is_night_trip,  type: bool, transform: "lower(value) = 'true'" }
        passenger_in:    { csv: passenger_in,   type: bool, transform: "lower(value) = 'true'" }
      waypoints:
        unix_time_ms:    { csv: unix_time_ms,   type: bigint }
        lon:             { csv: lon,            type: double }
        lat:             { csv: lat,            type: double }
        link_id:         { csv: link_id,        type: varchar }
        transport_mode:  { csv: transport_mode, type: int }
        purpose:         { csv: purpose,        type: int }
        passenger_in:    { csv: passenger_in,   type: varchar }
        fare_yen:        { csv: fare_yen,       type: double }
        is_night_trip:   { csv: is_night_trip,  type: varchar }

  # ── Universal source: GPX courier tracks, no trip boundaries ──────────────
  # Points-only source (no trips_glob): trips are synthesized from waypoints
  # at ingest via gap_split (a new trip after each >30 min gap).
  couriers:
    label: "Bike Couriers (GPX)"
    source_id: courier
    discovery:
      trajectories_glob: "couriers/**/*.gpx"
      latest_only: false
    vehicle_key_template: "courier:{vehicle_id}"
    trips_synthesis: { strategy: gap_split, gap_minutes: 30 }
    render:
      mode: trails
      color: [255, 200, 60]
    columns:
      vehicle_id_col: _trk_name
      waypoints:
        unix_time_ms:    { csv: _time_ms, type: bigint }
        lon:             { csv: _lon,     type: double }
        lat:             { csv: _lat,     type: double }

# Static POI layers (restaurants, stations, ...) served via /api/pois.
pois:
  stations:
    label: "Train Stations"
    glob: "pois/stations.geojson"
    color: [90, 120, 255]
    columns:
      name:     { csv: name,     type: varchar }
      category: { derived: "'station'" }
      lon:      { csv: _lon,     type: double }
      lat:      { csv: _lat,     type: double }
zones:
  wards:
    label: "Service Wards"
    glob: "zones/wards.geojson"
    color: [120, 200, 160]
    columns:
      name:     { csv: name,     type: varchar }
"""


def _print_example() -> None:
    print(_EXAMPLE_YAML, end="")


def _cli_validate(path: str) -> int:
    try:
        sources = load_sources(path)
    except FileNotFoundError as e:
        print(f"[ERROR] {e}", file=sys.stderr)
        return 2
    except ValidationError as e:
        print("[ERROR] sources.yaml is invalid:", file=sys.stderr)
        print(e, file=sys.stderr)
        return 1
    except yaml.YAMLError as e:
        print(f"[ERROR] YAML parse error: {e}", file=sys.stderr)
        return 1

    print(f"OK: {path} (schema version {sources.version})")
    print(f"Sources ({len(sources.sources)}):")
    for key, src in sources.sources.items():
        scope = f", scope={src.discovery.scope.value}" if src.discovery.scope else ""
        synth = ", trips=synthesized" if src.trips_synthesis else ""
        print(f"  {key:25} source_id={src.source_id:8}  {src.label!r}{scope}{synth}")
    if sources.pois:
        print(f"POI layers ({len(sources.pois)}):")
        for key, poi in sources.pois.items():
            print(f"  {key:25} {poi.label!r}")
    if sources.zones:
        print(f"Zone layers ({len(sources.zones)}):")
        for key, zone in sources.zones.items():
            print(f"  {key:25} {zone.label!r}")
    return 0


def _cli_discovery(path: str, output_root_str: str | None) -> int:
    rc = _cli_validate(path)
    if rc != 0:
        return rc
    sources = load_sources(path)
    if output_root_str is None:
        output_root_str = os.environ.get("PFLOW_VIZ_OUTPUT_ROOT")
    if output_root_str is None:
        print(
            "[ERROR] --output-root not given and PFLOW_VIZ_OUTPUT_ROOT not set",
            file=sys.stderr,
        )
        return 2
    output_root = Path(output_root_str)
    counts = dryrun_discovery(sources, output_root)
    print(f"\nDiscovery (under {output_root}):")
    any_zero = False
    for key, n in counts.items():
        marker = " (WARNING: no matches)" if n == 0 else ""
        any_zero = any_zero or (n == 0)
        print(f"  {key:25} {n} CSV file(s){marker}")
    return 0 if not any_zero else 3


def main() -> None:
    parser = argparse.ArgumentParser(description="Validate sources.yaml.")
    parser.add_argument(
        "--validate", type=str, metavar="PATH", help="Validate a sources.yaml file."
    )
    parser.add_argument(
        "--discovery",
        type=str,
        metavar="PATH",
        help="Validate + dry-run glob discovery against PFLOW_VIZ_OUTPUT_ROOT.",
    )
    parser.add_argument(
        "--output-root",
        type=str,
        default=None,
        help="Override PFLOW_VIZ_OUTPUT_ROOT for --discovery.",
    )
    parser.add_argument(
        "--print-example",
        action="store_true",
        help="Print an example sources.yaml to stdout.",
    )
    args = parser.parse_args()

    if args.print_example:
        _print_example()
        sys.exit(0)
    if args.validate:
        sys.exit(_cli_validate(args.validate))
    if args.discovery:
        sys.exit(_cli_discovery(args.discovery, args.output_root))
    parser.print_help()
    sys.exit(2)


if __name__ == "__main__":
    main()

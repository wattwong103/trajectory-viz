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
from typing import Literal, Optional

import yaml
from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator


# DuckDB types we accept in column specs.
ColumnType = Literal["int", "bigint", "double", "varchar", "bool"]


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

    csv: Optional[str] = Field(
        default=None,
        description="CSV column name to read (when not a derived column).",
    )
    type: Optional[ColumnType] = Field(
        default=None,
        description="DuckDB type (int|bigint|double|varchar|bool). Required if `csv` is set.",
    )
    transform: Optional[str] = Field(
        default=None,
        description=(
            "Optional SQL expression applied to the CSV column. "
            "Use `value` as the placeholder for the CSV column reference. "
            "Example for boolean coercion: \"lower(value) = 'true'\"."
        ),
    )
    derived: Optional[str] = Field(
        default=None,
        description=(
            "SQL expression computed from other CSV columns. "
            "Mutually exclusive with `csv`/`transform`. "
            "Example: \"CAST(starttime / 3600 AS INTEGER)\"."
        ),
    )

    @model_validator(mode="after")
    def _exactly_one_source(self) -> "ColumnSpec":
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
    color: Optional[tuple[int, int, int]] = Field(
        default=None,
        description="RGB color triple (0-255 each). Omit for palette fallback.",
    )

    @model_validator(mode="after")
    def _validate_color_range(self) -> "RenderConfig":
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
    """How to discover CSVs on disk for this source."""

    model_config = ConfigDict(extra="forbid")

    trips_glob: str = Field(
        description=(
            "Glob (relative to PFLOW_VIZ_OUTPUT_ROOT) matching this source's "
            "trip CSVs. Example: 'trips/truck/run_*/trips_pseudo_pflow.csv'."
        )
    )
    trajectories_glob: Optional[str] = Field(
        default=None,
        description="Glob for trajectory/waypoint CSVs. Optional.",
    )
    latest_only: bool = Field(
        default=True,
        description="If True, use only the most recent matching run_* directory.",
    )
    scope: Optional[ScopeConfig] = Field(
        default=None,
        description="Optional scope value (used in vehicle_key_template and city column).",
    )
    validation_relative: Optional[str] = Field(
        default=None,
        description=(
            "Filename of the validation CSV relative to each trips CSV's directory. "
            "Example: 'validation.csv'."
        ),
    )


class ColumnsConfig(BaseModel):
    """Column mapping for this source."""

    model_config = ConfigDict(extra="forbid")

    trip_id_col: str = Field(
        description="CSV column whose value becomes trips.trip_id."
    )
    vehicle_id_col: str = Field(
        description="CSV column whose value becomes trips.vehicle_id."
    )
    trips: dict[str, ColumnSpec] = Field(
        description="Map of DB column name -> ColumnSpec for the `trips` table."
    )
    waypoints: Optional[dict[str, ColumnSpec]] = Field(
        default=None,
        description="Map of DB column name -> ColumnSpec for the `waypoints` table.",
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
    render: Optional[RenderConfig] = Field(
        default=None,
        description="Optional frontend rendering hints (mode + color).",
    )

    @model_validator(mode="after")
    def _validate_template(self) -> "SourceConfig":
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
    def _validate_required_columns(self) -> "SourceConfig":
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


class SourcesFile(BaseModel):
    """Top-level structure of sources.yaml."""

    model_config = ConfigDict(extra="forbid")

    version: int = Field(description="Schema version. Current: 1.")
    sources: dict[str, SourceConfig] = Field(
        description="Map of source key (e.g. 'pflow-truck') -> SourceConfig."
    )

    @model_validator(mode="after")
    def _validate_version(self) -> "SourcesFile":
        if self.version != 1:
            raise ValueError(
                f"Unsupported sources.yaml schema version {self.version}. "
                f"This build expects version 1."
            )
        return self


def load_sources(path: Path | str) -> SourcesFile:
    """Load and validate a sources.yaml file. Raises ValidationError on bad input."""
    path = Path(path)
    if not path.is_file():
        raise FileNotFoundError(f"sources.yaml not found: {path}")
    with open(path, "r", encoding="utf-8") as fh:
        raw = yaml.safe_load(fh)
    return SourcesFile.model_validate(raw)


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
    """For each source, count matching trip CSVs under output_root.

    Returns {source_key: matched_csv_count}. Zero counts indicate the source's
    `trips_glob` matches no files on disk — usually a sign of a misconfigured
    PFLOW_VIZ_OUTPUT_ROOT or stale glob pattern.
    """
    counts: dict[str, int] = {}
    for key, src in sources.sources.items():
        pattern = str(output_root / src.discovery.trips_glob)
        matches = glob(pattern)
        counts[key] = len(matches)
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
        print(f"[ERROR] sources.yaml is invalid:", file=sys.stderr)
        print(e, file=sys.stderr)
        return 1
    except yaml.YAMLError as e:
        print(f"[ERROR] YAML parse error: {e}", file=sys.stderr)
        return 1

    print(f"OK: {path} (schema version {sources.version})")
    print(f"Sources ({len(sources.sources)}):")
    for key, src in sources.sources.items():
        scope = f", scope={src.discovery.scope.value}" if src.discovery.scope else ""
        print(f"  {key:25} source_id={src.source_id:8}  {src.label!r}{scope}")
    return 0


def _cli_discovery(path: str, output_root_str: Optional[str]) -> int:
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

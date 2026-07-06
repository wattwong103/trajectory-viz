"""
Bake a per-city building binary for the 3D night scene (Phase 2C).

Two input modes:

  PLATEAU GeoJSON (real footprints + measured heights):
    python scripts/build_buildings.py --city tokyo \
        --plateau-geojson "downloads/plateau/*.geojson" \
        --bbox 139.55 35.53 139.92 35.82 \
        --out output/viz/buildings/tokyo.bin

  city_tatemono.csv fallback (synthesized squares, heuristic heights —
  for cities PLATEAU doesn't cover; flagged `synthesized` in the header):
    python scripts/build_buildings.py --city nagoya \
        --tatemono H:/Dropbox/PFLOW/data/facilities/city_tatemono.csv \
        --city-codes 23101,23102 --bbox 136.8 35.0 137.1 35.3 \
        --out output/viz/buildings/nagoya.bin

The output is served by GET /api/buildings/{city} and embedded verbatim in
the Phase 2D single-HTML export. Format: backend/buildings_io.py (PBLD).
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from glob import glob
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.buildings_io import (  # noqa: E402
    Building,
    BuildingSet,
    clip_bbox,
    pack,
    ring_area_m2,
    sample_buildings,
    synthesize_from_tatemono,
)

# PLATEAU GeoJSON exports name the height attribute inconsistently across
# tools/years — probe these in order.
HEIGHT_ATTRS = ("measuredHeight", "bldg:measuredHeight", "measured_height", "height", "z")


def load_plateau_geojson(patterns: list[str]) -> list[Building]:
    buildings: list[Building] = []
    files = [p for pat in patterns for p in glob(pat, recursive=True)]
    if not files:
        raise SystemExit(f"[ERROR] No GeoJSON matched: {patterns}")
    for path in files:
        print(f"[read] {path}")
        with open(path, encoding="utf-8") as fh:
            gj = json.load(fh)
        for feat in gj.get("features", []):
            geom = feat.get("geometry") or {}
            props = feat.get("properties") or {}
            height = None
            for attr in HEIGHT_ATTRS:
                v = props.get(attr)
                if v is not None:
                    try:
                        height = float(str(v).split(";")[0])
                        break
                    except ValueError:
                        continue
            if height is None or height <= 0.5:
                height = 8.0  # missing/degenerate height → low-rise default
            polys = []
            if geom.get("type") == "Polygon":
                polys = [geom["coordinates"]]
            elif geom.get("type") == "MultiPolygon":
                polys = geom["coordinates"]
            for poly in polys:
                rings = []
                for ring in poly:
                    pts = [(float(p[0]), float(p[1])) for p in ring]
                    # Drop the GeoJSON closing duplicate + consecutive dups
                    if len(pts) > 1 and pts[0] == pts[-1]:
                        pts = pts[:-1]
                    deduped = [pts[0]] if pts else []
                    for p in pts[1:]:
                        if p != deduped[-1]:
                            deduped.append(p)
                    if len(deduped) >= 3:
                        rings.append(deduped)
                if rings:
                    buildings.append(Building(rings=rings, height_m=height))
    return buildings


def load_tatemono(csv_path: str, city_codes: list[str], bbox: tuple[float, float, float, float]) -> list[Building]:
    """Stream the 2GB tatemono CSV through DuckDB, filtered before Python."""
    import duckdb
    w, s, e, n = bbox
    code_filter = ""
    if city_codes:
        codes = ", ".join(f"'{c}'" for c in city_codes if c.isdigit())
        code_filter = f"AND CAST(n03_007 AS VARCHAR) IN ({codes})"
    rows = duckdb.execute(f"""
        SELECT x, y, area
        FROM read_csv('{Path(csv_path).as_posix()}', header=true, auto_detect=true)
        WHERE x BETWEEN {w} AND {e} AND y BETWEEN {s} AND {n} {code_filter}
    """).fetchall()
    print(f"[read] {len(rows):,} tatemono centroids in bbox")
    return synthesize_from_tatemono([(r[0], r[1], r[2]) for r in rows])


def main() -> None:
    ap = argparse.ArgumentParser(description="Bake a per-city building .bin (PBLD)")
    ap.add_argument("--city", required=True, help="City key, e.g. tokyo (^[a-z_]+$)")
    ap.add_argument("--bbox", nargs=4, type=float, metavar=("W", "S", "E", "N"), required=True)
    ap.add_argument("--plateau-geojson", nargs="*", default=None,
                    help="Glob(s) of PLATEAU GeoJSON files (real heights)")
    ap.add_argument("--tatemono", default=None,
                    help="Path to city_tatemono.csv (synthesized fallback)")
    ap.add_argument("--city-codes", default="",
                    help="Comma-separated n03_007 codes to keep (tatemono mode)")
    ap.add_argument("--max-buildings", type=int, default=300_000)
    ap.add_argument("--min-area-m2", type=float, default=25.0)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    t0 = time.time()
    if args.plateau_geojson:
        buildings = load_plateau_geojson(args.plateau_geojson)
        source, synthesized = "plateau", False
    elif args.tatemono:
        codes = [c.strip() for c in args.city_codes.split(",") if c.strip()]
        buildings = load_tatemono(args.tatemono, codes, tuple(args.bbox))
        source, synthesized = "tatemono-synthesized", True
    else:
        raise SystemExit("[ERROR] Provide --plateau-geojson or --tatemono.")

    print(f"[load] {len(buildings):,} buildings")
    buildings = clip_bbox(buildings, *args.bbox)
    buildings = [b for b in buildings if ring_area_m2(b.outer()) >= args.min_area_m2]
    print(f"[clip] {len(buildings):,} after bbox + ≥{args.min_area_m2} m² filter")
    buildings = sample_buildings(buildings, args.max_buildings)
    print(f"[cap]  {len(buildings):,} after --max-buildings {args.max_buildings:,}")

    bset = BuildingSet(
        buildings=buildings, city=args.city,
        source=source, heights_synthesized=synthesized,
    )
    data = pack(bset)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(data)
    print(f"[done] {out} — {len(data)/1024/1024:.2f} MB, "
          f"{len(buildings):,} buildings in {time.time()-t0:.1f}s")


if __name__ == "__main__":
    main()

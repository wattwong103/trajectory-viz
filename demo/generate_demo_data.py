#!/usr/bin/env python3
"""
Deterministic generator for the committed trajectory-viz demo dataset.

Produces a small (< 2 MB) synthetic day of movement around Kichijōji, Tokyo
(bbox ~139.55-139.60E, 35.69-35.71N), exercising every universal-ingest path:

    demo/gps/couriers/*.gpx     12 bike-courier GPX 1.1 tracks, one day each,
                                with a >25 min lunch break so the gap_split
                                trip synthesis (gap_minutes=20) yields 2 trips
                                per courier. Time offsets alternate between
                                'Z' (UTC) and '+09:00' across files.
    demo/transit/buses.geojson  6 bus LineStrings with a per-coordinate
                                'coordTimes' ISO property + 'bus_id'.
    demo/pois/stations.geojson  40 Point POIs in 3 categories
                                (station / mall / park) with name + category.

Everything is seeded (random.Random(SEED)) so re-running reproduces the
committed files byte-for-byte. Run from anywhere:

    python demo/generate_demo_data.py
"""

from __future__ import annotations

import argparse
import json
import random
from datetime import UTC, datetime, timedelta, timezone
from pathlib import Path

SEED = 20240301

# Kichijōji-ish bounding box.
LON_MIN, LON_MAX = 139.550, 139.600
LAT_MIN, LAT_MAX = 35.690, 35.710

# Demo day: the epoch anchor declared in demo/sources.demo.yaml.
DAY = datetime(2024, 3, 1, tzinfo=timezone(timedelta(hours=9)))  # JST midnight
JST = timezone(timedelta(hours=9))

N_COURIERS = 12
N_BUSES = 6
POI_COUNTS = {"station": 8, "mall": 14, "park": 18}

_STATION_NAMES = [
    "Kichijoji", "Mitaka", "Musashi-Sakai", "Higashi-Koganei",
    "Nishi-Ogikubo", "Inokashira-Koen", "Kugayama", "Fujimigaoka",
]
_MALL_NAMES = [
    "Atre Kichijoji", "Coppice Kichijoji", "Sun Road Shotengai", "Harmonica Yokocho",
    "Kichijoji PARCO", "Lumine Musashi", "Marui Kichijoji", "Daiya-gai Arcade",
    "Musashino Place", "Kichijoji Tokyu", "Yodobashi Annex", "Sunroad North",
    "Inokashira-dori Shops", "Zenpukuji Market",
]
_PARK_NAMES = [
    "Inokashira Park", "Zenpukuji Park", "Musashino Central Park", "Koganei Green",
    "Nogawa Riverside", "Sengawa Green", "Tamagawa Josui Path", "Inokashira Pond West",
    "Musashi-Sakai Pocket Park", "Kichijoji Children Park", "Osawa Community Green",
    "Fujimigaoka Playground", "Kugayama Shrine Grove", "Igusa Hachiman Woods",
    "Shinkawa Canal Walk", "Myoshoji River Green", "Matsunoki Park", "Sakuragaoka Court",
]


def _iso(dt: datetime, style: str) -> str:
    """Format an aware datetime as ISO-8601 in the requested offset style."""
    if style == "Z":
        return dt.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    return dt.astimezone(JST).isoformat(timespec="seconds")


def _walk(rng: random.Random, start: tuple[float, float], steps: int) -> list[tuple[float, float]]:
    """Reflecting random walk inside the bbox. ~0.0009°/step ≈ 90 m — bike pace."""
    lon, lat = start
    pts: list[tuple[float, float]] = []
    heading = rng.uniform(0, 360)
    for _ in range(steps):
        heading += rng.uniform(-70, 70)
        import math

        rad = math.radians(heading)
        lon += 0.0009 * math.cos(rad)
        lat += 0.0009 * math.sin(rad) * 1.25  # lat degrees are ~111 km vs ~91 km
        if not (LON_MIN < lon < LON_MAX):
            heading = 180 - heading
            lon = min(max(lon, LON_MIN + 1e-4), LON_MAX - 1e-4)
        if not (LAT_MIN < lat < LAT_MAX):
            heading = -heading
            lat = min(max(lat, LAT_MIN + 1e-4), LAT_MAX - 1e-4)
        pts.append((lon, lat))
    return pts


def _gpx_track(
    rng: random.Random,
    name: str,
    offset_style: str,
) -> str:
    """One courier day: morning leg, >25 min lunch gap, afternoon leg."""
    home = (rng.uniform(LON_MIN, LON_MAX), rng.uniform(LAT_MIN, LAT_MAX))
    start = DAY + timedelta(minutes=rng.randint(390, 480))  # 06:30-08:00 JST
    step_s = rng.choice([45, 50, 60])
    morning_n = rng.randint(100, 130)  # ~75-130 min
    lunch_min = rng.randint(30, 50)  # > 25 min → gap_split(20) splits
    afternoon_n = rng.randint(100, 130)

    legs: list[tuple[datetime, list[tuple[float, float]]]] = []
    t = start
    leg1 = _walk(rng, home, morning_n)
    legs.append((t, leg1))
    t += timedelta(seconds=step_s * morning_n + lunch_min * 60)
    leg2 = _walk(rng, leg1[-1], afternoon_n)
    legs.append((t, leg2))

    lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<gpx version="1.1" creator="trajectory-viz demo" '
        'xmlns="http://www.topografix.com/GPX/1/1">',
        "  <trk>",
        f"    <name>{name}</name>",
        "    <trkseg>",
    ]
    for leg_start, pts in legs:
        for i, (lon, lat) in enumerate(pts):
            ts = leg_start + timedelta(seconds=step_s * i)
            lines.append(f'      <trkpt lat="{lat:.6f}" lon="{lon:.6f}">')
            lines.append(f"        <time>{_iso(ts, offset_style)}</time>")
            lines.append("      </trkpt>")
    lines += ["    </trkseg>", "  </trk>", "</gpx>", ""]
    return "\n".join(lines)


def _bus_route(rng: random.Random, idx: int) -> dict:
    """One bus loop: ~40 stops-worth of coords, 60 s apart, morning service."""
    n = rng.randint(36, 44)
    start = DAY + timedelta(hours=6, minutes=30 + idx * 12)
    # Gentle elongated loop so routes look road-like.
    import math

    cx = rng.uniform(LON_MIN + 0.012, LON_MAX - 0.012)
    cy = rng.uniform(LAT_MIN + 0.005, LAT_MAX - 0.005)
    rx, ry = rng.uniform(0.006, 0.010), rng.uniform(0.003, 0.006)
    phase = rng.uniform(0, 2 * math.pi)
    coords = [
        [
            round(cx + rx * math.cos(phase + 2 * math.pi * i / n), 6),
            round(cy + ry * math.sin(phase + 2 * math.pi * i / n), 6),
        ]
        for i in range(n)
    ]
    times = [_iso(start + timedelta(minutes=i), "+09:00") for i in range(n)]
    return {
        "type": "Feature",
        "geometry": {"type": "LineString", "coordinates": coords},
        "properties": {"bus_id": f"bus-{idx + 1:02d}", "coordTimes": times},
    }


def _poi(rng: random.Random, name: str, category: str) -> dict:
    return {
        "type": "Feature",
        "geometry": {
            "type": "Point",
            "coordinates": [
                round(rng.uniform(LON_MIN, LON_MAX), 6),
                round(rng.uniform(LAT_MIN, LAT_MAX), 6),
            ],
        },
        "properties": {"name": name, "category": category},
    }


def generate(out_dir: Path) -> dict[str, int]:
    rng = random.Random(SEED)
    stats: dict[str, int] = {}

    courier_dir = out_dir / "gps" / "couriers"
    courier_dir.mkdir(parents=True, exist_ok=True)
    n_trkpts = 0
    for i in range(N_COURIERS):
        name = f"courier-{i + 1:02d}"
        style = "Z" if i % 2 else "+09:00"  # alternate offsets across files
        gpx = _gpx_track(rng, name, style)
        (courier_dir / f"{name}.gpx").write_text(gpx, encoding="utf-8", newline="\n")
        n_trkpts += gpx.count("<trkpt")
    stats["courier_trkpts"] = n_trkpts

    transit_dir = out_dir / "transit"
    transit_dir.mkdir(parents=True, exist_ok=True)
    buses = {
        "type": "FeatureCollection",
        "features": [_bus_route(rng, i) for i in range(N_BUSES)],
    }
    (transit_dir / "buses.geojson").write_text(
        json.dumps(buses, ensure_ascii=False, indent=1) + "\n", encoding="utf-8"
    )
    stats["bus_coords"] = sum(len(f["geometry"]["coordinates"]) for f in buses["features"])

    poi_dir = out_dir / "pois"
    poi_dir.mkdir(parents=True, exist_ok=True)
    pools = {"station": _STATION_NAMES, "mall": _MALL_NAMES, "park": _PARK_NAMES}
    features = []
    for category, count in POI_COUNTS.items():
        for name in pools[category][:count]:
            features.append(_poi(rng, name, category))
    pois = {"type": "FeatureCollection", "features": features}
    (poi_dir / "stations.geojson").write_text(
        json.dumps(pois, ensure_ascii=False, indent=1) + "\n", encoding="utf-8"
    )
    stats["pois"] = len(features)
    return stats


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate the committed demo dataset.")
    parser.add_argument(
        "--out",
        type=Path,
        default=Path(__file__).resolve().parent,
        help="Output directory (default: the demo/ dir containing this script).",
    )
    args = parser.parse_args()

    stats = generate(args.out)
    total = sum(p.stat().st_size for p in args.out.rglob("*") if p.is_file())

    print(f"Demo dataset written to {args.out}")
    print(f"  Couriers:  {N_COURIERS} GPX tracks, {stats['courier_trkpts']} trkpts")
    print(f"  Buses:     {N_BUSES} LineStrings, {stats['bus_coords']} coords")
    print(f"  POIs:      {stats['pois']} points "
          f"({', '.join(f'{k}={v}' for k, v in POI_COUNTS.items())})")
    print(f"  Total size: {total / 1024:.0f} KB (budget: 2048 KB)")
    if total > 2 * 1024 * 1024:
        raise SystemExit("ERROR: demo dataset exceeds the 2 MB budget — shrink parameters.")


if __name__ == "__main__":
    main()

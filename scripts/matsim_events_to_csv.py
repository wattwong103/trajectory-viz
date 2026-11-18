#!/usr/bin/env python3
"""Thin MATSim events.xml → trips + geo-events CSV bridge.

No FormatType change — run this out-of-process, then ingest the CSVs with
docs/examples/sources-matsim.yaml (or your own column map).

Minimal event types handled:
  - activity end / departure  → trip start
  - activity start / arrival  → trip end
  - entered link / left link  → waypoint rows (link centroid if --network given)

Without a network file, link enter/leave events are skipped (trips-only arcs).
CRS: link coords are emitted as-is; convert to WGS84 upstream or post-process.

Usage:
  python scripts/matsim_events_to_csv.py events.xml -o out_dir [--network network.xml]
"""

from __future__ import annotations

import argparse
import csv
import xml.etree.ElementTree as ET
from collections import defaultdict
from pathlib import Path


def _attr(el: ET.Element, *names: str) -> str | None:
    for n in names:
        v = el.attrib.get(n)
        if v is not None and v != "":
            return v
    return None


def load_network_centroids(path: Path) -> dict[str, tuple[float, float]]:
    """Best-effort MATSim network.xml → link_id → (x, y) from from/to nodes midpoints."""
    tree = ET.parse(path)
    root = tree.getroot()
    nodes: dict[str, tuple[float, float]] = {}
    for node in root.iter():
        tag = node.tag.split("}")[-1] if "}" in node.tag else node.tag
        if tag != "node":
            continue
        nid = _attr(node, "id")
        x, y = _attr(node, "x"), _attr(node, "y")
        if nid and x is not None and y is not None:
            nodes[nid] = (float(x), float(y))
    centroids: dict[str, tuple[float, float]] = {}
    for link in root.iter():
        tag = link.tag.split("}")[-1] if "}" in link.tag else link.tag
        if tag != "link":
            continue
        lid = _attr(link, "id")
        frm, to = _attr(link, "from"), _attr(link, "to")
        if not lid or frm not in nodes or to not in nodes:
            continue
        x0, y0 = nodes[frm]
        x1, y1 = nodes[to]
        centroids[lid] = ((x0 + x1) / 2.0, (y0 + y1) / 2.0)
    return centroids


def convert(
    events_path: Path,
    out_dir: Path,
    network_path: Path | None = None,
    mode_default: str = "car",
) -> tuple[int, int]:
    centroids = load_network_centroids(network_path) if network_path else {}

    # person → list of open departures; completed trips; geo events
    open_dep: dict[str, dict] = {}
    trips: list[dict] = []
    geo: list[dict] = []
    trip_seq: dict[str, int] = defaultdict(int)

    # Stream parse
    for _event, el in ET.iterparse(events_path, events=("end",)):
        tag = el.tag.split("}")[-1] if "}" in el.tag else el.tag
        if tag != "event":
            el.clear()
            continue
        etype = _attr(el, "type") or ""
        time_s = float(_attr(el, "time") or 0.0)
        person = _attr(el, "person", "agent")
        vehicle = _attr(el, "vehicle")
        link = _attr(el, "link")
        mode = _attr(el, "legMode", "mode") or mode_default

        if etype in ("actend", "departure", "PersonDeparture") and person:
            open_dep[person] = {
                "time": time_s,
                "link": link,
                "mode": mode,
                "vehicle": vehicle,
            }
        elif etype in ("actstart", "arrival", "PersonArrival") and person:
            dep = open_dep.pop(person, None)
            trip_seq[person] += 1
            tid = trip_seq[person]
            start_t = int(dep["time"]) if dep else int(time_s)
            start_link = dep.get("link") if dep else None
            end_link = link
            sx = sy = ex = ey = None
            if start_link and start_link in centroids:
                sx, sy = centroids[start_link]
            if end_link and end_link in centroids:
                ex, ey = centroids[end_link]
            # Fallback: zero coords when network missing — arcs still ingestable
            # after user replaces with WGS84 endpoints.
            trips.append({
                "trip_id": tid,
                "person_id": person,
                "start_time_sec": start_t,
                "start_lon_wgs84": sx if sx is not None else 0.0,
                "start_lat_wgs84": sy if sy is not None else 0.0,
                "end_lon_wgs84": ex if ex is not None else 0.0,
                "end_lat_wgs84": ey if ey is not None else 0.0,
                "mode": dep.get("mode", mode) if dep else mode,
                "trip_length_m": "",
            })
        elif etype in ("entered link", "left link", "LinkEnterEvent", "LinkLeaveEvent"):
            agent = person or vehicle
            if not agent or not link or link not in centroids:
                el.clear()
                continue
            x, y = centroids[link]
            geo.append({
                "person_id": agent,
                "trip_id": trip_seq.get(agent) or 1,
                "time_ms": int(time_s * 1000),
                "lon_wgs84": x,
                "lat_wgs84": y,
                "link_id": link,
                "mode": mode,
            })
        el.clear()

    out_dir.mkdir(parents=True, exist_ok=True)
    trips_path = out_dir / "trips_car.csv"
    geo_path = out_dir / "events_car_geo.csv"

    with trips_path.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(
            f,
            fieldnames=[
                "trip_id", "person_id", "start_time_sec",
                "start_lon_wgs84", "start_lat_wgs84",
                "end_lon_wgs84", "end_lat_wgs84",
                "mode", "trip_length_m",
            ],
        )
        w.writeheader()
        w.writerows(trips)

    with geo_path.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(
            f,
            fieldnames=[
                "person_id", "trip_id", "time_ms",
                "lon_wgs84", "lat_wgs84", "link_id", "mode",
            ],
        )
        w.writeheader()
        w.writerows(geo)

    return len(trips), len(geo)


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("events", type=Path, help="MATSim events.xml")
    p.add_argument("-o", "--out-dir", type=Path, required=True)
    p.add_argument("--network", type=Path, default=None, help="Optional network.xml")
    p.add_argument("--mode-default", default="car")
    args = p.parse_args()
    n_trips, n_geo = convert(args.events, args.out_dir, args.network, args.mode_default)
    print(f"Wrote {n_trips} trips → {args.out_dir / 'trips_car.csv'}")
    print(f"Wrote {n_geo} geo events → {args.out_dir / 'events_car_geo.csv'}")


if __name__ == "__main__":
    main()

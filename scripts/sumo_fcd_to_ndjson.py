#!/usr/bin/env python3
"""Thin SUMO FCD XML → CSV / NDJSON pings bridge.

Prefer SUMO's native tabular FCD when possible (TraceExporter or
``--output.format csv|parquet``). Use this only for raw ``<fcd-export>`` XML.

Default output is **CSV** (matches docs/examples/sources-sumo-fcd.yaml preferred
path). Pass ``--format ndjson`` when you need line-delimited JSON.

Usage:
  python scripts/sumo_fcd_to_ndjson.py fcd.xml -o fcd.csv
  python scripts/sumo_fcd_to_ndjson.py fcd.xml -o fcd.ndjson --format ndjson \\
      --epoch-ms 1717200000000
"""

from __future__ import annotations

import argparse
import csv
import json
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any, Iterable, Literal

# SUMO vehicle type → canonical mode label (Phase C string mode).
TYPE_TO_MODE: dict[str, str] = {
    "passenger": "Car",
    "car": "Car",
    "bus": "Bus",
    "bicycle": "Bike",
    "bike": "Bike",
    "pedestrian": "Walk",
    "person": "Walk",
    "taxi": "Taxi",
    "truck": "Car",
    "trailer": "Car",
    "delivery": "Car",
}

ROW_FIELDS = ("id", "time_ms", "x", "y", "edge", "type", "mode", "speed")
OutputFormat = Literal["csv", "ndjson"]


def _attr(el: ET.Element, *names: str) -> str | None:
    for n in names:
        v = el.attrib.get(n)
        if v is not None and v != "":
            return v
    return None


def iter_fcd_rows(fcd_path: Path, epoch_ms: int = 0) -> Iterable[dict[str, Any]]:
    """Yield one ping dict per vehicle sample in FCD XML."""
    for _event, el in ET.iterparse(fcd_path, events=("end",)):
        tag = el.tag.split("}")[-1] if "}" in el.tag else el.tag
        if tag != "timestep":
            continue
        t_s = float(_attr(el, "time") or 0.0)
        time_ms = int(epoch_ms + t_s * 1000)
        for veh in list(el):
            vtag = veh.tag.split("}")[-1] if "}" in veh.tag else veh.tag
            if vtag != "vehicle":
                continue
            vid = _attr(veh, "id")
            x = _attr(veh, "x")
            y = _attr(veh, "y")
            if not vid or x is None or y is None:
                continue
            vtype = (_attr(veh, "type") or "passenger").lower()
            mode = TYPE_TO_MODE.get(vtype, vtype.title())
            # lane looks like "edge_0"; strip lane index for link_id when present.
            lane = _attr(veh, "lane") or ""
            edge = _attr(veh, "edge") or (lane.rsplit("_", 1)[0] if lane else "")
            yield {
                "id": vid,
                "time_ms": time_ms,
                "x": float(x),
                "y": float(y),
                "edge": edge,
                "type": vtype,
                "mode": mode,
                "speed": float(_attr(veh, "speed") or 0.0),
            }
        el.clear()


def convert(
    fcd_path: Path,
    out_path: Path,
    epoch_ms: int = 0,
    fmt: OutputFormat = "csv",
) -> int:
    """Parse FCD XML; write CSV or NDJSON pings. Returns row count."""
    n = 0
    out_path.parent.mkdir(parents=True, exist_ok=True)
    if fmt == "csv":
        with out_path.open("w", newline="", encoding="utf-8") as out:
            writer = csv.DictWriter(out, fieldnames=list(ROW_FIELDS))
            writer.writeheader()
            for row in iter_fcd_rows(fcd_path, epoch_ms):
                writer.writerow(row)
                n += 1
    else:
        with out_path.open("w", encoding="utf-8") as out:
            for row in iter_fcd_rows(fcd_path, epoch_ms):
                out.write(json.dumps(row, separators=(",", ":")) + "\n")
                n += 1
    return n


def _infer_format(out_path: Path, explicit: str | None) -> OutputFormat:
    if explicit in ("csv", "ndjson"):
        return explicit  # type: ignore[return-value]
    suffix = out_path.suffix.lower()
    if suffix in (".ndjson", ".jsonl"):
        return "ndjson"
    return "csv"


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("fcd", type=Path, help="SUMO FCD XML")
    p.add_argument("-o", "--out", type=Path, required=True)
    p.add_argument(
        "--format",
        choices=("csv", "ndjson"),
        default=None,
        help="Output format (default: infer from -o suffix, else csv).",
    )
    p.add_argument(
        "--epoch-ms",
        type=int,
        default=0,
        help="Absolute epoch ms added to FCD sim-time (default 0 = relative ms).",
    )
    args = p.parse_args()
    fmt = _infer_format(args.out, args.format)
    n = convert(args.fcd, args.out, args.epoch_ms, fmt)
    print(f"Wrote {n} pings ({fmt}) → {args.out}")


if __name__ == "__main__":
    main()

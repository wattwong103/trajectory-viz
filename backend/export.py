"""
Single-HTML cinematic export (Phase 2D).

Packs a filtered sample of trajectories (plus optional pulse-heatmap hours,
baked buildings, and followed agents) with an inlined deck.gl bundle into ONE
self-contained HTML file — dark ground plane instead of a basemap, so the
result makes zero network requests at runtime and can be mailed to anyone.

Usage:
    viz-export --preset presets/tokyo-night.yaml --out exports/tokyo-night.html
    viz-export --vehicle-type taxi --city tokyo --n 2000 --out taxi.html

The deck.gl vendor bundle must be fetched once first:
    python scripts/fetch_vendor.py

Data encoding mirrors the Phase 2C buildings format: coordinates quantized to
1e-5° (~1.1 m) relative to a data-derived origin, first vertex Int32, then
Int16 deltas (segments that would overflow Int16 are subdivided); timestamps
as Uint32 start + Uint16 second-deltas. Each typed array is base64-encoded
separately into a `const P = {...}` payload the template decodes.
"""

from __future__ import annotations

import argparse
import base64
import json
import struct
import sys
import time
from pathlib import Path
from typing import Optional

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.config import BASE_EPOCH_SEC, get_viz_db_path  # noqa: E402
from backend.trajectory_queries import (  # noqa: E402
    sample_waypoint_rows,
    waypoint_rows_for_vehicles,
)

PROJECT_ROOT = Path(__file__).resolve().parent.parent
TEMPLATE_PATH = Path(__file__).resolve().parent / "export_template.html"
DEFAULT_VENDOR = PROJECT_ROOT / "scripts" / "vendor" / "deck.gl.min.js"

SCALE_DEG = 1e-5
DATA_BUDGET_WARN_MB = 4.0
TOTAL_BUDGET_FAIL_MB = 8.0

# Fallback source colors when sources.yaml is unavailable (standalone DB).
DEFAULT_COLORS: dict[str, tuple[int, int, int]] = {
    "truck": (253, 128, 93),
    "taxi": (23, 184, 190),
    "person": (43, 200, 80),
}


def _b64(fmt: str, values: list) -> str:
    return base64.b64encode(struct.pack(f"<{len(values)}{fmt}", *values)).decode("ascii")


# --- Row grouping --------------------------------------------------------------


def rows_to_simple_trajectories(rows: list, is_agent: bool = False) -> list[dict]:
    """Group waypoint rows (WAYPOINT_COLS order) into plain dicts for packing."""
    trips: dict[tuple, list] = {}
    for r in rows:
        trips.setdefault((r[0], r[1]), []).append(r)
    out = []
    for (_vid, _tid), wps in trips.items():
        wps.sort(key=lambda w: w[2])
        if len(wps) < 2:
            continue
        out.append({
            "path": [(w[3], w[4]) for w in wps],
            "timestamps": [int((w[2] // 1000 - BASE_EPOCH_SEC) % 86400) for w in wps],
            "source_id": wps[0][5] or "unknown",
            "vehicle_key": wps[0][12] or "",
            "agent": is_agent,
        })
    return out


# --- Packing --------------------------------------------------------------------


def _subdivide(path: list, timestamps: list) -> tuple[list, list]:
    """Insert midpoints wherever a segment's quantized delta would overflow
    Int16 (±32767 units = ±0.33° ≈ 36 km). Rare — ferry hops, data glitches."""
    limit = 32000 * SCALE_DEG
    out_p, out_t = [path[0]], [timestamps[0]]
    for i in range(1, len(path)):
        x0, y0 = out_p[-1]
        x1, y1 = path[i]
        n_splits = int(max(abs(x1 - x0), abs(y1 - y0)) / limit)
        for k in range(1, n_splits + 1):
            f = k / (n_splits + 1)
            out_p.append((x0 + (x1 - x0) * f, y0 + (y1 - y0) * f))
            out_t.append(round(out_t[-1] + (timestamps[i] - timestamps[i - 1]) * f))
        out_p.append((x1, y1))
        out_t.append(timestamps[i])
    return out_p, out_t


def pack_trajectories(trajectories: list[dict], sources: list[dict]) -> tuple[dict, dict]:
    """Pack trajectory dicts into base64 typed-array blocks.

    Returns (payload_block, meta_extras). Coordinates are quantized to
    SCALE_DEG relative to the data min corner (origin in meta).
    """
    if not trajectories:
        raise ValueError("No trajectories to export — check filters / DB.")
    src_index = {s["id"]: i for i, s in enumerate(sources)}

    origin_lon = min(p[0] for t in trajectories for p in t["path"])
    origin_lat = min(p[1] for t in trajectories for p in t["path"])

    counts: list[int] = []
    src_idx: list[int] = []
    agent_flags: list[int] = []
    starts: list[int] = []
    deltas: list[int] = []
    t_starts: list[int] = []
    t_deltas: list[int] = []
    agent_keys: list[str] = []

    for t in trajectories:
        path, ts = _subdivide(t["path"], t["timestamps"])
        if len(path) > 65535:
            path, ts = path[:65535], ts[:65535]
        counts.append(len(path))
        src_idx.append(src_index.get(t["source_id"], 0))
        agent_flags.append(1 if t["agent"] else 0)
        if t["agent"]:
            agent_keys.append(t["vehicle_key"])

        q = [(round((x - origin_lon) / SCALE_DEG), round((y - origin_lat) / SCALE_DEG))
             for x, y in path]
        starts.extend(q[0])
        for i in range(1, len(q)):
            deltas.extend((q[i][0] - q[i - 1][0], q[i][1] - q[i - 1][1]))

        t_starts.append(ts[0])
        for i in range(1, len(ts)):
            t_deltas.append(max(0, min(65535, ts[i] - ts[i - 1])))

    block = {
        "counts": _b64("H", counts),
        "source": _b64("B", src_idx),
        "agent": _b64("B", agent_flags),
        "starts": _b64("i", starts),
        "deltas": _b64("h", deltas),
        "tStarts": _b64("I", t_starts),
        "tDeltas": _b64("H", t_deltas),
    }
    meta = {
        "origin": [origin_lon, origin_lat],
        "scale": SCALE_DEG,
        "nTraj": len(counts),
        "agentKeys": agent_keys,
    }
    return block, meta


def pack_pulse(conn, vehicle_type: Optional[str], city: Optional[str],
               origin: tuple[float, float], resolution: float = 0.005,
               max_cells_per_hour: int = 15000) -> Optional[tuple[dict, dict]]:
    """Pack density_hourly rows; None when the aggregate isn't built."""
    built = conn.execute(
        "SELECT COUNT(*) FROM density_hourly WHERE resolution = ?", [resolution]
    ).fetchone()[0]
    if built == 0:
        return None
    conds, params = ["resolution = ?"], [resolution]
    if vehicle_type:
        conds.append("source_id = ?")
        params.append(vehicle_type)
    if city:
        conds.append("city = ?")
        params.append(city)
    rows = conn.execute(f"""
        WITH filtered AS (
            SELECT hour, grid_lon, grid_lat, SUM(weight) AS weight
            FROM density_hourly WHERE {' AND '.join(conds)}
            GROUP BY 1, 2, 3
        ),
        ranked AS (
            SELECT *, ROW_NUMBER() OVER (PARTITION BY hour ORDER BY weight DESC) rn
            FROM filtered
        )
        SELECT hour, grid_lon, grid_lat, weight FROM ranked WHERE rn <= ?
    """, params + [max_cells_per_hour]).fetchall()
    if not rows:
        return None
    gmax = max(r[3] for r in rows)
    hours = [int(r[0]) for r in rows]
    cx = [round((r[1] - origin[0]) / resolution) for r in rows]
    cy = [round((r[2] - origin[1]) / resolution) for r in rows]
    w = [max(1, round(r[3] / gmax * 65535)) for r in rows]
    if any(not (-32768 <= v <= 32767) for v in cx + cy):
        # Region spans > ~160° at this resolution — should never happen.
        return None
    block = {"hour": _b64("B", hours), "cx": _b64("h", cx),
             "cy": _b64("h", cy), "w": _b64("H", w)}
    meta = {"resolution": resolution, "count": len(rows)}
    return block, meta


# --- Source styles ---------------------------------------------------------------


def resolve_sources(conn) -> list[dict]:
    """Source id → {label, color, mode} from sources.yaml when present,
    DB DISTINCT + defaults otherwise."""
    ingested = [r[0] for r in conn.execute(
        "SELECT DISTINCT source_id FROM trips WHERE source_id IS NOT NULL ORDER BY source_id"
    ).fetchall()]
    styles: dict[str, dict] = {}
    try:
        from backend.sources_schema import default_sources_path, load_sources
        for _key, src in load_sources(default_sources_path()).sources.items():
            r = src.render
            styles[src.source_id] = {
                "label": src.label,
                "color": list(r.color) if r and r.color else None,
                "mode": r.mode if r else "trails",
            }
    except Exception:
        pass
    out = []
    for sid in ingested:
        s = styles.get(sid, {})
        out.append({
            "id": sid,
            "label": s.get("label") or sid,
            "color": s.get("color") or list(DEFAULT_COLORS.get(sid, (200, 200, 200))),
            "mode": s.get("mode", "trails"),
        })
    return out


# --- HTML assembly ----------------------------------------------------------------


def export_html(
    conn,
    vendor_js: str,
    *,
    title: str = "trajectory-viz export",
    vehicle_type: Optional[str] = None,
    city: Optional[str] = None,
    simulation_day: Optional[int] = None,
    sample_n: int = 2000,
    agents: Optional[list[str]] = None,
    include_pulse: bool = True,
    buildings_bin: Optional[bytes] = None,
    camera: Optional[dict] = None,
    loop: Optional[dict] = None,
) -> str:
    """Assemble the export HTML string. Raises ValueError when nothing matches."""
    notes: list[str] = []

    rows = sample_waypoint_rows(conn, sample_n, vehicle_type, city, simulation_day)
    trajectories = rows_to_simple_trajectories(rows)
    if agents:
        agent_rows = waypoint_rows_for_vehicles(conn, agents, simulation_day)
        trajectories += rows_to_simple_trajectories(agent_rows, is_agent=True)

    sources = resolve_sources(conn)
    traj_block, traj_meta = pack_trajectories(trajectories, sources)

    pulse_block = pulse_meta = None
    if include_pulse:
        packed = pack_pulse(conn, vehicle_type, city, tuple(traj_meta["origin"]))
        if packed:
            pulse_block, pulse_meta = packed
        else:
            notes.append("pulse skipped: density_hourly aggregate not built")

    buildings_b64 = None
    if buildings_bin:
        buildings_b64 = base64.b64encode(buildings_bin).decode("ascii")

    attribution = ["PFLOW / trajectory-viz — synthetic ABM mobility data"]
    if buildings_b64:
        attribution.append("建物データ: 国土交通省 Project PLATEAU (CC-BY-4.0)")

    payload = {
        "meta": {
            "title": title,
            "camera": camera or {
                "longitude": traj_meta["origin"][0] + 0.1,
                "latitude": traj_meta["origin"][1] + 0.1,
                "zoom": 10.5, "pitch": 50, "bearing": -10,
            },
            "loop": loop or {"speed": 120, "trail_seconds": 1500},
            "sources": sources,
            "attribution": attribution,
            "pulse": pulse_meta,
            **traj_meta,
        },
        "traj": traj_block,
        "pulse": pulse_block,
        "buildings": buildings_b64,
    }

    template = TEMPLATE_PATH.read_text(encoding="utf-8")
    _PLACEHOLDERS = ("{{TITLE}}", "{{ATTRIBUTION}}", "{{DECK_JS}}", "{{PAYLOAD}}")
    substitutions = {
        "{{TITLE}}": title,
        "{{ATTRIBUTION}}": " · ".join(attribution),
        "{{DECK_JS}}": vendor_js,
        "{{PAYLOAD}}": json.dumps(payload, separators=(",", ":")),
    }
    html = template
    for token, value in substitutions.items():
        html = html.replace(token, value)
    # Check only the KNOWN placeholder tokens — the JSON payload may legitimately
    # contain '{{' (e.g. in a source label), so a blind '{{' scan is unsafe.
    leftover = [t for t in _PLACEHOLDERS if t in html]
    if leftover:
        raise RuntimeError(f"Unsubstituted template placeholders remain: {leftover}")

    data_mb = sum(len(v) for v in traj_block.values()) / 1024 / 1024
    if pulse_block:
        data_mb += sum(len(v) for v in pulse_block.values()) / 1024 / 1024
    if buildings_b64:
        data_mb += len(buildings_b64) / 1024 / 1024
    total_mb = len(html.encode("utf-8")) / 1024 / 1024
    print(f"[size] data {data_mb:.2f} MB · total {total_mb:.2f} MB "
          f"({traj_meta['nTraj']:,} trajectories)")
    if data_mb > DATA_BUDGET_WARN_MB:
        print(f"[warn] data block exceeds {DATA_BUDGET_WARN_MB} MB — consider a smaller --n")
    for n in notes:
        print(f"[note] {n}")
    html_size_check(total_mb)
    return html


_FORCE = False


def html_size_check(total_mb: float) -> None:
    if total_mb > TOTAL_BUDGET_FAIL_MB and not _FORCE:
        raise SystemExit(
            f"[ERROR] Export is {total_mb:.1f} MB > {TOTAL_BUDGET_FAIL_MB} MB budget. "
            f"Reduce --n / drop --include-buildings, or pass --force."
        )


# --- CLI ---------------------------------------------------------------------------


def main() -> None:
    global _FORCE
    ap = argparse.ArgumentParser(description="Export a self-contained cinematic HTML")
    ap.add_argument("--preset", type=str, default=None, help="Preset YAML path")
    ap.add_argument("--db", type=str, default=None, help="DuckDB path (default: viz DB)")
    ap.add_argument("--vendor", type=str, default=str(DEFAULT_VENDOR))
    ap.add_argument("--vehicle-type", type=str, default=None)
    ap.add_argument("--city", type=str, default=None)
    ap.add_argument("--simulation-day", type=int, default=None)
    ap.add_argument("--n", type=int, default=2000)
    ap.add_argument("--agents", type=str, default="", help="Comma-separated vehicle_keys")
    ap.add_argument("--title", type=str, default=None)
    ap.add_argument("--no-pulse", action="store_true")
    ap.add_argument("--buildings", type=str, default=None,
                    help="City key of a baked .bin to embed (looked up in the buildings dir), or a .bin path")
    ap.add_argument("--force", action="store_true", help="Ignore the size budget")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    _FORCE = args.force

    cfg: dict = {}
    if args.preset:
        import yaml
        cfg = yaml.safe_load(Path(args.preset).read_text(encoding="utf-8")) or {}
    filters = cfg.get("filters", {})
    vehicle_type = args.vehicle_type or filters.get("vehicle_type")
    city = args.city or filters.get("city")
    simulation_day = args.simulation_day if args.simulation_day is not None \
        else filters.get("simulation_day")
    sample_n = cfg.get("sample_n", args.n)
    agents = [a for a in (args.agents.split(",") if args.agents else cfg.get("agents", []) or []) if a]
    include = cfg.get("include", {})
    include_pulse = (not args.no_pulse) and include.get("pulse", True)
    buildings_key = args.buildings or include.get("buildings")
    title = args.title or cfg.get("title") or "trajectory-viz export"

    vendor_path = Path(args.vendor)
    if not vendor_path.is_file():
        raise SystemExit(
            f"[ERROR] deck.gl vendor bundle not found at {vendor_path}.\n"
            f"Fetch it once with: python scripts/fetch_vendor.py"
        )
    vendor_js = vendor_path.read_text(encoding="utf-8")

    buildings_bin = None
    if buildings_key:
        from backend.config import get_buildings_dir
        p = Path(buildings_key)
        if not p.is_file():
            p = get_buildings_dir() / f"{buildings_key}.bin"
        if p.is_file():
            buildings_bin = p.read_bytes()
        else:
            print(f"[note] buildings skipped: no baked bin at {p}")

    import duckdb
    db_path = args.db or str(get_viz_db_path())
    conn = duckdb.connect(db_path, read_only=True)

    t0 = time.time()
    html = export_html(
        conn, vendor_js,
        title=title, vehicle_type=vehicle_type, city=city,
        simulation_day=simulation_day, sample_n=sample_n, agents=agents,
        include_pulse=include_pulse, buildings_bin=buildings_bin,
        camera=cfg.get("camera"), loop=cfg.get("loop"),
    )
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(html, encoding="utf-8")
    print(f"[done] {out} in {time.time()-t0:.1f}s — open it in any browser, no server needed")


if __name__ == "__main__":
    main()

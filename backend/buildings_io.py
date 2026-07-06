"""
Compact binary building-footprint format (Phase 2C).

One .bin file per city holds extruded-building geometry for the night-scene
layer: footprint rings (quantized, delta-encoded) + per-building heights.
Written by scripts/build_buildings.py, served verbatim by
/api/buildings/{city}, decoded in frontend/src/buildings.ts, and embedded
as-is in the Phase 2D single-HTML export.

Layout (little-endian):
    magic          4 bytes  b"PBLD"
    header_len     uint32
    header         header_len bytes of UTF-8 JSON:
                     {origin_lon, origin_lat, scale, n_buildings, n_rings,
                      n_vertices, heights_synthesized, city, source}
    ring_counts    uint8  × n_buildings   rings per building (first = outer)
    vertex_counts  uint16 × n_rings       vertices per ring (unclosed)
    heights_dm     uint16 × n_buildings   height in decimeters
    ring_starts    int32  × n_rings × 2   first vertex, quantized units
    deltas         int16  × (n_vertices - n_rings) × 2

Quantization: unit = `scale` degrees (default 1e-5 ≈ 1.1 m at 35°N) relative
to (origin_lon, origin_lat). Int16 deltas span ±0.33° (~36 km) — more than
any single building ring, so no delta ever needs subdividing.
"""

from __future__ import annotations

import json
import math
import struct
from dataclasses import dataclass, field

MAGIC = b"PBLD"
DEFAULT_SCALE_DEG = 1e-5

# Roughly meters-per-degree at Japan's latitude, for area/side conversions.
M_PER_DEG_LAT = 111_320.0


@dataclass
class Building:
    """One building: rings[0] is the outer ring; the rest are holes.

    Rings are lists of (lon, lat) tuples WITHOUT the closing duplicate vertex.
    """
    rings: list[list[tuple[float, float]]]
    height_m: float

    def outer(self) -> list[tuple[float, float]]:
        return self.rings[0]


@dataclass
class BuildingSet:
    buildings: list[Building] = field(default_factory=list)
    city: str = ""
    source: str = ""
    heights_synthesized: bool = False


def pack(bset: BuildingSet, scale: float = DEFAULT_SCALE_DEG) -> bytes:
    """Serialize a BuildingSet to the PBLD binary format."""
    if not bset.buildings:
        raise ValueError("Cannot pack an empty BuildingSet.")
    origin_lon = min(v[0] for b in bset.buildings for r in b.rings for v in r)
    origin_lat = min(v[1] for b in bset.buildings for r in b.rings for v in r)

    ring_counts = bytearray()
    vertex_counts: list[int] = []
    heights_dm: list[int] = []
    ring_starts: list[int] = []
    deltas: list[int] = []
    n_rings = 0
    n_vertices = 0

    def q(lon: float, lat: float) -> tuple[int, int]:
        return (round((lon - origin_lon) / scale), round((lat - origin_lat) / scale))

    for b in bset.buildings:
        if not (0 < len(b.rings) <= 255):
            raise ValueError(f"Building must have 1-255 rings, got {len(b.rings)}.")
        ring_counts.append(len(b.rings))
        heights_dm.append(max(0, min(65535, round(b.height_m * 10))))
        for ring in b.rings:
            if len(ring) < 3:
                raise ValueError("Ring must have >= 3 vertices (unclosed).")
            if len(ring) > 65535:
                raise ValueError("Ring exceeds 65535 vertices.")
            n_rings += 1
            vertex_counts.append(len(ring))
            prev = q(*ring[0])
            ring_starts.extend(prev)
            n_vertices += 1
            for lon, lat in ring[1:]:
                cur = q(lon, lat)
                dx, dy = cur[0] - prev[0], cur[1] - prev[1]
                if not (-32768 <= dx <= 32767 and -32768 <= dy <= 32767):
                    raise ValueError(
                        f"Delta out of Int16 range ({dx},{dy}) — ring spans "
                        f"more than ~36 km, which is not a building."
                    )
                deltas.extend((dx, dy))
                prev = cur
                n_vertices += 1

    header = json.dumps({
        "origin_lon": origin_lon,
        "origin_lat": origin_lat,
        "scale": scale,
        "n_buildings": len(bset.buildings),
        "n_rings": n_rings,
        "n_vertices": n_vertices,
        "heights_synthesized": bset.heights_synthesized,
        "city": bset.city,
        "source": bset.source,
    }).encode("utf-8")

    out = bytearray()
    out += MAGIC
    out += struct.pack("<I", len(header))
    out += header
    out += bytes(ring_counts)
    out += struct.pack(f"<{n_rings}H", *vertex_counts)
    out += struct.pack(f"<{len(heights_dm)}H", *heights_dm)
    out += struct.pack(f"<{n_rings * 2}i", *ring_starts)
    out += struct.pack(f"<{len(deltas)}h", *deltas)
    return bytes(out)


def unpack(data: bytes) -> BuildingSet:
    """Deserialize a PBLD buffer back into a BuildingSet (test/QA path;
    the production decoder is the JS mirror in frontend/src/buildings.ts)."""
    if data[:4] != MAGIC:
        raise ValueError("Not a PBLD buffer (bad magic).")
    (header_len,) = struct.unpack_from("<I", data, 4)
    off = 8
    header = json.loads(data[off:off + header_len].decode("utf-8"))
    off += header_len

    nb = header["n_buildings"]
    nr = header["n_rings"]
    nv = header["n_vertices"]
    scale = header["scale"]
    olon, olat = header["origin_lon"], header["origin_lat"]

    ring_counts = list(data[off:off + nb])
    off += nb
    vertex_counts = list(struct.unpack_from(f"<{nr}H", data, off))
    off += nr * 2
    heights_dm = list(struct.unpack_from(f"<{nb}H", data, off))
    off += nb * 2
    ring_starts = list(struct.unpack_from(f"<{nr * 2}i", data, off))
    off += nr * 8
    n_deltas = (nv - nr) * 2
    deltas = list(struct.unpack_from(f"<{n_deltas}h", data, off))

    bset = BuildingSet(
        city=header["city"], source=header["source"],
        heights_synthesized=header["heights_synthesized"],
    )
    ring_i = 0
    delta_i = 0
    for bi in range(nb):
        rings: list[list[tuple[float, float]]] = []
        for _ in range(ring_counts[bi]):
            nvtx = vertex_counts[ring_i]
            x, y = ring_starts[ring_i * 2], ring_starts[ring_i * 2 + 1]
            ring = [(olon + x * scale, olat + y * scale)]
            for _ in range(nvtx - 1):
                x += deltas[delta_i]
                y += deltas[delta_i + 1]
                delta_i += 2
                ring.append((olon + x * scale, olat + y * scale))
            rings.append(ring)
            ring_i += 1
        bset.buildings.append(Building(rings=rings, height_m=heights_dm[bi] / 10.0))
    return bset


# --- Sources ------------------------------------------------------------------


def synthesize_from_tatemono(
    rows: list[tuple[float, float, float]],
    seed: int = 42,
) -> list[Building]:
    """Synthesize square footprints from city_tatemono.csv centroids.

    Each row is (x=lon, y=lat, area_deg2). The CSV has no polygons and no
    heights (verified: columns are n03_007,x,y,area only), so we build an
    axis-aligned square of the same area and assign a heuristic height
    h = clamp(8, 4*log2(area_m2), 60) with deterministic jitter. Output is
    flagged heights_synthesized=True all the way to the UI.
    """
    import random
    rng = random.Random(seed)
    out: list[Building] = []
    for lon, lat, area_deg2 in rows:
        m_per_deg_lon = M_PER_DEG_LAT * math.cos(math.radians(lat))
        area_m2 = abs(area_deg2) * M_PER_DEG_LAT * m_per_deg_lon
        if area_m2 < 25:
            continue
        side_m = math.sqrt(area_m2)
        half_lon = side_m / 2 / m_per_deg_lon
        half_lat = side_m / 2 / M_PER_DEG_LAT
        ring = [
            (lon - half_lon, lat - half_lat),
            (lon + half_lon, lat - half_lat),
            (lon + half_lon, lat + half_lat),
            (lon - half_lon, lat + half_lat),
        ]
        h = max(8.0, min(60.0, 4.0 * math.log2(max(area_m2, 2))))
        h *= 0.85 + 0.3 * rng.random()   # deterministic jitter
        out.append(Building(rings=[ring], height_m=h))
    return out


def ring_area_m2(ring: list[tuple[float, float]]) -> float:
    """Shoelace area of an unclosed lon/lat ring, in m² (equirectangular)."""
    if len(ring) < 3:
        return 0.0
    mean_lat = sum(v[1] for v in ring) / len(ring)
    kx = M_PER_DEG_LAT * math.cos(math.radians(mean_lat))
    ky = M_PER_DEG_LAT
    s = 0.0
    for i in range(len(ring)):
        x1, y1 = ring[i]
        x2, y2 = ring[(i + 1) % len(ring)]
        s += (x1 * kx) * (y2 * ky) - (x2 * kx) * (y1 * ky)
    return abs(s) / 2.0


def sample_buildings(
    buildings: list[Building],
    max_buildings: int,
    tall_threshold_m: float = 25.0,
    seed: int = 42,
) -> list[Building]:
    """Cap a building list: keep every tall building, area-weighted-sample the
    rest. Tall buildings define the skyline; dropping them is visually worse
    than thinning the low-rise carpet."""
    if len(buildings) <= max_buildings:
        return buildings
    import random
    rng = random.Random(seed)
    tall = [b for b in buildings if b.height_m >= tall_threshold_m]
    rest = [b for b in buildings if b.height_m < tall_threshold_m]
    budget = max(0, max_buildings - len(tall))
    if budget == 0:
        return tall[:max_buildings]
    weights = [max(ring_area_m2(b.outer()), 1.0) for b in rest]
    picked = rng.choices(range(len(rest)), weights=weights, k=min(budget, len(rest)))
    # choices() samples with replacement — dedupe, then top up sequentially.
    idx = sorted(set(picked))
    if len(idx) < budget:
        chosen = set(idx)
        for i in range(len(rest)):
            if len(idx) >= budget:
                break
            if i not in chosen:
                idx.append(i)
    return tall + [rest[i] for i in sorted(idx[:budget])]


def clip_bbox(
    buildings: list[Building],
    w: float, s: float, e: float, n: float,
) -> list[Building]:
    """Keep buildings whose outer-ring centroid falls inside the bbox."""
    out = []
    for b in buildings:
        ring = b.outer()
        cx = sum(v[0] for v in ring) / len(ring)
        cy = sum(v[1] for v in ring) / len(ring)
        if w <= cx <= e and s <= cy <= n:
            out.append(b)
    return out

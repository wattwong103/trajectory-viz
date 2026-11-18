"""Default transport-mode display labels (PFLOW int codes → string labels).

Canonical public language is the string label (`Walk`, `Bike`, …). Integer
`transport_mode` codes remain the filter wire format until schema v0.3 adds
string mode columns. Per-source overrides live in sources.yaml `mode_map`.
"""

# Mirrors frontend/src/transportModes.ts TRANSPORT_MODE_META labels.
DEFAULT_MODE_LABELS: dict[int, str] = {
    0: "Walk",
    1: "Bike",
    2: "Bus",
    3: "Car",
    4: "Train",
    8: "Taxi",
}


def label_for_mode(mode_id: int, mode_map: dict[str, str] | None = None) -> str:
    """Resolve a display label for a transport_mode int.

    `mode_map` keys are strings (YAML-friendly); int codes look up as str(id).
    Falls back to DEFAULT_MODE_LABELS, then `mode {id}`.
    """
    key = str(mode_id)
    if mode_map and key in mode_map:
        return mode_map[key]
    return DEFAULT_MODE_LABELS.get(mode_id, f"mode {mode_id}")


def merge_mode_maps(maps: list[dict[str, str] | None]) -> dict[str, str]:
    """Union mode_map dicts; earlier entries win on key conflict."""
    merged: dict[str, str] = {}
    for m in maps:
        if not m:
            continue
        for k, v in m.items():
            sk = str(k)
            if sk not in merged:
                merged[sk] = v
    return merged

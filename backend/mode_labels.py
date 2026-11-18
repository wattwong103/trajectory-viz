"""Transport-mode display labels and int↔string helpers.

Canonical public language is the **string label** (`Walk`, `Bike`, …) stored
in `trips.mode`. Integer `transport_mode` codes remain as optional PFLOW
`mode_code` via sources.yaml `mode_map`. Per-source overrides live in
`mode_map` (keys are strings for YAML friendliness).
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


def reverse_mode_map(mode_map: dict[str, str] | None = None) -> dict[str, int]:
    """Map label (case-insensitive) → int code.

    Prefer explicit `mode_map` values; fall back to DEFAULT_MODE_LABELS.
    First-seen label wins when duplicates exist.
    """
    rev: dict[str, int] = {}
    for code, label in DEFAULT_MODE_LABELS.items():
        key = label.casefold()
        if key not in rev:
            rev[key] = code
    if mode_map:
        for code_s, label in mode_map.items():
            try:
                code = int(code_s)
            except (TypeError, ValueError):
                continue
            key = str(label).casefold()
            if key not in rev:
                rev[key] = code
    return rev


def mode_label_case_sql(
    transport_mode_expr: str,
    mode_map: dict[str, str] | None = None,
) -> str:
    """SQL CASE expression: int transport_mode → string mode label."""
    mapping = dict(DEFAULT_MODE_LABELS)
    if mode_map:
        for k, v in mode_map.items():
            try:
                mapping[int(k)] = v
            except (TypeError, ValueError):
                continue
    arms = " ".join(
        f"WHEN {code} THEN '{label.replace(chr(39), chr(39)+chr(39))}'"
        for code, label in sorted(mapping.items())
    )
    return (
        f"CASE {transport_mode_expr} {arms} "
        f"ELSE 'mode ' || CAST({transport_mode_expr} AS VARCHAR) END"
    )

"""Phase A — mode label resolution + source_id alias helper."""

from __future__ import annotations

import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from backend.filters import resolve_source_id  # noqa: E402
from backend.mode_labels import (  # noqa: E402
    label_for_mode,
    merge_mode_maps,
)


def test_resolve_source_id_prefers_canonical():
    assert resolve_source_id("taxi", "truck") == "taxi"
    assert resolve_source_id(None, "truck") == "truck"
    assert resolve_source_id("taxi", None) == "taxi"
    assert resolve_source_id(None, None) is None


def test_label_for_mode_defaults_and_overrides():
    assert label_for_mode(0) == "Walk"
    assert label_for_mode(8) == "Taxi"
    assert label_for_mode(99) == "mode 99"
    assert label_for_mode(3, {"3": "Drive"}) == "Drive"
    # Unknown override keys fall through to defaults.
    assert label_for_mode(0, {"3": "Drive"}) == "Walk"


def test_merge_mode_maps_first_wins():
    merged = merge_mode_maps([{"0": "A"}, {"0": "B", "1": "Bike"}])
    assert merged == {"0": "A", "1": "Bike"}

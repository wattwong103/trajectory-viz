"""Phase 2D — single-HTML cinematic export tests.

Reuses test_endpoints.py's synthetic DB builder against an in-memory DuckDB,
a stub vendor bundle, and the real export_template.html. Asserts:
 - the packing round-trips within the 1.2 m quantization bound
 - the emitted HTML has no external URLs (except the license-comment
   allowlist) and no unsubstituted placeholders
 - trajectory count == what the DB holds; size gate + graceful skips behave
"""

from __future__ import annotations

import base64
import math
import re
import struct
import sys
from pathlib import Path

import duckdb
import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

import backend.export as export  # noqa: E402

# Reuse the endpoint fixture's data builder verbatim.
from tests.test_endpoints import _populate_db  # noqa: E402

STUB_VENDOR = "window.deck = window.deck || {}; /* stub deck.gl bundle */"

# Hosts allowed to appear (only inside the attribution/license text/comments).
_URL_RE = re.compile(r"https?://[^\s\"'<>)]+")
_ALLOWED_URL_SUBSTR = ("plateau", "gsi.go.jp", "mlit.go.jp")


@pytest.fixture
def conn(tmp_path):
    c = duckdb.connect(":memory:")
    _populate_db(c, tmp_path)
    return c


def test_pack_round_trip():
    trajectories = [{
        "path": [(139.700, 35.600), (139.7123, 35.6100), (139.8000, 35.7000)],
        "timestamps": [28800, 28830, 28900],
        "source_id": "taxi", "vehicle_key": "taxi:tokyo:47", "agent": False,
    }]
    sources = [{"id": "taxi", "label": "Taxi", "color": [23, 184, 190], "mode": "trails"}]
    block, meta = export.pack_trajectories(trajectories, sources)
    olon, olat = meta["origin"]
    s = meta["scale"]

    counts = struct.unpack("<1H", base64.b64decode(block["counts"]))
    starts = struct.unpack("<2i", base64.b64decode(block["starts"]))
    deltas = struct.unpack(f"<{(counts[0]-1)*2}h", base64.b64decode(block["deltas"]))

    # Reconstruct and compare to the original coordinates.
    pts = [(olon + starts[0] * s, olat + starts[1] * s)]
    x, y = starts
    for i in range(counts[0] - 1):
        x += deltas[i * 2]
        y += deltas[i * 2 + 1]
        pts.append((olon + x * s, olat + y * s))
    for (lo, la), (ro, ra) in zip(trajectories[0]["path"], pts, strict=True):
        assert math.isclose(lo, ro, abs_tol=1.2 / 111_320)
        assert math.isclose(la, ra, abs_tol=1.2 / 111_320)


def test_export_html_is_self_contained(conn):
    html = export.export_html(
        conn, STUB_VENDOR, title="Test", vehicle_type="truck",
        sample_n=10, include_pulse=True,
    )
    # No unsubstituted placeholders.
    assert "{{" not in html
    # Every URL in the file must be in the license allowlist.
    for url in _URL_RE.findall(html):
        assert any(sub in url.lower() for sub in _ALLOWED_URL_SUBSTR), \
            f"unexpected external URL in export: {url}"
    # Stub bundle + payload made it in.
    assert "stub deck.gl bundle" in html
    assert 'id="payload"' in html


def test_export_trajectory_count_matches_db(conn):
    # Fixture has one truck trajectory-trip with waypoints (truck 1001 trip 1 & 2).
    html = export.export_html(conn, STUB_VENDOR, vehicle_type="truck", sample_n=50,
                              include_pulse=False)
    import json
    payload = json.loads(re.search(
        r'id="payload"[^>]*>(.*?)</script>', html, re.S).group(1))
    n = payload["meta"]["nTraj"]
    db_n = conn.execute(
        "SELECT COUNT(*) FROM (SELECT DISTINCT vehicle_id, trip_id FROM waypoints "
        "WHERE vehicle_type = 'truck')"
    ).fetchone()[0]
    assert n == db_n


def test_export_includes_agents(conn):
    import json
    html = export.export_html(conn, STUB_VENDOR, vehicle_type="truck", sample_n=1,
                              agents=["truck:1001"], include_pulse=False)
    payload = json.loads(re.search(
        r'id="payload"[^>]*>(.*?)</script>', html, re.S).group(1))
    assert "truck:1001" in payload["meta"]["agentKeys"]


def test_export_pulse_graceful_skip_when_not_built(conn, capsys):
    # Clear the aggregate the fixture built → pulse should be skipped, not crash.
    conn.execute("DELETE FROM density_hourly")
    html = export.export_html(conn, STUB_VENDOR, vehicle_type="truck", sample_n=10,
                              include_pulse=True)
    import json
    payload = json.loads(re.search(
        r'id="payload"[^>]*>(.*?)</script>', html, re.S).group(1))
    assert payload["pulse"] is None
    assert "density_hourly aggregate not built" in capsys.readouterr().out


def test_export_size_gate(conn, monkeypatch):
    monkeypatch.setattr(export, "TOTAL_BUDGET_FAIL_MB", 0.0001)
    monkeypatch.setattr(export, "_FORCE", False)
    with pytest.raises(SystemExit) as exc:
        export.export_html(conn, STUB_VENDOR, vehicle_type="truck", sample_n=10)
    msg = str(exc.value)
    assert "MB budget" in msg
    assert "--n" in msg or "sample_n" in msg
    assert "--force" in msg
    assert "demo-paper" in msg or "EXPORT.md" in msg


def test_export_raises_on_empty(conn):
    with pytest.raises(ValueError):
        export.export_html(conn, STUB_VENDOR, vehicle_type="nonexistent", sample_n=10)


# ── TV-8 — forms gating, engine honesty, size-gate copy ─────────────────────


def test_apply_preset_forms_gates_include_flags():
    """Phase D forms: drives pulse/buildings/agents when declared."""
    decided = export.apply_preset_forms(
        ["trail", "agents"],
        include_pulse=True,
        buildings_key="tokyo",
        agents=["taxi:tokyo:47"],
    )
    assert decided.include_pulse is False
    assert decided.buildings_key is None
    assert decided.agents == ["taxi:tokyo:47"]
    assert "pulse" in " ".join(decided.notes).lower() or decided.skipped == {"pulse", "buildings"}


def test_apply_preset_forms_enables_declared_scene_forms():
    decided = export.apply_preset_forms(
        ["trails", "pulse", "buildings"],
        include_pulse=False,  # forms win over a stale include.pulse=false
        buildings_key=None,
        agents=["x:1"],
        buildings_from_forms_key="tokyo",
    )
    assert decided.include_pulse is True
    assert decided.buildings_key == "tokyo"
    assert decided.agents == []  # agents not in forms:


def test_apply_preset_forms_legacy_when_absent():
    """No forms: → include.* / CLI flags pass through unchanged."""
    decided = export.apply_preset_forms(
        None,
        include_pulse=True,
        buildings_key="tokyo",
        agents=["a:1"],
    )
    assert decided.include_pulse is True
    assert decided.buildings_key == "tokyo"
    assert decided.agents == ["a:1"]
    assert decided.unknown == []


def test_apply_preset_forms_notes_unknown_ids():
    decided = export.apply_preset_forms(
        ["trail", "od-arcs", "heatmap"],
        include_pulse=False,
        buildings_key=None,
        agents=[],
    )
    assert "od-arcs" in decided.unknown
    assert "heatmap" in decided.unknown


def test_engine_deck_and_minimal_are_allowed():
    export.validate_engine("deck")
    export.validate_engine("minimal")
    export.validate_engine(None)


def test_engine_unknown_is_rejected():
    with pytest.raises(SystemExit) as exc:
        export.validate_engine("webgpu")
    msg = str(exc.value).lower()
    assert "unknown" in msg or "webgpu" in msg


def test_export_html_minimal_is_self_contained(conn):
    """--engine minimal: no deck.gl bundle, Canvas renderer, same payload id."""
    html = export.export_html(
        conn, "", title="Minimal", vehicle_type="truck",
        sample_n=10, include_pulse=False, engine="minimal",
    )
    assert "{{" not in html
    for url in _URL_RE.findall(html):
        assert any(sub in url.lower() for sub in _ALLOWED_URL_SUBSTR), \
            f"unexpected external URL in export: {url}"
    assert 'id="payload"' in html
    assert 'id="viz-canvas"' in html or "<canvas" in html
    assert "stub deck.gl bundle" not in html
    assert "window.deck" not in html
    # Marker that the minimal shell (not the deck template) was used.
    assert "engine:minimal" in html or 'data-engine="minimal"' in html


def test_export_html_minimal_smaller_than_deck_stub(conn):
    """Dropping the deck.gl UMD is the whole point of --engine minimal."""
    fat_vendor = "/*" + ("x" * 200_000) + "*/ window.deck = {};"
    deck_html = export.export_html(
        conn, fat_vendor, vehicle_type="truck", sample_n=10,
        include_pulse=False, engine="deck",
    )
    min_html = export.export_html(
        conn, "", vehicle_type="truck", sample_n=10,
        include_pulse=False, engine="minimal",
    )
    assert len(min_html.encode("utf-8")) < len(deck_html.encode("utf-8")) - 100_000


def test_export_html_minimal_trajectory_count(conn):
    import json
    html = export.export_html(
        conn, "", vehicle_type="truck", sample_n=50,
        include_pulse=False, engine="minimal",
    )
    payload = json.loads(re.search(
        r'id="payload"[^>]*>(.*?)</script>', html, re.S).group(1))
    db_n = conn.execute(
        "SELECT COUNT(*) FROM (SELECT DISTINCT vehicle_id, trip_id FROM waypoints "
        "WHERE vehicle_type = 'truck')"
    ).fetchone()[0]
    assert payload["meta"]["nTraj"] == db_n
    assert payload["meta"].get("engine") == "minimal"


def test_size_gate_message_is_actionable(monkeypatch):
    monkeypatch.setattr(export, "_FORCE", False)
    with pytest.raises(SystemExit) as exc:
        export.html_size_check(9.5, data_mb=5.0, n_traj=2000)
    msg = str(exc.value)
    assert "9.5" in msg
    assert "8" in msg
    assert any(tok in msg for tok in ("--n", "sample_n", "demo-paper", "--no-pulse", "buildings"))
    assert "--force" in msg
    assert "--engine minimal" in msg


def test_cli_minimal_skips_vendor(conn, tmp_path, monkeypatch):
    """CLI --engine minimal must not require scripts/vendor/deck.gl.min.js."""
    import json
    out = tmp_path / "out-minimal.html"
    missing_vendor = tmp_path / "no-such-vendor.js"
    assert not missing_vendor.exists()

    # Point export at our in-memory DB via a temp file DuckDB can't share
    # easily — instead stub get_viz_db_path and duckdb.connect.
    db_file = tmp_path / "t.duckdb"
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    disk = duckdb.connect(str(db_file))
    from tests.test_endpoints import _populate_db
    _populate_db(disk, data_dir)
    disk.close()

    monkeypatch.setattr(
        "sys.argv",
        [
            "viz-export",
            "--engine", "minimal",
            "--vendor", str(missing_vendor),
            "--db", str(db_file),
            "--vehicle-type", "truck",
            "--n", "10",
            "--no-pulse",
            "--out", str(out),
        ],
    )
    export.main()
    html = out.read_text(encoding="utf-8")
    assert 'data-engine="minimal"' in html
    assert 'id="viz-canvas"' in html
    payload = json.loads(re.search(
        r'id="payload"[^>]*>(.*?)</script>', html, re.S).group(1))
    assert payload["meta"]["engine"] == "minimal"

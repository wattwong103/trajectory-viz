"""Phase D — demo/universal as the default product profile.

Default discovery must not surprise users with Dropbox/PFLOW_HOME.
PFLOW (and sibling lab packs) are opt-in via TRAJECTORY_VIZ_PROFILE /
PFLOW_VIZ_SOURCES / --profile.
"""

from __future__ import annotations

from pathlib import Path

import pytest
import yaml

import backend.config as config
from backend.sources_schema import (
    DEFAULT_PROFILE,
    default_sources_path,
    load_sources,
    resolve_profile,
)

PROJECT_ROOT = Path(__file__).resolve().parent.parent


@pytest.fixture
def isolated(monkeypatch, tmp_path):
    """Clear profile/DB/source env and point repo root at the real checkout.

    Phase D defaults resolve package-relative demo/ paths from the real
    repo; workspace auto-detect stays disabled via unmarked nesting only
    when we assert no Dropbox surprise.
    """
    monkeypatch.setattr(config, "_pflow_home", None)
    monkeypatch.setattr(config, "_pflow_home_env_warned", False)
    monkeypatch.delenv("PFLOW_HOME", raising=False)
    monkeypatch.delenv("PFLOW_VIZ_DB", raising=False)
    monkeypatch.delenv("TRAJECTORY_VIZ_DB", raising=False)
    monkeypatch.delenv("PFLOW_VIZ_SOURCES", raising=False)
    monkeypatch.delenv("TRAJECTORY_VIZ_SOURCES", raising=False)
    monkeypatch.delenv("PFLOW_VIZ_OUTPUT_ROOT", raising=False)
    monkeypatch.delenv("TRAJECTORY_VIZ_OUTPUT_ROOT", raising=False)
    monkeypatch.delenv("TRAJECTORY_VIZ_PROFILE", raising=False)
    monkeypatch.delenv("PFLOW_VIZ_PROFILE", raising=False)
    # Real repo root so demo/ and profiles/ resolve.
    monkeypatch.setattr(config, "_REPO_ROOT", PROJECT_ROOT)
    return tmp_path


def test_default_profile_is_demo():
    assert DEFAULT_PROFILE == "demo"


def test_default_sources_path_is_demo_registry(isolated):
    path = default_sources_path()
    assert path.resolve() == (PROJECT_ROOT / "demo" / "sources.demo.yaml").resolve()
    sf = load_sources(path)
    assert "couriers" in sf.sources
    assert "buses" in sf.sources


def test_default_viz_db_is_demo_duckdb(isolated):
    db = config.get_viz_db_path()
    assert db.resolve() == (PROJECT_ROOT / "demo" / "demo.duckdb").resolve()
    # Must not have consulted PFLOW_HOME / Dropbox.
    assert config._pflow_home is None


def test_default_output_root_is_demo_dir(isolated):
    root = config.get_output_root()
    assert root.resolve() == (PROJECT_ROOT / "demo").resolve()
    assert config._pflow_home is None


def test_dropbox_exists_but_default_still_demo(isolated, monkeypatch):
    """Dropbox/PFLOW on disk must not hijack the default product path."""
    dropbox = isolated / "home" / "Dropbox" / "PFLOW"
    (dropbox / "output" / "viz").mkdir(parents=True)
    monkeypatch.setattr(Path, "home", lambda: isolated / "home")

    assert default_sources_path().name == "sources.demo.yaml"
    assert config.get_viz_db_path().name == "demo.duckdb"
    assert config._pflow_home is None


def test_trajectory_viz_sources_alias(isolated, monkeypatch, tmp_path):
    custom = tmp_path / "custom.yaml"
    custom.write_text(
        "version: 1\nsources: {}\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("TRAJECTORY_VIZ_SOURCES", str(custom))
    assert default_sources_path() == custom


def test_trajectory_viz_sources_beats_pflow_alias(isolated, monkeypatch, tmp_path):
    canon = tmp_path / "canon.yaml"
    legacy = tmp_path / "legacy.yaml"
    canon.write_text("version: 1\nsources: {}\n", encoding="utf-8")
    legacy.write_text("version: 1\nsources: {}\n", encoding="utf-8")
    monkeypatch.setenv("TRAJECTORY_VIZ_SOURCES", str(canon))
    monkeypatch.setenv("PFLOW_VIZ_SOURCES", str(legacy))
    assert default_sources_path() == canon


def test_profile_pflow_resolves_lab_registry(isolated, monkeypatch):
    monkeypatch.setenv("TRAJECTORY_VIZ_PROFILE", "pflow")
    path = default_sources_path()
    assert path.resolve() == (
        PROJECT_ROOT / "profiles" / "pflow" / "sources.yaml"
    ).resolve()
    sf = load_sources(path)
    assert "pflow-truck" in sf.sources
    assert "pflow-taxi-tokyo" in sf.sources


def test_profile_pflow_uses_pflow_home_paths(isolated, monkeypatch):
    monkeypatch.setenv("TRAJECTORY_VIZ_PROFILE", "pflow")
    home = isolated / "lab-home"
    (home / "output" / "viz").mkdir(parents=True)
    monkeypatch.setenv("PFLOW_HOME", str(home))

    assert config.get_viz_db_path() == home / "output" / "viz" / "pflow.duckdb"
    assert config.get_output_root() == home / "output"


def test_resolve_profile_unknown_raises():
    with pytest.raises(ValueError, match="unknown profile"):
        resolve_profile("not-a-real-profile")


def test_demo_registry_is_multi_format_multi_mode():
    """Universal reference registry: ≥2 formats and string mode coverage."""
    sf = load_sources(PROJECT_ROOT / "demo" / "sources.demo.yaml")
    assert len(sf.sources) >= 3  # couriers (GPX) + buses (GeoJSON) + OD (CSV)
    modes_seen: set[str] = set()
    formats_hint = 0
    for src in sf.sources.values():
        glob = (src.discovery.trajectories_glob or "") + (src.discovery.trips_glob or "")
        if ".gpx" in glob or ".geojson" in glob or ".csv" in glob:
            formats_hint += 1
        if src.forms:
            assert isinstance(src.forms, list)
    raw = yaml.safe_load(
        (PROJECT_ROOT / "demo" / "sources.demo.yaml").read_text(encoding="utf-8")
    )
    # At least one source declares canonical string mode column or mode_map.
    for block in raw["sources"].values():
        trips = (block.get("columns") or {}).get("trips") or {}
        if "mode" in trips:
            modes_seen.add("string-mode")
        if block.get("mode_map"):
            modes_seen.add("mode_map")
    assert formats_hint >= 3
    assert modes_seen, "demo registry should exercise string mode and/or mode_map"


def test_export_preset_declares_forms():
    preset = PROJECT_ROOT / "presets" / "tokyo-night.yaml"
    cfg = yaml.safe_load(preset.read_text(encoding="utf-8"))
    assert "forms" in cfg
    assert isinstance(cfg["forms"], list)
    assert "trail" in cfg["forms"] or "trails" in cfg["forms"]


def test_export_gallery_presets_have_workflow_engine():
    """TV-25 — gallery cues for paper/share discoverability."""
    for name, workflow, engine in (
        ("demo-paper.yaml", "paper", "minimal"),
        ("demo-deck.yaml", "deck", "deck"),
        ("tokyo-night.yaml", "cinematic", "deck"),
    ):
        cfg = yaml.safe_load(
            (PROJECT_ROOT / "presets" / name).read_text(encoding="utf-8")
        )
        assert cfg.get("workflow") == workflow, name
        assert cfg.get("engine") == engine, name
        assert "forms" in cfg, name

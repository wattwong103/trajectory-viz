"""Simulation-scale LOD — micro/meso/macro detection, forms, ingest SQL, clamp."""

from __future__ import annotations

import pytest

from backend.lod import (
    MEGA_AGENT_THRESHOLD,
    MEGA_WAYPOINT_THRESHOLD,
    MICRO_AGENT_MAX,
    MICRO_WAYPOINT_MAX,
    SCALE_MACRO,
    SCALE_MESO,
    SCALE_MICRO,
    TRAJECTORY_RENDER_CAP,
    build_fix_its,
    clamp_trajectory_sample_n,
    detect_scale,
    downsample_waypoints_sql,
    form_disable_reasons,
    is_mega_sim,
    is_micro_scale,
    lod_capability_block,
    normalize_scale,
    recommended_forms,
)


def test_normalize_scale_canonical_and_aliases():
    assert normalize_scale("micro") == SCALE_MICRO
    assert normalize_scale("MACRO") == SCALE_MACRO
    assert normalize_scale("mega") == SCALE_MACRO
    assert normalize_scale("standard") == SCALE_MESO
    assert normalize_scale(None) is None
    assert normalize_scale("") is None
    with pytest.raises(ValueError):
        normalize_scale("planet")


def test_is_mega_sim_agent_threshold():
    assert is_mega_sim(MEGA_AGENT_THRESHOLD, 0) is True
    assert is_mega_sim(MEGA_AGENT_THRESHOLD - 1, 0) is False


def test_is_mega_sim_waypoint_threshold():
    assert is_mega_sim(0, MEGA_WAYPOINT_THRESHOLD) is True
    assert is_mega_sim(0, MEGA_WAYPOINT_THRESHOLD - 1) is False


def test_is_micro_scale_bounds():
    assert is_micro_scale(0, 0) is True
    assert is_micro_scale(MICRO_AGENT_MAX - 1, MICRO_WAYPOINT_MAX - 1) is True
    assert is_micro_scale(MICRO_AGENT_MAX, 0) is False
    assert is_micro_scale(0, MICRO_WAYPOINT_MAX) is False


def test_detect_scale_auto_micro_meso_macro():
    assert detect_scale(50, 5_000) == (SCALE_MICRO, "auto")
    # Mid-city ABM: over micro agent cap, under macro.
    assert detect_scale(MICRO_AGENT_MAX, 50_000) == (SCALE_MESO, "auto")
    assert detect_scale(MEGA_AGENT_THRESHOLD, 0) == (SCALE_MACRO, "auto")
    assert detect_scale(0, MEGA_WAYPOINT_THRESHOLD) == (SCALE_MACRO, "auto")


def test_detect_scale_override_wins():
    # Tiny N would be micro, but config forces macro.
    assert detect_scale(10, 100, override="macro") == (SCALE_MACRO, "config")
    assert detect_scale(MEGA_AGENT_THRESHOLD, 0, override="micro") == (SCALE_MICRO, "config")
    assert detect_scale(10, 100, override="mega") == (SCALE_MACRO, "config")
    assert detect_scale(MEGA_AGENT_THRESHOLD, 0, override="standard") == (SCALE_MESO, "config")


def test_clamp_trajectory_sample_n_mega():
    n, capped = clamp_trajectory_sample_n(5000, mega=True)
    assert n == TRAJECTORY_RENDER_CAP
    assert capped is True
    n2, capped2 = clamp_trajectory_sample_n(100, mega=True)
    assert n2 == 100 and capped2 is False


def test_clamp_trajectory_sample_n_standard_allows_api_max():
    n, capped = clamp_trajectory_sample_n(5000, mega=False)
    assert n == 5000 and capped is False


def test_recommended_forms_per_scale():
    assert recommended_forms("micro") == ["trails", "agents"]
    assert recommended_forms("meso") == ["trails"]
    assert recommended_forms("macro") == ["arcs", "pulse"]
    assert recommended_forms("mega") == ["arcs", "pulse"]


def test_lod_capability_block_macro_recommends_arcs_pulse():
    block = lod_capability_block(
        agent_count=MEGA_AGENT_THRESHOLD,
        trip_count=2_000_000,
        waypoint_count=0,
        has_density_hourly=False,
        has_trajectories=False,
        has_trips=True,
    )
    assert block["mega_sim"] is True
    assert block["scale"] == SCALE_MACRO
    assert block["scale_source"] == "auto"
    assert block["recommended_default_forms"] == ["arcs", "pulse"]
    assert block["trails_default"] is False
    assert block["form_defaults"]["arcs"] is True
    assert block["form_defaults"]["pulse"] is True
    assert block["lod"]["aggregate_first"] is True
    assert block["lod"]["trails_override_allowed"] is True
    assert any("aggregates-only" in tip for tip in block["fix_its"])
    assert "pulse" in block["form_disable_reasons"]


def test_lod_capability_block_micro_trails_not_mega():
    block = lod_capability_block(
        agent_count=100,
        trip_count=500,
        waypoint_count=10_000,
        has_density_hourly=False,
        has_trajectories=True,
        has_trips=True,
    )
    assert block["mega_sim"] is False
    assert block["scale"] == SCALE_MICRO
    assert block["recommended_default_forms"] == ["trails", "agents"]
    assert block["trails_default"] is True
    assert block["form_defaults"]["trails"] is True
    assert block["form_defaults"]["pulse"] is False
    assert block["lod"]["auto_forms"] == []
    # Soft tip only — pulse optional, not a mega-style requirement list.
    assert block["fix_its"] == []
    assert "pulse" in block["form_disable_reasons"]
    assert "optional" in block["form_disable_reasons"]["pulse"].lower()


def test_lod_capability_block_meso():
    block = lod_capability_block(
        agent_count=MICRO_AGENT_MAX + 1,
        trip_count=50_000,
        waypoint_count=500_000,
        has_density_hourly=True,
        has_trajectories=True,
        has_trips=True,
    )
    assert block["scale"] == SCALE_MESO
    assert block["mega_sim"] is False
    assert block["recommended_default_forms"] == ["trails"]
    assert block["fix_its"] == []


def test_lod_capability_block_config_override():
    block = lod_capability_block(
        agent_count=5,
        trip_count=20,
        waypoint_count=200,
        has_density_hourly=True,
        has_trajectories=True,
        has_trips=True,
        scale_override="macro",
    )
    assert block["scale"] == SCALE_MACRO
    assert block["scale_source"] == "config"
    assert block["mega_sim"] is True
    assert block["recommended_default_forms"] == ["arcs", "pulse"]


def test_form_disable_reasons_macro_trails():
    reasons = form_disable_reasons(
        "macro",
        has_density_hourly=True,
        has_trajectories=True,
        has_trips=True,
    )
    assert "trails" in reasons
    assert "pulse" not in reasons


def test_build_fix_its_mega_with_waypoints():
    tips = build_fix_its(
        mega=True,
        has_density_hourly=True,
        has_trajectories=True,
        has_trips=True,
        scale="macro",
    )
    assert any("max-waypoints-per-trip" in t for t in tips)
    assert any("Macro" in t for t in tips)


def test_downsample_waypoints_sql_full_load():
    sql = downsample_waypoints_sql(
        "a, b", "src", "a, b",
        max_waypoints_per_trip=None,
        sample_frac=None,
    )
    assert "ROW_NUMBER" not in sql
    assert "INSERT INTO waypoints (a, b)" in sql


def test_downsample_waypoints_sql_caps_and_frac():
    sql = downsample_waypoints_sql(
        "vehicle_key, trip_id, unix_time_ms, lon, lat",
        "src",
        "vehicle_key, trip_id, unix_time_ms, lon, lat",
        max_waypoints_per_trip=64,
        sample_frac=0.1,
    )
    assert "ROW_NUMBER" in sql
    assert "__wp_rn" in sql
    assert "0.1" not in sql  # uses integer micro-hash threshold
    assert "100000" in sql  # 0.1 * 1e6


def test_downsample_waypoints_sql_rejects_bad_frac():
    with pytest.raises(ValueError):
        downsample_waypoints_sql("a", "t", "a", sample_frac=0.0)
    with pytest.raises(ValueError):
        downsample_waypoints_sql("a", "t", "a", sample_frac=1.5)

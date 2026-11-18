"""Mega-sim LOD policy — thresholds, capability block, ingest SQL, sample clamp."""

from __future__ import annotations

import pytest

from backend.lod import (
    MEGA_AGENT_THRESHOLD,
    MEGA_WAYPOINT_THRESHOLD,
    TRAJECTORY_RENDER_CAP,
    build_fix_its,
    clamp_trajectory_sample_n,
    downsample_waypoints_sql,
    is_mega_sim,
    lod_capability_block,
)


def test_is_mega_sim_agent_threshold():
    assert is_mega_sim(MEGA_AGENT_THRESHOLD, 0) is True
    assert is_mega_sim(MEGA_AGENT_THRESHOLD - 1, 0) is False


def test_is_mega_sim_waypoint_threshold():
    assert is_mega_sim(0, MEGA_WAYPOINT_THRESHOLD) is True
    assert is_mega_sim(0, MEGA_WAYPOINT_THRESHOLD - 1) is False


def test_clamp_trajectory_sample_n_mega():
    n, capped = clamp_trajectory_sample_n(5000, mega=True)
    assert n == TRAJECTORY_RENDER_CAP
    assert capped is True
    n2, capped2 = clamp_trajectory_sample_n(100, mega=True)
    assert n2 == 100 and capped2 is False


def test_clamp_trajectory_sample_n_standard_allows_api_max():
    n, capped = clamp_trajectory_sample_n(5000, mega=False)
    assert n == 5000 and capped is False


def test_lod_capability_block_mega_recommends_arcs_pulse():
    block = lod_capability_block(
        agent_count=MEGA_AGENT_THRESHOLD,
        trip_count=2_000_000,
        waypoint_count=0,
        has_density_hourly=False,
        has_trajectories=False,
        has_trips=True,
    )
    assert block["mega_sim"] is True
    assert block["scale"] == "mega"
    assert block["recommended_default_forms"] == ["arcs", "pulse"]
    assert block["trails_default"] is False
    assert block["lod"]["trails_override_allowed"] is True
    assert any("aggregates-only" in tip for tip in block["fix_its"])


def test_lod_capability_block_standard():
    block = lod_capability_block(
        agent_count=100,
        trip_count=500,
        waypoint_count=10_000,
        has_density_hourly=True,
        has_trajectories=True,
        has_trips=True,
    )
    assert block["mega_sim"] is False
    assert block["scale"] == "standard"
    assert block["recommended_default_forms"] == ["trails"]
    assert block["fix_its"] == []


def test_build_fix_its_mega_with_waypoints():
    tips = build_fix_its(
        mega=True,
        has_density_hourly=True,
        has_trajectories=True,
        has_trips=True,
    )
    assert any("max-waypoints-per-trip" in t for t in tips)


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

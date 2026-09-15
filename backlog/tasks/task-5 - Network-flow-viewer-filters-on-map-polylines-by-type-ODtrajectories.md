---
id: TASK-5
title: 'Network-flow viewer: filters on map, polylines by type, OD+trajectories'
status: In Progress
assignee: []
created_date: '2026-09-15 17:39'
updated_date: '2026-09-15 18:09'
labels: []
dependencies: []
priority: high
type: feature
ordinal: 5000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Improve the viewer so a filtered population is readable on the road network, for both trajectory sources (waypoints/link_id) and origin/destination-only sources (trip files, no waypoints).

Approved plan + review: do not hide OD layers in a Network preset; reconstruct link polylines when waypoints exist; keep origins/destinations/arcs when they do not. DRM/OSM shapefile ingest is a follow-up.

Slices:
0. TripFilters (hour/goods/F1/mode) drive trajectory sample + link-density.
1. link-density returns reconstructed paths + by_group (source_id | transport_mode); MapView PathLayer; reuse linkDensity toggle.
2. Sample 500, follow 20 agents, viewport bbox when zoomed, split MapView memos, layer presets (Trails / Network / Cinematic). Network preset keeps OD layers.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Hour/mode/goods/F1 filters change the map sample and the link overlay, not only Analysis charts
- [ ] #2 With waypoints+link_id, link density draws polylines split by source or transport mode
- [ ] #3 With trips-only (no waypoints), origins, destinations, and OD/source arcs remain visible; Network preset does not hide them
- [ ] #4 Follow up to 20 agents; live sample is 500; zoomed-in view uses bbox query
- [ ] #5 pytest, ruff, frontend vitest+build pass
<!-- AC:END -->

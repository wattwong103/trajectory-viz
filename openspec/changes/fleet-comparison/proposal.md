# Fleet Comparison (A/B) — Proposal

## Why

The user's primary real-world workflow is evaluating a **generated fleet against a
ground-truth fleet of the same persons** (GUFM vs PFLOW-GT, 400 held-out persons,
matched `vehicle_id`s under distinct `vehicle_key` namespaces `gufm:{pid}` /
`pflow:{pid}`). Today the only comparison is eyeballing two colored dot clouds.
The tool should answer: *how do the fleets differ, and where does the model diverge
per person?*

## What changes

1. **Backend** — `GET /api/analysis/compare?source_a&source_b` returning a
   self-contained A/B report:
   - Fleet summaries: trips, vehicles, VKT, avg/median/max distance, active time range
   - Mode-share vectors + delta (percentage points)
   - Hourly departure distributions (24 buckets, both)
   - Distance histogram (shared bucket edges, both)
   - **Matched-person analysis** (only when `vehicle_id` sets overlap): matched count,
     mean trips/person per fleet, per-person trip-count delta distribution
     (mean/median/p90/max), and the top-N persons by absolute delta with their ids
2. **Frontend** — new **Compare** tab in AnalysisPanel:
   - Source A/B pickers (default: first two sources from filter-options)
   - Side-by-side metric cards with delta chips (green/red)
   - Overlaid hourly-departure chart (two series, recharts)
   - Mode-share grouped bars + distance histogram overlay
   - Matched-persons section (rendered only when overlap > 0): delta stats + top-N
     table; each row has a **"Follow pair"** action that follows both
     `a:{pid}` and `b:{pid}` agents on the map (reuses the existing agent-follow /
     `ag=` hash machinery)
3. Respects the shared `TripFilters` hour range where sensible (min/max hour apply to
   both fleets); other filters (speed/dwell/detour/scenario) apply symmetrically via
   the standard filter dependency.

## Non-goals

Map-canvas delta layers (grid diff heatmaps), statistical significance testing,
>2-fleet comparison, per-trip alignment/DTW scoring, export integration.

## Impact

- New: `backend/analysis/compare.py`, `tests/test_compare.py`,
  `frontend/src/components/CompareTab.tsx`, `src/__tests__/compare*.test.ts`
- Modified: `backend/app.py` (or analysis router registration), `backend/models.py`,
  `AnalysisPanel.tsx` (tab), `api.ts`, `types.ts`, docs (README endpoints line,
  ARCHITECTURE one-liner)
- Reuses `build_trip_filter` (invariants #1/#2/#5 respected); read-only; no DDL.
- Perf: a handful of grouped aggregations over indexed `trips` columns — well within
  the analysis-endpoint budget (trips p99 < 1 s).

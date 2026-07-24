# Tasks

- [x] 1. `backend/analysis/compare.py`: compute_comparison + GET /api/analysis/compare
      (source_a/source_b, symmetric TripFilters, top_n; 422 on same source)
- [x] 2. Fleet summaries, mode shares + delta_pp, 24h hourly + out_of_range guard,
      shared-edge distance histogram, matched-person analysis (union join,
      one-side-only = 0, top-N by |delta|)
- [x] 3. Backend tests: 9 new (test_compare.py) — 198 pytest total green; GUFM
      smoke: 4400/870 trips, 400 matched persons, mode-4 −96.13 pp verified
- [x] 4. Frontend CompareTab: source pickers + swap, fleet cards + delta chips,
      hourly overlay, mode-share bars + pp divergence list, distance overlay,
      matched section with Follow-pair (reuses addAgent, ag= hash)
- [x] 5. AnalysisPanel/App wiring (sources, transport_modes, scenario props);
      same-source guard client-side
- [x] 6. Frontend tests: 9 new (compareTab.test.tsx) — 102 vitest total green
- [x] 7. Live GUFM verification: Compare tab renders real divergences
      (Train −96.1 pp, hour-23 spike 1705 vs 1), Follow pair →
      #ag=gufm:240903,pflow:240903
- [x] 8. Docs: README endpoints line

## Later (deferred)

- Map-canvas delta layers (grid diff), significance tests, >2 fleets,
  per-trip alignment scoring, auto-insight line in tab header,
  F1-range pass-through to the compare request

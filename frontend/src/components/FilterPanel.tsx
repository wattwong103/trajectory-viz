/**
 * FilterPanel — vehicle type, time range, and attribute filters.
 *
 * Positioned top-left over the map. Controls which data is fetched and displayed.
 * Also hosts: drill status indicator, layer toggles, and screenshot export button.
 */

import React, { useState } from 'react';
import type { FilterState, StatsResponse, FilterOptions, Trajectory } from '../types';
import type { LayerVisibility } from '../App';

interface FilterPanelProps {
  filter: FilterState;
  stats: StatsResponse | null;
  loading: boolean;
  error: string | null;
  trajectoryCount: number;
  tripCount: number;
  filterOptions: FilterOptions | null;
  drillTrajectories: Trajectory[];
  drillPoint: [number, number] | null;
  drillLoading: boolean;
  layerVisibility: LayerVisibility;
  onChange: (f: FilterState) => void;
  onRefetch: () => void;
  onClearDrill: () => void;
  onLayerToggle: (key: string) => void;
  onScreenshot: () => void;
}

const LAYER_LABELS: Array<{ key: string; label: string }> = [
  { key: 'origins',       label: 'Origins' },
  { key: 'destinations',  label: 'Destinations' },
  { key: 'trajectories',  label: 'Trajectories' },
  { key: 'odFlows',       label: 'OD flows' },
  { key: 'density',       label: 'Heatmap' },
  { key: 'linkDensity',   label: 'Link density' },
  { key: 'clusters',      label: 'Cluster arcs' },
  { key: 'drill',         label: 'Drill results' },
  // F3 overlays (Phase 2 Step 2.7) — segments[] must be populated upstream
  { key: 'speedSegments', label: 'Speed gradient (F3)' },
  { key: 'dwellMarkers',  label: 'Dwell markers (F3)' },
];

/** Relabel EMPTY goods type for display; sort EMPTY last */
function formatGoodsType(g: string): string {
  return g === 'EMPTY' ? '— empty trucks —' : g;
}

function sortGoodsTypes(types: string[]): string[] {
  return [...types].sort((a, b) => {
    if (a === 'EMPTY') return 1;
    if (b === 'EMPTY') return -1;
    return a.localeCompare(b);
  });
}

export const FilterPanel: React.FC<FilterPanelProps> = ({
  filter, stats, loading, error,
  trajectoryCount, tripCount,
  filterOptions,
  drillTrajectories, drillPoint, drillLoading,
  layerVisibility,
  onChange, onRefetch, onClearDrill, onLayerToggle, onScreenshot,
}) => {
  const [layersExpanded, setLayersExpanded] = useState(false);
  const [advancedExpanded, setAdvancedExpanded] = useState(false);

  // F1 slider bounds (per Phase 2 Step 2.2 design choice: Conservative).
  // Adjust these constants to widen/narrow the slider input range.
  const SPEED_BOUND = 80;
  const DWELL_BOUND = 240;
  const DETOUR_MIN_BOUND = 1.0;
  const DETOUR_MAX_BOUND = 3.0;

  // Display-only values; default to bound when filter is undefined (= inactive).
  const minSpeedVal = filter.minSpeed ?? 0;
  const maxSpeedVal = filter.maxSpeed ?? SPEED_BOUND;
  const maxDwellVal = filter.maxDwellMinutes ?? DWELL_BOUND;
  const minDetourVal = filter.minDetourRatio ?? DETOUR_MIN_BOUND;
  const maxDetourVal = filter.maxDetourRatio ?? DETOUR_MAX_BOUND;

  const advancedActive = (
    filter.minSpeed !== undefined ||
    filter.maxSpeed !== undefined ||
    filter.maxDwellMinutes !== undefined ||
    filter.minDetourRatio !== undefined ||
    filter.maxDetourRatio !== undefined
  );

  const resetAdvanced = () => onChange({
    ...filter,
    minSpeed: undefined,
    maxSpeed: undefined,
    maxDwellMinutes: undefined,
    minDetourRatio: undefined,
    maxDetourRatio: undefined,
  });

  const totalTrips = stats?.trips?.row_count ?? 0;
  const totalWaypoints = stats?.waypoints?.row_count ?? 0;
  const noData = !loading && totalTrips === 0;
  const allFilteredOut = !loading && totalTrips > 0 && tripCount === 0 && trajectoryCount === 0;

  return (
    <div style={styles.container}>
      <div style={styles.titleRow}>
        <h2 style={styles.title}>PFLOW Viz</h2>
        <button
          onClick={onScreenshot}
          style={styles.screenshotBtn}
          title="Export PNG screenshot"
        >
          Export PNG
        </button>
      </div>

      {/* Dataset stats */}
      <div style={styles.statsBox}>
        {loading && totalTrips === 0 ? (
          /* Skeleton loading pulse */
          <div>
            <div style={styles.skeletonLine} />
            <div style={{ ...styles.skeletonLine, width: '70%', marginTop: 5 }} />
          </div>
        ) : (
          <>
            <div>{totalTrips.toLocaleString()} trips</div>
            {stats?.trips?.by_vehicle_type && (
              <div style={{ fontSize: 11, marginTop: 1 }}>
                {Object.entries(stats.trips.by_vehicle_type).map(([type, info]) => (
                  <div key={type} style={{ color: type === 'truck' ? '#fd805d' : '#17b8be' }}>
                    {info.count.toLocaleString()} {type}
                  </div>
                ))}
              </div>
            )}
            <div>{totalWaypoints.toLocaleString()} waypoints</div>
            {!stats?.has_trajectories && totalTrips > 0 && (
              <div style={styles.warn}>No trajectory data — run trajectory generator</div>
            )}
            {noData && (
              <div style={styles.warn}>No data — run simulation then ingest</div>
            )}
          </>
        )}
      </div>

      {/* Vehicle type toggle — populated from /api/stats/filter-options (sources.yaml) */}
      <div style={styles.section}>
        <label style={styles.sectionLabel}>Vehicle Type</label>
        <div style={styles.btnGroup}>
          {['', ...(filterOptions?.vehicle_types ?? [])].map(vt => (
            <button
              key={vt || 'all'}
              style={{
                ...styles.toggleBtn,
                ...(filter.vehicleType === vt ? styles.toggleActive : {}),
              }}
              onClick={() => onChange({
                ...filter,
                vehicleType: vt,
                // Clear goods type when switching to a non-truck source (only
                // truck-like sources currently declare goods_type in sources.yaml).
                goodsType: vt && vt !== 'truck' ? undefined : filter.goodsType,
              })}
            >
              {vt === '' ? 'All' : vt.charAt(0).toUpperCase() + vt.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {/* City dropdown */}
      {filterOptions && filterOptions.cities.length > 0 && (
        <div style={styles.section}>
          <label style={styles.sectionLabel}>City</label>
          <select
            value={filter.city ?? ''}
            onChange={e => onChange({ ...filter, city: e.target.value || undefined })}
            style={styles.select}
          >
            <option value="">All cities</option>
            {filterOptions.cities.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
      )}

      {/* Simulation day selector */}
      {filterOptions && filterOptions.simulation_days.length > 1 && (
        <div style={styles.section}>
          <label style={styles.sectionLabel}>Simulation Day</label>
          <select
            value={filter.simulationDay ?? ''}
            onChange={e => onChange({ ...filter, simulationDay: e.target.value === '' ? undefined : Number(e.target.value) })}
            style={styles.select}
          >
            <option value="">All days</option>
            {filterOptions.simulation_days.map(d => <option key={d} value={d}>Day {d}</option>)}
          </select>
        </div>
      )}

      {/* Goods type dropdown — trucks only */}
      {filter.vehicleType !== 'taxi' && filterOptions && filterOptions.goods_types && filterOptions.goods_types.length > 0 && (
        <div style={styles.section}>
          <label style={styles.sectionLabel}>Goods Type</label>
          <select
            value={filter.goodsType ?? ''}
            onChange={e => onChange({ ...filter, goodsType: e.target.value || undefined })}
            style={styles.select}
          >
            <option value="">All goods</option>
            {sortGoodsTypes(filterOptions.goods_types).map(g => (
              <option key={g} value={g}>{formatGoodsType(g)}</option>
            ))}
          </select>
        </div>
      )}

      {/* Time range */}
      <div style={styles.section}>
        <label style={styles.sectionLabel}>
          Time: {String(filter.minHour).padStart(2, '0')}:00 – {String(filter.maxHour).padStart(2, '0')}:00
        </label>
        <div style={styles.row}>
          <input
            type="range" min={0} max={23}
            value={filter.minHour}
            onChange={e => onChange({ ...filter, minHour: Number(e.target.value) })}
            style={styles.rangeInput}
          />
          <input
            type="range" min={0} max={23}
            value={filter.maxHour}
            onChange={e => onChange({ ...filter, maxHour: Number(e.target.value) })}
            style={styles.rangeInput}
          />
        </div>
      </div>

      {/* Advanced filters (F1 derived metrics) — Phase 2 Step 2.2 */}
      <div style={{ marginBottom: 8 }}>
        <button
          onClick={() => setAdvancedExpanded(p => !p)}
          style={styles.layersToggleBtn}
        >
          {advancedExpanded ? '▾' : '▸'} Advanced filters
          {advancedActive && <span style={{ color: '#4fc3f7', marginLeft: 4 }}>•</span>}
        </button>
        {advancedExpanded && (
          <div style={{ marginTop: 6, paddingLeft: 4 }}>
            <div style={styles.section}>
              <label style={styles.sectionLabel}>
                Speed: {minSpeedVal} – {maxSpeedVal} km/h
              </label>
              <div style={styles.row}>
                <input
                  type="range" min={0} max={SPEED_BOUND}
                  value={minSpeedVal}
                  onChange={e => onChange({ ...filter, minSpeed: Number(e.target.value) })}
                  style={styles.rangeInput}
                />
                <input
                  type="range" min={0} max={SPEED_BOUND}
                  value={maxSpeedVal}
                  onChange={e => onChange({ ...filter, maxSpeed: Number(e.target.value) })}
                  style={styles.rangeInput}
                />
              </div>
            </div>
            <div style={styles.section}>
              <label style={styles.sectionLabel}>
                Max dwell: {maxDwellVal} min
              </label>
              <input
                type="range" min={0} max={DWELL_BOUND}
                value={maxDwellVal}
                onChange={e => onChange({ ...filter, maxDwellMinutes: Number(e.target.value) })}
                style={styles.rangeInput}
              />
            </div>
            <div style={styles.section}>
              <label style={styles.sectionLabel}>
                Detour: {minDetourVal.toFixed(2)} – {maxDetourVal.toFixed(2)}
              </label>
              <div style={styles.row}>
                <input
                  type="range" min={DETOUR_MIN_BOUND} max={DETOUR_MAX_BOUND} step="0.01"
                  value={minDetourVal}
                  onChange={e => onChange({ ...filter, minDetourRatio: Number(e.target.value) })}
                  style={styles.rangeInput}
                />
                <input
                  type="range" min={DETOUR_MIN_BOUND} max={DETOUR_MAX_BOUND} step="0.01"
                  value={maxDetourVal}
                  onChange={e => onChange({ ...filter, maxDetourRatio: Number(e.target.value) })}
                  style={styles.rangeInput}
                />
              </div>
            </div>
            {advancedActive && (
              <button onClick={resetAdvanced} style={styles.refreshBtn}>
                Reset advanced
              </button>
            )}
          </div>
        )}
      </div>

      {/* Currently loaded / empty state */}
      <div style={styles.loaded}>
        {loading ? (
          <div>
            <div style={styles.skeletonLine} />
          </div>
        ) : allFilteredOut ? (
          <div style={styles.emptyState}>
            No trips match current filters.
            <br />
            <span style={{ color: '#777' }}>
              Try widening the hour range or selecting 'All cities'.
            </span>
          </div>
        ) : (
          <>
            {trajectoryCount > 0 && <div>{trajectoryCount} trajectories</div>}
            {tripCount > 0 && <div>{tripCount} trip points</div>}
          </>
        )}
        {error && <div style={styles.error}>{error}</div>}
      </div>

      {/* Drill status indicator */}
      {(drillPoint || drillLoading) && (
        <div style={styles.drillBox}>
          {drillLoading ? (
            <span style={{ color: '#ffe566' }}>Querying...</span>
          ) : (
            <>
              <span style={{ color: '#ffe566' }}>
                {drillTrajectories.length} trajectories near (
                {drillPoint![0].toFixed(3)}, {drillPoint![1].toFixed(3)})
              </span>
              <button onClick={onClearDrill} style={styles.drillClearBtn}>
                Clear
              </button>
            </>
          )}
        </div>
      )}

      {/* Layer toggles — collapsible */}
      <div style={{ marginBottom: 8 }}>
        <button
          onClick={() => setLayersExpanded(p => !p)}
          style={styles.layersToggleBtn}
        >
          {layersExpanded ? '▾' : '▸'} Layers
        </button>
        {layersExpanded && (
          <div style={styles.layersList}>
            {LAYER_LABELS.map(({ key, label }) => (
              <label key={key} style={styles.layerRow}>
                <input
                  type="checkbox"
                  checked={layerVisibility[key] ?? true}
                  onChange={() => onLayerToggle(key)}
                  style={{ marginRight: 6, accentColor: '#4fc3f7' }}
                />
                {label}
              </label>
            ))}
          </div>
        )}
      </div>

      <button onClick={onRefetch} style={styles.refreshBtn} disabled={loading}>
        Refresh
      </button>

      {/* Inline keyframe for skeleton pulse */}
      <style>{`
        @keyframes pflow-pulse {
          0%   { opacity: 0.4; }
          50%  { opacity: 0.8; }
          100% { opacity: 0.4; }
        }
      `}</style>
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  container: {
    position: 'absolute',
    top: 16,
    left: 16,
    background: 'rgba(15, 15, 25, 0.92)',
    borderRadius: 12,
    padding: 16,
    color: '#e0e0e0',
    backdropFilter: 'blur(8px)',
    width: 240,
    zIndex: 10,
    fontSize: 13,
  },
  titleRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  title: {
    margin: 0,
    fontSize: 18,
    fontWeight: 700,
    color: '#4fc3f7',
  },
  screenshotBtn: {
    padding: '3px 8px',
    border: '1px solid #555',
    borderRadius: 4,
    background: 'rgba(255,255,255,0.06)',
    color: '#bbb',
    cursor: 'pointer',
    fontSize: 10,
    whiteSpace: 'nowrap' as const,
  },
  statsBox: {
    background: 'rgba(255,255,255,0.05)',
    borderRadius: 6,
    padding: '6px 8px',
    fontSize: 12,
    marginBottom: 12,
    lineHeight: 1.6,
  },
  skeletonLine: {
    height: 10,
    borderRadius: 4,
    background: 'rgba(255,255,255,0.15)',
    animation: 'pflow-pulse 1.4s ease-in-out infinite',
    width: '90%',
  },
  warn: {
    color: '#ffb74d',
    fontSize: 11,
    marginTop: 4,
  },
  emptyState: {
    color: '#ffb74d',
    fontSize: 11,
    lineHeight: 1.5,
  },
  section: {
    marginBottom: 10,
  },
  sectionLabel: {
    fontSize: 11,
    color: '#999',
    textTransform: 'uppercase' as const,
    letterSpacing: 0.5,
    display: 'block',
    marginBottom: 4,
  },
  btnGroup: {
    display: 'flex',
    gap: 4,
  },
  toggleBtn: {
    flex: 1,
    padding: '5px 0',
    border: '1px solid #444',
    borderRadius: 4,
    background: 'transparent',
    color: '#aaa',
    cursor: 'pointer',
    fontSize: 12,
  },
  toggleActive: {
    background: '#1a5276',
    borderColor: '#4fc3f7',
    color: '#fff',
  },
  row: {
    display: 'flex',
    gap: 8,
  },
  rangeInput: {
    flex: 1,
    accentColor: '#4fc3f7',
  },
  loaded: {
    fontSize: 11,
    color: '#888',
    marginBottom: 8,
    lineHeight: 1.5,
  },
  error: {
    color: '#ef5350',
    fontSize: 11,
  },
  drillBox: {
    background: 'rgba(255, 230, 100, 0.08)',
    border: '1px solid rgba(255, 230, 100, 0.3)',
    borderRadius: 6,
    padding: '5px 8px',
    fontSize: 11,
    marginBottom: 8,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 6,
    lineHeight: 1.4,
  },
  drillClearBtn: {
    padding: '2px 7px',
    border: '1px solid rgba(255,230,100,0.4)',
    borderRadius: 4,
    background: 'transparent',
    color: '#ffe566',
    cursor: 'pointer',
    fontSize: 10,
    whiteSpace: 'nowrap' as const,
    flexShrink: 0,
  },
  layersToggleBtn: {
    width: '100%',
    padding: '4px 0',
    border: '1px solid #444',
    borderRadius: 4,
    background: 'transparent',
    color: '#aaa',
    cursor: 'pointer',
    fontSize: 11,
    textAlign: 'left' as const,
    paddingLeft: 6,
    marginBottom: 0,
  },
  layersList: {
    marginTop: 4,
    paddingLeft: 2,
  },
  layerRow: {
    display: 'flex',
    alignItems: 'center',
    fontSize: 11,
    color: '#ccc',
    padding: '2px 0',
    cursor: 'pointer',
  },
  refreshBtn: {
    width: '100%',
    padding: '6px 0',
    border: '1px solid #444',
    borderRadius: 6,
    background: 'rgba(255,255,255,0.05)',
    color: '#ccc',
    cursor: 'pointer',
    fontSize: 12,
  },
  select: {
    width: '100%',
    padding: '5px 8px',
    border: '1px solid #444',
    borderRadius: 4,
    background: 'rgba(255,255,255,0.05)',
    color: '#ccc',
    fontSize: 12,
  },
};

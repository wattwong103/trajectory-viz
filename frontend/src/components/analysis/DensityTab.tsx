import React from 'react';
import { formatCompact } from './shared';
import { CLUSTER_COLORS, styles } from './styles';

export interface DensityTabProps {
  densitySource: 'od' | 'waypoint';
  setDensitySource: (s: 'od' | 'waypoint') => void;
  loading: boolean;
  loadDensity: (source: 'od' | 'waypoint') => void;
  onClearDensity: () => void;
  /** Cells currently drawn on the map heatmap (0 = none). */
  activeCount?: number;
  hotspotsLoading: boolean;
  loadHotspots: () => void;
  hotspotsData: Array<{ lon: number; lat: number; volume: number; unique_vehicles: number; rank: number }>;
}

export const DensityTab: React.FC<DensityTabProps> = ({
  densitySource, setDensitySource, loading, loadDensity, onClearDensity,
  activeCount = 0,
  hotspotsLoading, loadHotspots, hotspotsData,
}) => (
          <div>
            <div style={styles.subtitle}>Spatial Density</div>
            <div style={styles.radioGroup}>
              <label style={styles.radioLabel}>
                <input
                  type="radio"
                  name="densitySource"
                  value="od"
                  checked={densitySource === 'od'}
                  onChange={() => setDensitySource('od')}
                  style={{ marginRight: 4 }}
                />
                Trip OD density
              </label>
              <label style={styles.radioLabel}>
                <input
                  type="radio"
                  name="densitySource"
                  value="waypoint"
                  checked={densitySource === 'waypoint'}
                  onChange={() => setDensitySource('waypoint')}
                  style={{ marginRight: 4 }}
                />
                Waypoint density
              </label>
            </div>
            <p style={styles.desc}>
              {densitySource === 'od'
                ? 'Heatmap of trip origins and destinations (~1km grid).'
                : 'Heatmap of trajectory waypoints (~500m grid).'}
            </p>
            {activeCount > 0 && (
              <div style={styles.mapActive} role="status">
                Heatmap on map · {formatCompact(activeCount)} cells
              </div>
            )}
            <button onClick={() => loadDensity(densitySource)} style={styles.actionBtn} disabled={loading}>
              {loading ? 'Loading…' : activeCount > 0 ? 'Reload Heatmap' : 'Load Heatmap'}
            </button>
            <button onClick={onClearDensity} style={styles.clearBtn} disabled={activeCount === 0}>
              Clear map
            </button>

            <div style={{ marginTop: 10 }}>
              <div style={styles.subtitle}>Top Hotspots</div>
              <button onClick={loadHotspots} style={styles.actionBtn} disabled={hotspotsLoading}>
                {hotspotsLoading ? 'Loading...' : 'Load Hotspots'}
              </button>
              {hotspotsData.length > 0 && (
                <div style={styles.results}>
                  {hotspotsData.map(h => (
                    <div key={h.rank} style={styles.clusterRow}>
                      <span style={{ ...styles.clusterDot, background: CLUSTER_COLORS[(h.rank - 1) % CLUSTER_COLORS.length] }} />
                      <span style={{ minWidth: 16, color: '#888' }}>#{h.rank}</span>
                      <span style={{ flex: 1 }}>{h.lat.toFixed(3)}, {h.lon.toFixed(3)}</span>
                      <span style={{ color: '#4fc3f7' }}>{formatCompact(h.volume)}</span>
                      <span style={{ color: '#888', marginLeft: 4 }}>{formatCompact(h.unique_vehicles)}v</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
);

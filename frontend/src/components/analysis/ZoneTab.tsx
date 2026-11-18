import React from 'react';
import type { TripPoint } from '../../types';
import { styles } from './styles';

export interface ZoneTabProps {
  zoneFormW: string;
  setZoneFormW: (v: string) => void;
  zoneFormS: string;
  setZoneFormS: (v: string) => void;
  zoneFormE: string;
  setZoneFormE: (v: string) => void;
  zoneFormN: string;
  setZoneFormN: (v: string) => void;
  zoneLoading: boolean;
  runZoneQuery: () => void;
  zoneBBox?: { w: number; s: number; e: number; n: number } | null;
  zoneTrips?: TripPoint[];
  onClearZone?: () => void;
  zoneError: string | null;
  showPedestrianize: boolean;
  scenarioActive: boolean;
  onPedestrianize?: (bbox: { w: number; s: number; e: number; n: number }) => void;
  onClearScenario?: () => void;
}

export const ZoneTab: React.FC<ZoneTabProps> = ({
  zoneFormW, setZoneFormW, zoneFormS, setZoneFormS,
  zoneFormE, setZoneFormE, zoneFormN, setZoneFormN,
  zoneLoading, runZoneQuery, zoneBBox, zoneTrips, onClearZone, zoneError,
  showPedestrianize, scenarioActive, onPedestrianize, onClearScenario,
}) => (
          <div>
            <div style={styles.subtitle}>Trips Through Zone</div>
            <p style={styles.desc}>
              Find trips whose trajectories pass through an axis-aligned
              bounding box. Backend: <code>/api/analysis/trip-chains/through-zone-bbox</code>.
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, marginBottom: 6 }}>
              <label style={{ fontSize: 10, color: '#aaa' }}>
                W (lon min)
                <input
                  type="number" step="0.001" value={zoneFormW}
                  onChange={e => setZoneFormW(e.target.value)}
                  style={{ width: '100%', background: '#222', color: '#ddd', border: '1px solid #444', padding: 3, fontSize: 11 }}
                />
              </label>
              <label style={{ fontSize: 10, color: '#aaa' }}>
                S (lat min)
                <input
                  type="number" step="0.001" value={zoneFormS}
                  onChange={e => setZoneFormS(e.target.value)}
                  style={{ width: '100%', background: '#222', color: '#ddd', border: '1px solid #444', padding: 3, fontSize: 11 }}
                />
              </label>
              <label style={{ fontSize: 10, color: '#aaa' }}>
                E (lon max)
                <input
                  type="number" step="0.001" value={zoneFormE}
                  onChange={e => setZoneFormE(e.target.value)}
                  style={{ width: '100%', background: '#222', color: '#ddd', border: '1px solid #444', padding: 3, fontSize: 11 }}
                />
              </label>
              <label style={{ fontSize: 10, color: '#aaa' }}>
                N (lat max)
                <input
                  type="number" step="0.001" value={zoneFormN}
                  onChange={e => setZoneFormN(e.target.value)}
                  style={{ width: '100%', background: '#222', color: '#ddd', border: '1px solid #444', padding: 3, fontSize: 11 }}
                />
              </label>
            </div>
            <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
              <button
                onClick={runZoneQuery}
                disabled={zoneLoading}
                style={styles.actionBtn}
              >
                {zoneLoading ? 'Searching…' : 'Search'}
              </button>
              {(zoneBBox || zoneTrips?.length) && (
                <button onClick={onClearZone} style={styles.clearBtn}>
                  Clear
                </button>
              )}
            </div>
            {zoneError && (
              <div style={{ fontSize: 11, color: '#ff7676', marginBottom: 6 }}>
                {zoneError}
              </div>
            )}
            {/* Phase 4 / B — pedestrianize is a lab plugin; hide when no car
                mode (still show Clear if a scenario is already active). */}
            {zoneBBox && onPedestrianize && (showPedestrianize || scenarioActive) && (
              <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
                {!scenarioActive ? (
                  <button
                    onClick={() => onPedestrianize(zoneBBox)}
                    style={{
                      ...styles.actionBtn,
                      background: 'rgba(231,76,60,0.15)',
                      borderColor: 'rgba(231,76,60,0.5)',
                      color: '#ff8a80',
                    }}
                    title="Exclude car trips whose trajectories enter this zone (query-time; toggle off any time)"
                  >
                    🚫🚗 Pedestrianize this zone
                  </button>
                ) : (
                  <button onClick={onClearScenario} style={styles.clearBtn}>
                    Clear pedestrianize scenario
                  </button>
                )}
              </div>
            )}
            {zoneTrips && zoneTrips.length > 0 && (
              <div style={{ fontSize: 11, color: '#bbb', marginBottom: 4 }}>
                {zoneTrips.length} trip(s) found in bbox
                {zoneTrips.length === 500 && ' (capped at limit=500)'}
              </div>
            )}
            {zoneTrips && zoneTrips.length > 0 && (
              <div style={{ fontSize: 10, fontFamily: 'monospace', maxHeight: 200, overflowY: 'auto' }}>
                {zoneTrips.slice(0, 50).map((t, i) => (
                  <div key={`${t.vehicle_id}-${t.trip_id}-${i}`}
                       style={{ padding: '1px 0', borderBottom: '1px solid #222' }}>
                    {t.vehicle_type} #{t.vehicle_id} trip {t.trip_id}
                    {t.distance_km !== undefined && t.distance_km !== null && (
                      <span style={{ color: '#888' }}> · {t.distance_km.toFixed(1)} km</span>
                    )}
                  </div>
                ))}
                {zoneTrips.length > 50 && (
                  <div style={{ color: '#666', padding: '2px 0' }}>
                    … {zoneTrips.length - 50} more (showing first 50)
                  </div>
                )}
              </div>
            )}
          </div>
);

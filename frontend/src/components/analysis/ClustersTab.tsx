import React from 'react';
import type { ClusterResult, RouteSimilarityResponse } from '../../api';
import { CLUSTER_COLORS, styles } from './styles';

export type ClusterAlgo = 'od_distance' | 'route_similarity';

export interface ClustersTabProps {
  clusterAlgo: ClusterAlgo;
  setClusterAlgo: (a: ClusterAlgo) => void;
  loading: boolean;
  loadClusters: () => void;
  clusterResult: ClusterResult | null;
  /** Clear OD-distance clusters from the map + panel. */
  onClearClusters?: () => void;
  routeSimSampleSize: number;
  setRouteSimSampleSize: (n: number) => void;
  routeSimEps: number;
  setRouteSimEps: (n: number) => void;
  routeSimMinSamples: number;
  setRouteSimMinSamples: (n: number) => void;
  routeSimLoading: boolean;
  loadRouteSimilarity: () => void;
  routeSimResult: RouteSimilarityResponse | null;
}

export const ClustersTab: React.FC<ClustersTabProps> = ({
  clusterAlgo, setClusterAlgo, loading, loadClusters, clusterResult,
  onClearClusters,
  routeSimSampleSize, setRouteSimSampleSize, routeSimEps, setRouteSimEps,
  routeSimMinSamples, setRouteSimMinSamples, routeSimLoading,
  loadRouteSimilarity, routeSimResult,
}) => (
          <div>
            <div style={styles.subtitle}>Trip Clustering</div>
            {/* Algorithm toggle (Sprint A1d) */}
            <div style={{ display: 'flex', gap: 4, marginBottom: 6, fontSize: 11 }}>
              <label style={{ flex: 1, padding: 4, background: clusterAlgo === 'od_distance' ? 'rgba(79,195,247,0.2)' : 'transparent', border: '1px solid #333', borderRadius: 3, cursor: 'pointer' }}>
                <input
                  type="radio" name="cluster-algo" value="od_distance"
                  checked={clusterAlgo === 'od_distance'}
                  onChange={() => setClusterAlgo('od_distance')}
                  style={{ marginRight: 4 }}
                />
                OD + distance
              </label>
              <label style={{ flex: 1, padding: 4, background: clusterAlgo === 'route_similarity' ? 'rgba(79,195,247,0.2)' : 'transparent', border: '1px solid #333', borderRadius: 3, cursor: 'pointer' }}>
                <input
                  type="radio" name="cluster-algo" value="route_similarity"
                  checked={clusterAlgo === 'route_similarity'}
                  onChange={() => setClusterAlgo('route_similarity')}
                  style={{ marginRight: 4 }}
                />
                Route similarity (F3)
              </label>
            </div>

            {clusterAlgo === 'od_distance' && (
              <>
                <p style={styles.desc}>Groups similar trips by OD pattern, distance, and time.</p>
                {clusterResult && (
                  <div style={styles.mapActive} role="status">
                    {clusterResult.num_clusters} clusters on map
                  </div>
                )}
                <button onClick={loadClusters} style={styles.actionBtn} disabled={loading}>
                  {loading ? 'Clustering…' : clusterResult ? 'Re-run Clustering' : 'Run Clustering'}
                </button>
                <button
                  onClick={onClearClusters}
                  style={styles.clearBtn}
                  disabled={!clusterResult}
                >
                  Clear map
                </button>
                {clusterResult && (
                  <div style={styles.results}>
                    <div>{clusterResult.algorithm}: {clusterResult.num_clusters} clusters</div>
                    <div>{clusterResult.total_trips} trips, {clusterResult.noise_count} noise</div>
                    <div style={{ marginTop: 6 }}>
                      {clusterResult.clusters.slice(0, 8).map(c => (
                        <div key={c.cluster_id} style={styles.clusterRow}>
                          <span style={{ ...styles.clusterDot, background: CLUSTER_COLORS[c.cluster_id % CLUSTER_COLORS.length] }} />
                          C{c.cluster_id}: {c.size} trips, ~{c.centroid.avg_distance_km}km, {Math.round(c.centroid.avg_dep_hour)}h
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}

            {clusterAlgo === 'route_similarity' && (
              <>
                <p style={styles.desc}>
                  Jaccard distance over each trajectory's DRM link_id set. Groups trips
                  that share infrastructure. Requires trajectory data (waypoints).
                </p>
                <div style={{ marginBottom: 4 }}>
                  <label style={{ fontSize: 10, color: '#aaa' }}>
                    Sample size: {routeSimSampleSize}
                  </label>
                  <input
                    type="range" min={20} max={2000} step={20}
                    value={routeSimSampleSize}
                    onChange={e => setRouteSimSampleSize(Number(e.target.value))}
                    style={{ width: '100%', accentColor: '#4fc3f7' }}
                  />
                </div>
                <div style={{ marginBottom: 4 }}>
                  <label style={{ fontSize: 10, color: '#aaa' }}>
                    eps (Jaccard dist): {routeSimEps.toFixed(2)}
                  </label>
                  <input
                    type="range" min={0.01} max={0.95} step={0.01}
                    value={routeSimEps}
                    onChange={e => setRouteSimEps(Number(e.target.value))}
                    style={{ width: '100%', accentColor: '#4fc3f7' }}
                  />
                </div>
                <div style={{ marginBottom: 6 }}>
                  <label style={{ fontSize: 10, color: '#aaa' }}>
                    min_samples: {routeSimMinSamples}
                  </label>
                  <input
                    type="range" min={2} max={50} value={routeSimMinSamples}
                    onChange={e => setRouteSimMinSamples(Number(e.target.value))}
                    style={{ width: '100%', accentColor: '#4fc3f7' }}
                  />
                </div>
                <button onClick={loadRouteSimilarity} style={styles.actionBtn} disabled={routeSimLoading}>
                  {routeSimLoading ? 'Clustering…' : 'Run Route Similarity'}
                </button>
                {routeSimResult && (
                  <div style={styles.results}>
                    {routeSimResult.error ? (
                      <div style={{ color: '#ff7676' }}>Error: {routeSimResult.error}</div>
                    ) : (
                      <>
                        <div>{routeSimResult.algorithm}: {routeSimResult.num_clusters} clusters</div>
                        <div>{routeSimResult.total_trips} trips, {routeSimResult.noise_count} noise</div>
                        {routeSimResult.note && (
                          <div style={{ color: '#aaa', fontSize: 10, marginTop: 4 }}>{routeSimResult.note}</div>
                        )}
                        <div style={{ marginTop: 6 }}>
                          {routeSimResult.clusters.slice(0, 8).map(c => (
                            <div key={c.cluster_id} style={styles.clusterRow}>
                              <span style={{ ...styles.clusterDot, background: CLUSTER_COLORS[c.cluster_id % CLUSTER_COLORS.length] }} />
                              C{c.cluster_id}: {c.size} trips · {c.representative.link_count} links
                            </div>
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
);

import React from 'react';
import type { LinkDensityItem } from '../../api';
import { sourceFallbackColor } from '../../sourceColors';
import { transportModeColor } from '../../transportModes';
import { formatCompact } from './shared';
import { styles } from './styles';

export interface LinksTabProps {
  vehicleType: string;
  linkLoading: boolean;
  loadLinkDensity: () => void;
  onClear: () => void;
  linkData: { links: LinkDensityItem[]; count: number; total_links: number } | null;
  colorBy: 'source' | 'transportMode' | string;
}

export const LinksTab: React.FC<LinksTabProps> = ({
  vehicleType, linkLoading, loadLinkDensity, onClear, linkData, colorBy,
}) => (
          <div>
            <div style={styles.subtitle}>Link-Level Road Density</div>
            <p style={styles.desc}>
              Top DRM road links by waypoint count — polylines when trajectories
              exist, colored by source or transport mode. Origin/destination-only
              sources have no links; keep Origins / Destinations / O-D arcs on.
            </p>
            {(vehicleType === 'truck' || vehicleType === 'all') && (
              <div style={styles.warnRibbon}>
                Truck queries take ~25s — please wait after clicking.
              </div>
            )}
            {linkData && linkData.count > 0 && (
              <div style={styles.mapActive} role="status">
                {linkData.count.toLocaleString()} links on map
              </div>
            )}
            <button onClick={loadLinkDensity} style={styles.actionBtn} disabled={linkLoading}>
              {linkLoading ? 'Loading…' : linkData ? 'Reload Top 500 Links' : 'Load Top 500 Links'}
            </button>
            <button
              onClick={onClear}
              style={styles.clearBtn}
              disabled={!linkData}
            >
              Clear map
            </button>
            {linkData && (
              <div style={styles.results}>
                <div style={{ marginBottom: 6, color: '#888' }}>
                  Showing top {linkData.count} of {linkData.total_links.toLocaleString()} total links
                </div>
                {linkData.links.slice(0, 20).map((link, i) => {
                  const intensity = Math.max(0, 1 - i / 20);
                  const dotColor = `rgba(${Math.round(68 + intensity * (253 - 68))}, ${Math.round(1 + intensity * (231 - 1))}, ${Math.round(84 + intensity * (37 - 84))}, 0.9)`;
                  const groups = link.by_group ?? [];
                  return (
                    <div key={link.link_id} style={{ ...styles.clusterRow, flexWrap: 'wrap' as const }}>
                      <span style={{ ...styles.clusterDot, background: dotColor }} />
                      <span style={{ minWidth: 18, color: '#888' }}>#{i + 1}</span>
                      <span style={{ flex: 1, color: '#bbb', fontSize: 9 }}>
                        {link.link_id}
                      </span>
                      <span style={{ color: '#4fc3f7' }}>{formatCompact(link.waypoint_count)}</span>
                      <span style={{ color: '#888', marginLeft: 4 }}>{formatCompact(link.unique_vehicles)}v</span>
                      {groups.length > 0 && (
                        <div style={{ flexBasis: '100%', display: 'flex', height: 4, margin: '3px 0 0 22px', borderRadius: 2, overflow: 'hidden' }}>
                          {groups.map(g => {
                            const rgb = colorBy === 'transportMode'
                              ? transportModeColor(Number(g.key))
                              : sourceFallbackColor(g.key);
                            return (
                              <div
                                key={g.key}
                                title={`${g.key}: ${g.waypoint_count}`}
                                style={{ flex: g.waypoint_count, background: `rgb(${rgb[0]},${rgb[1]},${rgb[2]})` }}
                              />
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
                {linkData.links.length > 20 && (
                  <div style={{ color: '#555', fontSize: 10, marginTop: 4, paddingLeft: 14 }}>
                    + {linkData.links.length - 20} more
                  </div>
                )}
              </div>
            )}
          </div>
);

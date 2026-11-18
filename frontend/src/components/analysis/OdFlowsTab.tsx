import React from 'react';
import { styles } from './styles';

export interface OdFlowsTabProps {
  loading: boolean;
  onLoad: () => void;
  onClear: () => void;
  /** How many OD arcs are currently drawn on the map (0 = none). */
  activeCount?: number;
}

export const OdFlowsTab: React.FC<OdFlowsTabProps> = ({
  loading, onLoad, onClear, activeCount = 0,
}) => (
          <div>
            <div style={styles.subtitle}>OD Flow Arcs</div>
            <p style={styles.desc}>Shows top origin-destination flow pairs as arcs on the map.</p>
            {activeCount > 0 && (
              <div style={styles.mapActive} role="status">
                {activeCount.toLocaleString()} arcs on map
              </div>
            )}
            <button onClick={onLoad} style={styles.actionBtn} disabled={loading}>
              {loading ? 'Loading…' : activeCount > 0 ? 'Reload OD Flows' : 'Load OD Flows'}
            </button>
            <button onClick={onClear} style={styles.clearBtn} disabled={activeCount === 0}>
              Clear map
            </button>
          </div>
);

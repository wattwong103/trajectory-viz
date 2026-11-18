import React from 'react';
import { styles } from './styles';

export interface OdFlowsTabProps {
  loading: boolean;
  onLoad: () => void;
  onClear: () => void;
}

export const OdFlowsTab: React.FC<OdFlowsTabProps> = ({
  loading, onLoad, onClear,
}) => (
          <div>
            <div style={styles.subtitle}>OD Flow Arcs</div>
            <p style={styles.desc}>Shows top origin-destination flow pairs as arcs on the map.</p>
            <button onClick={onLoad} style={styles.actionBtn} disabled={loading}>
              {loading ? 'Loading...' : 'Load OD Flows'}
            </button>
            <button onClick={onClear} style={styles.clearBtn}>Clear</button>
          </div>
);

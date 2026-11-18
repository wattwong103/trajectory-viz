import React from 'react';
import type { MetricsDistribution } from '../../types';
import { MetricHistogram, SkeletonLines } from './shared';
import { styles } from './styles';

export interface MetricsTabProps {
  metricsLoading: boolean;
  metricsError: string | null;
  metricsSpeed: MetricsDistribution | null;
  metricsDwell: MetricsDistribution | null;
  metricsDetour: MetricsDistribution | null;
}

export const MetricsTab: React.FC<MetricsTabProps> = ({
  metricsLoading, metricsError, metricsSpeed, metricsDwell, metricsDetour,
}) => (
          <div>
            <div style={styles.subtitle}>F1 Derived Metrics</div>
            <p style={styles.desc}>
              Per-trip metrics computed at ingest: average speed (needs trajectory data),
              dwell time before next trip, and route detour vs straight-line.
            </p>
            {metricsLoading && <SkeletonLines />}
            {metricsError !== null && !metricsLoading && (
              <div style={styles.errorBox}>{metricsError}</div>
            )}
            {!metricsLoading && (
              <>
                <MetricHistogram title="Speed (km/h)"      dist={metricsSpeed}  precision={0} />
                <MetricHistogram title="Dwell (min)"        dist={metricsDwell}  precision={0} />
                <MetricHistogram title="Detour ratio"       dist={metricsDetour} precision={2} />
              </>
            )}
          </div>
);

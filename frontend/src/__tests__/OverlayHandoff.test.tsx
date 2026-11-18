import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AnalysisPanel } from '../components/AnalysisPanel';
import { OdFlowsTab } from '../components/analysis/OdFlowsTab';
import { TemporalTab } from '../components/analysis/TemporalTab';
import { StatusBanner } from '../components/StatusBanner';

describe('map ↔ analysis overlay handoff', () => {
  const originalWidth = window.innerWidth;

  beforeEach(() => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1200 });
  });

  afterEach(() => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalWidth });
  });

  it('OdFlowsTab shows on-map status and disables Clear when empty', () => {
    const { rerender } = render(
      <OdFlowsTab loading={false} onLoad={vi.fn()} onClear={vi.fn()} activeCount={0} />,
    );
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByRole('button', { name: /clear map/i })).toBeDisabled();

    rerender(
      <OdFlowsTab loading={false} onLoad={vi.fn()} onClear={vi.fn()} activeCount={42} />,
    );
    expect(screen.getByRole('status')).toHaveTextContent(/42 arcs on map/i);
    expect(screen.getByRole('button', { name: /clear map/i })).not.toBeDisabled();
    expect(screen.getByRole('button', { name: /reload od flows/i })).toBeInTheDocument();
  });

  it('marks map-live tabs with “(on map)” in the accessible name', () => {
    render(
      <AnalysisPanel
        vehicleType=""
        hasData
        insights={null}
        insightsLoading={false}
        insightsError={null}
        onODFlows={vi.fn()}
        onDensity={vi.fn()}
        onClusters={vi.fn()}
        onLinkDensity={vi.fn()}
        odFlowCount={12}
        densityCount={0}
        linkCount={0}
        mapHasClusters={false}
      />,
    );
    const expand = screen.queryByRole('button', { name: /^analysis$/i });
    if (expand) fireEvent.click(expand);

    expect(screen.getByRole('button', { name: /origin–destination flows \(on map\)/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^spatial density/i })).toHaveAttribute(
      'aria-label',
      'Spatial density & hotspots',
    );
  });

  it('StatusBanner info tone supports dismiss for overlay clear', () => {
    const onDismiss = vi.fn();
    render(
      <StatusBanner message="OD flows on map · 12 arcs" tone="info" onDismiss={onDismiss} />,
    );
    expect(screen.getByRole('status')).toHaveTextContent(/OD flows on map/);
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

describe('TemporalTab empty vs loading', () => {
  it('shows skeleton while loading with no data', () => {
    const { container } = render(
      <TemporalTab
        temporalError={null}
        temporalLoading
        peaksData={null}
        hourlyData={[]}
        durationData={[]}
      />,
    );
    expect(container.querySelector('[style*="pflow-pulse"], style')).toBeTruthy();
    // Skeleton renders animated bars; empty copy must not appear yet.
    expect(screen.queryByText(/No hourly departures/i)).toBeNull();
  });

  it('shows empty copy when load finished with no rows', () => {
    render(
      <TemporalTab
        temporalError={null}
        temporalLoading={false}
        peaksData={null}
        hourlyData={[]}
        durationData={[]}
      />,
    );
    expect(screen.getByText(/No hourly departures for the current filters/i)).toBeInTheDocument();
  });
});

describe('AnalysisPanel selection handoff', () => {
  const originalWidth = window.innerWidth;

  beforeEach(() => {
    // Start narrow so Analysis begins collapsed.
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 700 });
  });

  afterEach(() => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalWidth });
  });

  it('expands the collapsed panel when a trajectory is selected', () => {
    const traj = {
      id: 'traj-1',
      path: [[139.7, 35.6], [139.71, 35.61]] as [number, number][],
      timestamps: [0, 60],
      metadata: {
        vehicle_key: 'v1',
        vehicle_id: 1,
        vehicle_type: 'taxi',
        trip_id: 1,
      },
    };

    const { rerender } = render(
      <AnalysisPanel
        vehicleType=""
        hasData
        insights={null}
        insightsLoading={false}
        insightsError={null}
        onODFlows={vi.fn()}
        onDensity={vi.fn()}
        onClusters={vi.fn()}
        onLinkDensity={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: /^analysis$/i })).toBeInTheDocument();

    rerender(
      <AnalysisPanel
        vehicleType=""
        hasData
        insights={null}
        insightsLoading={false}
        insightsError={null}
        onODFlows={vi.fn()}
        onDensity={vi.fn()}
        onClusters={vi.fn()}
        onLinkDensity={vi.fn()}
        selectedTrajectory={traj as any}
      />,
    );
    // Collapsed expand control gone; Trip tab visible.
    expect(screen.queryByRole('button', { name: /^analysis$/i })).toBeNull();
    expect(screen.getByRole('button', { name: /selected trajectory detail/i })).toBeInTheDocument();
  });
});

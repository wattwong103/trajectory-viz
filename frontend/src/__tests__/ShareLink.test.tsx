/**
 * FilterPanel Share link — copies the live URL hash for bookmarking.
 * Offline HTML remains a CLI path (viz-export); the button tooltip points there.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { FilterPanel } from '../components/FilterPanel';
import { DEFAULT_FILTER } from '../filterHash';
import { DEFAULT_LAYER_VIS } from '../layerVisibility';
import type { LayerAvailabilityContext } from '../layerCatalog';

function availability(
  overrides: Partial<LayerAvailabilityContext> = {},
): LayerAvailabilityContext {
  return {
    hasTrajectories: true,
    transportModes: [],
    modeLabels: [],
    attrKeys: [],
    hasModes: false,
    hasDensityHourly: null,
    sourceModes: ['trails'],
    megaSim: false,
    simScale: 'meso',
    pulseBuilt: null,
    hasClusterResult: false,
    hasDrillResult: false,
    hasODFlows: false,
    hasDensity: false,
    hasLinkDensity: false,
    hasCompareGrid: false,
    hasFollowedAgents: false,
    hasPois: false,
    hasZones: false,
    ...overrides,
  };
}

const baseProps = {
  filter: DEFAULT_FILTER,
  stats: null,
  loading: false,
  error: null,
  trajectoryCount: 0,
  tripCount: 0,
  filterOptions: null,
  drillTrajectories: [],
  drillPoint: null as [number, number] | null,
  drillLoading: false,
  layerVisibility: DEFAULT_LAYER_VIS,
  layerAvailability: availability(),
  buildingExaggeration: 1,
  scenarioImpact: null,
  onChange: vi.fn(),
  onRefetch: vi.fn(),
  onClearDrill: vi.fn(),
  onLayerToggle: vi.fn(),
  onBuildingExaggeration: vi.fn(),
  onScreenshot: vi.fn(),
};

describe('Share link', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders Share link next to Export PNG', () => {
    render(<FilterPanel {...baseProps} />);
    expect(screen.getByRole('button', { name: 'Share link' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export PNG' })).toBeInTheDocument();
  });

  it('copies via onCopyShareLink and flashes Copied', async () => {
    const onCopyShareLink = vi.fn().mockResolvedValue(undefined);
    render(<FilterPanel {...baseProps} onCopyShareLink={onCopyShareLink} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Share link' }));
    });
    expect(onCopyShareLink).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(1600);
    });
    expect(screen.getByRole('button', { name: 'Share link' })).toBeInTheDocument();
  });

  it('tooltip mentions offline viz-export path', () => {
    render(<FilterPanel {...baseProps} />);
    const btn = screen.getByRole('button', { name: 'Share link' });
    expect(btn.getAttribute('title') || '').toMatch(/viz-export/i);
    expect(btn.getAttribute('title') || '').toMatch(/EXPORT\.md/i);
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AnalysisPanel } from '../components/AnalysisPanel';

describe('AnalysisPanel tab labels', () => {
  const originalWidth = window.innerWidth;

  beforeEach(() => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1200 });
  });

  afterEach(() => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalWidth });
  });

  it('exposes readable short labels instead of symbol-only glyphs', () => {
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
      />,
    );
    // If a prior test left the panel collapsed, expand it.
    const expand = screen.queryByRole('button', { name: /^analysis$/i });
    if (expand) fireEvent.click(expand);

    expect(screen.getByRole('button', { name: /summary insights/i })).toHaveTextContent('Sum');
    expect(screen.getByRole('button', { name: /temporal patterns/i })).toHaveTextContent('Time');
    expect(screen.getByRole('button', { name: /origin–destination/i })).toHaveTextContent('OD');
    expect(screen.getByRole('button', { name: /fleet a⇄b/i })).toHaveTextContent('A⇄B');
  });
});

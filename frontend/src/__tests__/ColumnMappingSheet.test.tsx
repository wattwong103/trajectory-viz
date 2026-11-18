/**
 * Smoke tests for the interactive column-mapping sheet (TV-29 S1).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ColumnMappingSheet } from '../components/ColumnMappingSheet';
import type { UploadMappingFile } from '../types';

const FILE: UploadMappingFile = {
  filename: 'opaque.csv',
  source_id: 'opaque',
  format: 'csv',
  staged_name: 'opaque.csv',
  columns: [
    { name: 'xpos', sample_type: 'number', samples: ['139.7'], guessed_role: null, time_kind: null },
    { name: 'ypos', sample_type: 'number', samples: ['35.6'], guessed_role: null, time_kind: null },
    { name: 'when', sample_type: 'string', samples: ['2024-05-01T00:00:00Z'], guessed_role: null, time_kind: null },
    { name: 'device', sample_type: 'string', samples: ['v1'], guessed_role: null, time_kind: null },
    { name: 'travel_mode', sample_type: 'string', samples: ['Walk'], guessed_role: 'mode', time_kind: null },
  ],
  guesses: {
    lon: null, lat: null, time: null, vehicle_id: null,
    name: null, mode: 'travel_mode', time_kind: null,
  },
  reasons: ['could not identify longitude/latitude columns'],
  tried_candidates: {
    lon: ['lon', 'x'],
    lat: ['lat', 'y'],
    time: ['timestamp', 'ts'],
    vehicle_id: ['vehicle_id', 'device_id'],
  },
};

function selectRole(column: string, roleLabel: string) {
  const row = screen.getByText(column).closest('tr');
  expect(row).toBeTruthy();
  const select = row!.querySelector('select') as HTMLSelectElement;
  fireEvent.change(select, { target: { value: roleLabel } });
}

describe('ColumnMappingSheet', () => {
  it('requires lon/lat/time/agent_id before confirm', () => {
    const onConfirm = vi.fn();
    render(
      <ColumnMappingSheet
        files={[FILE]}
        errorReasons={FILE.reasons}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText('Map columns to ingest')).toBeInTheDocument();
    expect(screen.getByText(/Tried: lon/)).toBeInTheDocument();

    const confirm = screen.getByRole('button', { name: /Confirm & ingest/i });
    expect(confirm).toBeDisabled();
    fireEvent.click(confirm);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('confirms a complete mapping payload', () => {
    const onConfirm = vi.fn();
    render(
      <ColumnMappingSheet
        files={[FILE]}
        errorReasons={[]}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );

    selectRole('xpos', 'lon');
    selectRole('ypos', 'lat');
    selectRole('when', 'time');
    selectRole('device', 'agent_id');

    const confirm = screen.getByRole('button', { name: /Confirm & ingest/i });
    expect(confirm).not.toBeDisabled();
    fireEvent.click(confirm);

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm.mock.calls[0][0]).toEqual([{
      staged_name: 'opaque.csv',
      source_id: 'opaque',
      filename: 'opaque.csv',
      mapping: {
        lon: 'xpos',
        lat: 'ypos',
        time: 'when',
        vehicle_id: 'device',
        mode: 'travel_mode',
      },
    }]);
  });

  it('cancel dismisses without confirming', () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    render(
      <ColumnMappingSheet
        files={[FILE]}
        errorReasons={[]}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Cancel/i }));
    expect(onCancel).toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

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
      kind: 'tracks',
      mapping: {
        kind: 'tracks',
        lon: 'xpos',
        lat: 'ypos',
        time: 'when',
        vehicle_id: 'device',
        mode: 'travel_mode',
      },
    }]);
  });

  it('switches to OD / trips roles and confirms', () => {
    const onConfirm = vi.fn();
    const odFile: UploadMappingFile = {
      ...FILE,
      filename: 'flows.csv',
      source_id: 'flows',
      staged_name: 'flows.csv',
      kind: 'trips',
      suggested_kind: 'trips',
      columns: [
        { name: 'o_x', sample_type: 'number', samples: ['139.7'], guessed_role: null, time_kind: null },
        { name: 'o_y', sample_type: 'number', samples: ['35.6'], guessed_role: null, time_kind: null },
        { name: 'd_x', sample_type: 'number', samples: ['139.8'], guessed_role: null, time_kind: null },
        { name: 'd_y', sample_type: 'number', samples: ['35.7'], guessed_role: null, time_kind: null },
        { name: 'dep', sample_type: 'number', samples: ['3600'], guessed_role: null, time_kind: null },
        { name: 'aid', sample_type: 'string', samples: ['a1'], guessed_role: null, time_kind: null },
        { name: 'tid', sample_type: 'number', samples: ['1'], guessed_role: null, time_kind: null },
      ],
      guesses: {
        start_lon: null, start_lat: null, end_lon: null, end_lat: null,
        starttime: null, vehicle_id: null, trip_id: null, mode: null, time_kind: null,
      },
      reasons: ['could not identify start lon/lat columns'],
      tried_candidates: { start_lon: ['start_lon'], start_lat: ['start_lat'] },
    };
    render(
      <ColumnMappingSheet
        files={[odFile]}
        errorReasons={[]}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: /OD \/ trips table/i })).toHaveAttribute(
      'aria-pressed', 'true',
    );
    selectRole('o_x', 'start_lon');
    selectRole('o_y', 'start_lat');
    selectRole('d_x', 'end_lon');
    selectRole('d_y', 'end_lat');
    selectRole('dep', 'starttime');
    selectRole('aid', 'agent_id');
    selectRole('tid', 'trip_id');
    fireEvent.click(screen.getByRole('button', { name: /Confirm & ingest/i }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm.mock.calls[0][0][0].kind).toBe('trips');
    expect(onConfirm.mock.calls[0][0][0].mapping).toMatchObject({
      kind: 'trips',
      start_lon: 'o_x',
      start_lat: 'o_y',
      end_lon: 'd_x',
      end_lat: 'd_y',
      starttime: 'dep',
      vehicle_id: 'aid',
      trip_id: 'tid',
    });
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

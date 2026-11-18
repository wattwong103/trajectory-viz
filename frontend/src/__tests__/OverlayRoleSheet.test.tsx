import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { OverlayRoleSheet } from '../components/OverlayRoleSheet';

describe('OverlayRoleSheet', () => {
  it('confirms role selection for a zone draft', () => {
    const onConfirm = vi.fn();
    render(
      <OverlayRoleSheet
        drafts={[{
          filename: 'wards.geojson',
          geometry_types: ['Polygon'],
          options: ['zones'],
          role: 'zones',
          label: 'Wards',
          color: '#78d28c',
        }]}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText('Add GeoJSON as…')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Confirm & upload/i }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm.mock.calls[0][0][0].role).toBe('zones');
    expect(onConfirm.mock.calls[0][0][0].label).toBe('Wards');
  });
});

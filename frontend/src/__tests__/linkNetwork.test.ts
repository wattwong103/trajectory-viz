import { describe, it, expect } from 'vitest';
import { strokesFromLinks } from '../utils/linkNetwork';
import type { LinkDensityItem } from '../api';

const PATH: [number, number][] = [[139.6, 35.6], [139.62, 35.61], [139.65, 35.62]];

function link(partial: Partial<LinkDensityItem> & { link_id: string }): LinkDensityItem {
  return {
    waypoint_count: 10,
    unique_vehicles: 2,
    centroid: [139.62, 35.61],
    ...partial,
  };
}

describe('strokesFromLinks', () => {
  it('emits one stroke per group on a reconstructed path', () => {
    const { strokes, centroids } = strokesFromLinks([
      link({
        link_id: 'L101',
        path: PATH,
        by_group: [
          { key: 'truck', waypoint_count: 8, unique_vehicles: 2 },
          { key: 'taxi', waypoint_count: 2, unique_vehicles: 1 },
        ],
      }),
    ], { colorBy: 'source', hiddenSources: new Set() });
    expect(centroids).toHaveLength(0);
    expect(strokes.map(s => s.group)).toEqual(['truck', 'taxi']);
    expect(strokes[0].width).toBeGreaterThan(strokes[1].width);
    expect(strokes[0].path).toEqual(PATH);
  });

  it('drops hidden sources so two types can be compared by toggling', () => {
    const { strokes } = strokesFromLinks([
      link({
        link_id: 'L101',
        path: PATH,
        by_group: [
          { key: 'truck', waypoint_count: 8, unique_vehicles: 2 },
          { key: 'taxi', waypoint_count: 2, unique_vehicles: 1 },
        ],
      }),
    ], { colorBy: 'source', hiddenSources: new Set(['taxi']) });
    expect(strokes.map(s => s.group)).toEqual(['truck']);
  });

  it('falls back to centroids when there is no polyline (single-point links)', () => {
    const { strokes, centroids } = strokesFromLinks([
      link({ link_id: 'L100', path: [[139.6, 35.6]] }),
      link({ link_id: 'L0', path: null }),
    ], { colorBy: 'source', hiddenSources: new Set() });
    expect(strokes).toHaveLength(0);
    expect(centroids.map(c => c.link_id)).toEqual(['L100', 'L0']);
  });

  it('colors by transport mode when requested', () => {
    const { strokes } = strokesFromLinks([
      link({
        link_id: 'L101',
        path: PATH,
        by_group: [{ key: '3', waypoint_count: 4, unique_vehicles: 1 }],
      }),
    ], { colorBy: 'transportMode', hiddenSources: new Set() });
    expect(strokes).toHaveLength(1);
    expect(strokes[0].color.slice(0, 3)).toEqual([231, 76, 60]); // car
  });
});

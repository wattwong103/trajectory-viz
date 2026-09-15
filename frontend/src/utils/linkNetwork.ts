/**
 * Turn link-density API rows into PathLayer strokes (one per group) plus
 * centroid fallbacks for links that have no reconstructed polyline.
 *
 * Trajectory sources with link_id produce strokes. OD-only sources have no
 * rows here — origins/destinations/arcs stay the map representation.
 */

import type { LinkDensityItem, LinkGroupCount } from '../api';
import { transportModeColor } from '../transportModes';
import { sourceFallbackColor } from '../sourceColors';

export type LinkStroke = {
  path: [number, number][];
  color: [number, number, number, number];
  width: number;
  link_id: string;
  group: string;
  waypoint_count: number;
  unique_vehicles: number;
};

export function strokesFromLinks(
  links: LinkDensityItem[],
  opts: {
    colorBy: 'source' | 'transportMode';
    hiddenSources: ReadonlySet<string>;
    colorFor?: (sourceId: string) => [number, number, number];
  },
): { strokes: LinkStroke[]; centroids: LinkDensityItem[] } {
  const colorFor = opts.colorFor ?? sourceFallbackColor;
  const strokes: LinkStroke[] = [];
  const centroids: LinkDensityItem[] = [];

  for (const link of links) {
    const path = link.path;
    const groups = visibleGroups(link, opts.hiddenSources);
    if (!path || path.length < 2) {
      if (groups.length > 0 || opts.hiddenSources.size === 0) {
        centroids.push(link);
      }
      continue;
    }
    const rows = groups.length > 0
      ? groups
      : [{ key: '_all', waypoint_count: link.waypoint_count, unique_vehicles: link.unique_vehicles }];
    // Paint heavier groups first so thinner strokes sit on top.
    const sorted = [...rows].sort((a, b) => b.waypoint_count - a.waypoint_count);
    const maxCount = Math.max(...sorted.map(g => g.waypoint_count), 1);
    for (const g of sorted) {
      const rgb = strokeColor(g.key, opts.colorBy, colorFor);
      const t = Math.log2(1 + g.waypoint_count) / Math.log2(1 + maxCount);
      strokes.push({
        path: path as [number, number][],
        color: [rgb[0], rgb[1], rgb[2], 200],
        width: 1 + 4 * t,
        link_id: link.link_id,
        group: g.key,
        waypoint_count: g.waypoint_count,
        unique_vehicles: g.unique_vehicles,
      });
    }
  }
  return { strokes, centroids };
}

function visibleGroups(
  link: LinkDensityItem,
  hidden: ReadonlySet<string>,
): LinkGroupCount[] {
  const groups = link.by_group ?? [];
  if (hidden.size === 0) return groups;
  return groups.filter(g => !hidden.has(g.key));
}

function strokeColor(
  key: string,
  colorBy: 'source' | 'transportMode',
  colorFor: (sourceId: string) => [number, number, number],
): [number, number, number] {
  if (key === '_all') return [253, 128, 93];
  if (colorBy === 'transportMode') {
    const n = Number(key);
    if (Number.isFinite(n)) return transportModeColor(n);
  }
  return colorFor(key);
}

/**
 * Link-density form — PathLayer + centroid ScatterplotLayer.
 */

import { ScatterplotLayer, PathLayer } from '@deck.gl/layers';
import type { LinkDensityItem } from '../../api';
import { strokesFromLinks, type LinkStroke } from '../../utils/linkNetwork';
import type { SourceStyle } from '../../types';

export interface BuildLinkLayersArgs {
  layerVisibility: { linkDensity?: boolean };
  linkDensityPoints?: LinkDensityItem[];
  colorBy: 'source' | 'transportMode';
  hidden: Set<string>;
  sourceStyles: SourceStyle[];
  colorFor: (vehicleType: string) => [number, number, number];
}

export function buildLinkLayers({
  layerVisibility,
  linkDensityPoints,
  colorBy,
  hidden,
  sourceStyles,
  colorFor,
}: BuildLinkLayersArgs): any[] {
  const result: any[] = [];
  if (layerVisibility.linkDensity && linkDensityPoints && linkDensityPoints.length > 0) {
    const { strokes, centroids } = strokesFromLinks(linkDensityPoints, {
      colorBy, hiddenSources: hidden, colorFor,
    });
    if (strokes.length > 0) {
      result.push(
        new PathLayer<LinkStroke>({
          id: 'link-network',
          data: strokes,
          getPath: (d) => d.path,
          getColor: (d) => d.color,
          getWidth: (d) => d.width,
          widthUnits: 'pixels',
          widthMinPixels: 1,
          widthMaxPixels: 8,
          jointRounded: true,
          capRounded: true,
          pickable: true,
          updateTriggers: { getColor: [colorBy, hidden, sourceStyles] },
        }),
      );
    }
    if (centroids.length > 0) {
      const maxCount = Math.max(...centroids.map(l => l.waypoint_count), 1);
      result.push(
        new ScatterplotLayer<LinkDensityItem>({
          id: 'link-density',
          data: centroids,
          getPosition: (d: LinkDensityItem) => d.centroid,
          getFillColor: (d: LinkDensityItem) => {
            const t = Math.log2(1 + d.waypoint_count) / Math.log2(1 + maxCount);
            return [
              Math.round(68 + t * (253 - 68)),
              Math.round(1 + t * (231 - 1)),
              Math.round(84 + t * (37 - 84)),
              200,
            ] as [number, number, number, number];
          },
          getRadius: (d: LinkDensityItem) => 30 + 20 * Math.log2(1 + d.waypoint_count),
          radiusMinPixels: 3,
          radiusMaxPixels: 20,
          stroked: false,
          pickable: true,
        }),
      );
    }
  }
  return result;
}

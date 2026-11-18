/**
 * Scene / buildings form — MVT or baked extruded buildings, own memo (tile cache).
 */

import { useState, useEffect, useMemo, useRef } from 'react';
import { MVTLayer } from '@deck.gl/geo-layers';
import { PolygonLayer } from '@deck.gl/layers';
import {
  BUILDING_SOURCES, pickBuildingSource, heightRamp, decodePBLD,
  type DecodedBuilding,
} from '../../buildings';

export interface UseBuildingsLayerArgs {
  buildingsOn: boolean;
  buildingsCity: string;
  buildingExaggeration: number;
  viewState: { longitude: number; latitude: number };
}

export function useBuildingsLayer({
  buildingsOn,
  buildingsCity,
  buildingExaggeration,
  viewState,
}: UseBuildingsLayerArgs): { buildingsLayer: any; buildingsOn: boolean } {
  // Phase 3 — resolve the building source from the viewport center, not the
  // city dropdown (which stays as fallback preference). Quantized to ~0.005°
  // (~500 m) so panning doesn't re-resolve every frame — must stay finer
  // than the smallest registered bbox (kichijoji is ~0.023° wide; a 0.05°
  // grid would snap the center right past it).
  const qLon = Math.round(viewState.longitude * 200) / 200;
  const qLat = Math.round(viewState.latitude * 200) / 200;
  const buildingsKey = useMemo(
    () => pickBuildingSource(qLon, qLat, buildingsCity),
    [qLon, qLat, buildingsCity],
  );
  const buildingSource = BUILDING_SOURCES[buildingsKey] ?? null;
  // Decoded baked sets cached per URL — toggling layers or panning away and
  // back must not refetch/redecode. globalThis.Map: the bare name `Map` may
  // be shadowed by react-map-gl in callers; keep the cache unambiguous here.
  const bakedCache = useRef(new globalThis.Map<string, DecodedBuilding[]>());
  const [bakedBuildings, setBakedBuildings] = useState<DecodedBuilding[] | null>(null);

  useEffect(() => {
    if (!buildingsOn || !buildingSource || buildingSource.kind !== 'baked') return;
    const cached = bakedCache.current.get(buildingSource.url);
    if (cached) { setBakedBuildings(cached); return; }
    let cancelled = false;
    // cache: 'no-cache' revalidates with the server even if the HTTP cache
    // holds a "fresh" entry — rescues tabs that cached a bin under the old
    // immutable policy, and picks up re-bakes on reload thereafter.
    fetch(buildingSource.url, { cache: 'no-cache' })
      .then(r => {
        if (!r.ok) throw new Error(`buildings fetch: ${r.status}`);
        return r.arrayBuffer();
      })
      .then(buf => {
        const decoded = decodePBLD(buf).buildings;
        bakedCache.current.set(buildingSource.url, decoded);
        if (!cancelled) setBakedBuildings(decoded);
      })
      .catch(e => console.error('Baked buildings load failed:', e));
    return () => { cancelled = true; };
  }, [buildingsOn, buildingSource]);

  const buildingsLayer = useMemo(() => {
    if (!buildingsOn || !buildingSource) return null;
    if (buildingSource.kind === 'mvt') {
      return new MVTLayer({
        id: 'buildings-3d',
        data: buildingSource.url,
        minZoom: buildingSource.minZoom,
        maxZoom: buildingSource.maxZoom,
        extruded: true,
        getElevation: (f: any) =>
          (f.properties?.[buildingSource.heightAttr] ?? 12) * buildingExaggeration,
        getFillColor: (f: any) => heightRamp(f.properties?.[buildingSource.heightAttr] ?? 12),
        updateTriggers: { getElevation: [buildingExaggeration] },
        opacity: 0.95,
        pickable: false,
        material: { ambient: 0.6, diffuse: 0.4, shininess: 40, specularColor: [30, 40, 60] },
      } as any);
    }
    if (!bakedBuildings) return null;
    return new PolygonLayer<DecodedBuilding>({
      id: 'buildings-3d',
      data: bakedBuildings,
      getPolygon: (d) => d.polygon,
      extruded: true,
      getElevation: (d) => d.height * buildingExaggeration,
      getFillColor: (d) => heightRamp(d.height),
      updateTriggers: { getElevation: [buildingExaggeration] },
      opacity: 0.95,
      stroked: false,
      pickable: false,
      material: { ambient: 0.6, diffuse: 0.4, shininess: 40, specularColor: [30, 40, 60] },
    });
  }, [buildingsOn, buildingSource, bakedBuildings, buildingExaggeration]);

  return { buildingsLayer, buildingsOn };
}

/**
 * 3D buildings registry + decoding (Phase 2C).
 *
 * Two source kinds per city:
 *  - mvt:   streamed vector tiles (Tokyo 23 wards via the indigo-lab PLATEAU
 *           tileset — verified 2026-07: layer 'bldg', attr 'z' = height m,
 *           zoom 10-16, CC-BY-4.0 国土交通省 Project PLATEAU)
 *  - baked: one PBLD binary from /api/buildings/{city}, baked by
 *           scripts/build_buildings.py (format: backend/buildings_io.py)
 */

// bbox: [w, s, e, n] — the source's coverage extent. pickBuildingSource
// resolves the viewport center against these (smallest containing wins).
export type BuildingSource =
  | { kind: 'mvt'; url: string; sourceLayer: string; heightAttr: string; minZoom: number; maxZoom: number; attribution: string; bbox: [number, number, number, number] }
  | { kind: 'baked'; url: string; attribution: string; bbox: [number, number, number, number] };

export const PLATEAU_ATTRIBUTION =
  '建物データ: 国土交通省 Project PLATEAU (CC-BY-4.0)';

export const BUILDING_SOURCES: Record<string, BuildingSource> = {
  tokyo: {
    kind: 'mvt',
    url: 'https://indigo-lab.github.io/plateau-lod2-mvt/{z}/{x}/{y}.pbf',
    sourceLayer: 'bldg',
    heightAttr: 'z',
    minZoom: 10,
    maxZoom: 16,
    attribution: PLATEAU_ATTRIBUTION,
    // 23-wards LOD2 tileset extent (approx)
    bbox: [139.55, 35.50, 139.95, 35.85],
  },
  // Baked cities appear here as scripts/build_buildings.py outputs are added:
  // osaka: { kind: 'baked', url: '/api/buildings/osaka', attribution: PLATEAU_ATTRIBUTION, bbox: [...] },
  kichijoji: {
    kind: 'baked',
    url: '/api/buildings/kichijoji',
    attribution: PLATEAU_ATTRIBUTION,
    // True PBLD vertex extent [139.573, 35.695, 139.590, 35.709], padded.
    bbox: [139.570, 35.692, 139.593, 35.712],
  },
};

/** Resolve which building source to render for a viewport center.
 *
 * Sources whose bbox contains the point are candidates; the smallest-area
 * (most specific) one wins — so panning to Kichijoji picks the baked set
 * over the surrounding Tokyo MVT extent. Falls back to `preferredCity`
 * (the filter's city) when registered, else Tokyo.
 */
export function pickBuildingSource(
  lon: number, lat: number, preferredCity?: string,
): string {
  let best: string | null = null;
  let bestArea = Infinity;
  for (const [city, src] of Object.entries(BUILDING_SOURCES)) {
    const [w, s, e, n] = src.bbox;
    if (lon >= w && lon <= e && lat >= s && lat <= n) {
      const area = (e - w) * (n - s);
      if (area < bestArea) { best = city; bestArea = area; }
    }
  }
  if (best) return best;
  if (preferredCity && BUILDING_SOURCES[preferredCity]) return preferredCity;
  return 'tokyo';
}

/** Night-grid height ramp: deep indigo base → cyan mid-rise → amber accents
 * above 100 m. Log-ish curve so the 6-40 m mass stays differentiated. */
export function heightRamp(h: number): [number, number, number] {
  const hh = Math.max(h, 4);
  if (hh >= 100) return [255, 190, 80];              // amber skyline accents
  const t = Math.min(Math.log(hh / 4) / Math.log(100 / 4), 1);  // 4m→0, 100m→1
  const lerp = (a: number, b: number) => Math.round(a + (b - a) * t);
  if (t < 0.5) {
    const u = t / 0.5;
    return [
      Math.round(14 + (26 - 14) * u),
      Math.round(18 + (90 - 18) * u),
      Math.round(38 + (140 - 38) * u),
    ];
  }
  const u = (t - 0.5) / 0.5;
  return [
    Math.round(26 + (60 - 26) * u),
    Math.round(90 + (220 - 90) * u),
    Math.round(140 + (255 - 140) * u),
  ];
}

// ─── PBLD decoder (mirror of backend/buildings_io.py) ────────────────────

export interface DecodedBuilding {
  polygon: [number, number][][];   // rings[0] outer, rest holes (deck.gl PolygonLayer complex-polygon shape)
  height: number;                  // meters
}

export interface DecodedBuildingSet {
  buildings: DecodedBuilding[];
  synthesized: boolean;
  city: string;
}

export function decodePBLD(buf: ArrayBuffer): DecodedBuildingSet {
  const view = new DataView(buf);
  const magic = new TextDecoder().decode(new Uint8Array(buf, 0, 4));
  if (magic !== 'PBLD') throw new Error('Not a PBLD buffer');
  const headerLen = view.getUint32(4, true);
  const header = JSON.parse(
    new TextDecoder().decode(new Uint8Array(buf, 8, headerLen)),
  );
  let off = 8 + headerLen;

  const nb: number = header.n_buildings;
  const nr: number = header.n_rings;
  const nv: number = header.n_vertices;
  const scale: number = header.scale;
  const olon: number = header.origin_lon;
  const olat: number = header.origin_lat;

  const ringCounts = new Uint8Array(buf, off, nb); off += nb;
  const vertexCounts = new Uint16Array(buf.slice(off, off + nr * 2)); off += nr * 2;
  const heightsDm = new Uint16Array(buf.slice(off, off + nb * 2)); off += nb * 2;
  const ringStarts = new Int32Array(buf.slice(off, off + nr * 8)); off += nr * 8;
  const deltas = new Int16Array(buf.slice(off, off + (nv - nr) * 4));

  const buildings: DecodedBuilding[] = [];
  let ringI = 0;
  let deltaI = 0;
  for (let bi = 0; bi < nb; bi++) {
    const rings: [number, number][][] = [];
    for (let ri = 0; ri < ringCounts[bi]; ri++) {
      const nvtx = vertexCounts[ringI];
      let x = ringStarts[ringI * 2];
      let y = ringStarts[ringI * 2 + 1];
      const ring: [number, number][] = [[olon + x * scale, olat + y * scale]];
      for (let vi = 1; vi < nvtx; vi++) {
        x += deltas[deltaI]; y += deltas[deltaI + 1];
        deltaI += 2;
        ring.push([olon + x * scale, olat + y * scale]);
      }
      rings.push(ring);
      ringI++;
    }
    buildings.push({ polygon: rings, height: heightsDm[bi] / 10 });
  }
  return { buildings, synthesized: !!header.heights_synthesized, city: header.city };
}

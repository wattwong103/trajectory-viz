/**
 * Bbox union math for the first-load auto-fit (universal-trajectory Phase 2
 * UX fix). Pure + dependency-free so it is unit-testable; the camera fit
 * itself (WebMercatorViewport.fitBounds) lives in MapView.
 *
 * Shape matches StatsResponse.trips.by_vehicle_type.<type>.bbox — the only
 * stats field that reliably carries data extent even when the dataset has
 * no city scope (cities: [], city_centers: {}).
 */

export interface Bbox {
  min_lon: number;
  max_lon: number;
  min_lat: number;
  max_lat: number;
}

/**
 * Union of zero or more bboxes. Returns null for empty/all-invalid input so
 * callers can distinguish "no extent known" from a real extent.
 *
 * Garbage rejection: entries with non-finite values or inverted corners
 * (min > max) are skipped rather than poisoning the union. A degenerate
 * point bbox (min == max on both axes) is VALID — it unions to that point
 * and the caller's zoom cap keeps the fit sane.
 */
export function unionBboxes(bboxes: Array<Bbox | null | undefined>): Bbox | null {
  let out: Bbox | null = null;
  for (const b of bboxes) {
    if (!b) continue;
    const vals = [b.min_lon, b.max_lon, b.min_lat, b.max_lat];
    if (vals.some(v => !Number.isFinite(v))) continue;
    if (b.min_lon > b.max_lon || b.min_lat > b.max_lat) continue;
    out = out === null
      ? { ...b }
      : {
          min_lon: Math.min(out.min_lon, b.min_lon),
          max_lon: Math.max(out.max_lon, b.max_lon),
          min_lat: Math.min(out.min_lat, b.min_lat),
          max_lat: Math.max(out.max_lat, b.max_lat),
        };
  }
  return out;
}

/**
 * Color-by-attribute helpers (TV-30 S4).
 *
 * Discrete lab attrs from capabilities.attr_keys drive trail/arc colors via
 * the same hash palette as sources. Continuous metrics (fare_yen) are not
 * colorable here — reuse the speed ramp later if needed.
 */

import { sourceFallbackColor } from './sourceColors';

/** Attr keys safe to expose as Color-by chips when present in attr_keys. */
export const COLORABLE_ATTRS = [
  'goods_type',
  'purpose',
  'taxi_id',
  'passenger_in',
  'cargo_loaded',
  'is_night_trip',
] as const;

export type ColorableAttr = (typeof COLORABLE_ATTRS)[number];

export const ATTR_LEGEND_CAP = 12;

const COLORABLE_SET = new Set<string>(COLORABLE_ATTRS);

export function isColorableAttr(key: string): boolean {
  return COLORABLE_SET.has(key);
}

/** Filter attr_keys to colorable discrete cols (preserve capability order). */
export function colorableAttrKeys(attrKeys: string[] | undefined | null): string[] {
  if (!attrKeys?.length) return [];
  return attrKeys.filter(isColorableAttr);
}

export type ColorByValue = 'source' | 'transportMode' | string;

/** Readable chip label for an attr key. */
export function attrChipLabel(key: string): string {
  return key.replace(/_/g, ' ');
}

/** Normalize a metadata field to a legend/color key (null = missing). */
export function attrValueOf(
  record: Record<string, unknown> | null | undefined,
  key: string,
): string | null {
  if (!record) return null;
  const v = record[key];
  if (v == null || v === '') return null;
  return String(v);
}

/** Deterministic RGB for a categorical attr value (not PFLOW-specific). */
export function attrColor(value: string): [number, number, number] {
  return sourceFallbackColor(`attr:${value}`);
}

export type TrailColorInput = {
  vehicle_type: string;
  transport_mode?: number | null;
  goods_type?: string | null;
  purpose?: number | string | null;
  taxi_id?: string | number | null;
  passenger_in?: string | number | null;
  cargo_loaded?: string | number | null;
  is_night_trip?: string | number | boolean | null;
};

export function resolveTrailColor(
  colorBy: ColorByValue,
  input: TrailColorInput,
  colorFor: (sourceId: string) => [number, number, number],
  transportModeColor: (mode?: number | null) => [number, number, number],
): [number, number, number] {
  if (colorBy === 'transportMode') {
    return transportModeColor(input.transport_mode);
  }
  if (colorBy && colorBy !== 'source' && isColorableAttr(colorBy)) {
    const raw = (input as Record<string, unknown>)[colorBy];
    if (raw == null || raw === '') {
      return [120, 128, 140]; // missing attr → muted grey
    }
    return attrColor(String(raw));
  }
  return colorFor(input.vehicle_type);
}

/** Build a capped legend from distinct attr values on trajectories/trips. */
export function buildAttrLegend(
  values: Iterable<string | null | undefined>,
  cap: number = ATTR_LEGEND_CAP,
): Array<{ value: string; color: [number, number, number]; overflow?: boolean }> {
  const counts = new Map<string, number>();
  for (const v of values) {
    if (v == null || v === '') continue;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const top: Array<{ value: string; color: [number, number, number]; overflow?: boolean }> =
    sorted.slice(0, cap).map(([value]) => ({
      value,
      color: attrColor(value),
    }));
  if (sorted.length > cap) {
    top.push({
      value: `+${sorted.length - cap} more`,
      color: [120, 128, 140],
      overflow: true,
    });
  }
  return top;
}

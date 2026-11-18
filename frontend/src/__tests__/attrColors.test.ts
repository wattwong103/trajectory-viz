import { describe, it, expect } from 'vitest';
import {
  colorableAttrKeys, attrColor, resolveTrailColor, buildAttrLegend,
  isColorableAttr,
} from '../attrColors';

describe('attrColors', () => {
  it('filters attr_keys to colorable discrete cols', () => {
    expect(colorableAttrKeys(['goods_type', 'fare_yen', 'purpose', 'unknown']))
      .toEqual(['goods_type', 'purpose']);
    expect(isColorableAttr('fare_yen')).toBe(false);
  });

  it('hashes attr values stably (not PFLOW-specific)', () => {
    const a = attrColor('shopping');
    const b = attrColor('shopping');
    expect(a).toEqual(b);
    expect(attrColor('work')).not.toEqual(a);
  });

  it('resolveTrailColor honors source | mode | attr', () => {
    const colorFor = () => [1, 2, 3] as [number, number, number];
    const modeColor = () => [9, 9, 9] as [number, number, number];
    const input = {
      vehicle_type: 'truck',
      transport_mode: 3,
      goods_type: 'kibutsu',
    };
    expect(resolveTrailColor('source', input, colorFor, modeColor)).toEqual([1, 2, 3]);
    expect(resolveTrailColor('transportMode', input, colorFor, modeColor)).toEqual([9, 9, 9]);
    expect(resolveTrailColor('goods_type', input, colorFor, modeColor))
      .toEqual(attrColor('kibutsu'));
    expect(resolveTrailColor('goods_type', { ...input, goods_type: null }, colorFor, modeColor))
      .toEqual([120, 128, 140]);
  });

  it('buildAttrLegend caps and overflow', () => {
    const values = Array.from({ length: 20 }, (_, i) => `v${i}`);
    const legend = buildAttrLegend(values, 5);
    expect(legend).toHaveLength(6);
    expect(legend[5].overflow).toBe(true);
    expect(legend[5].value).toMatch(/^\+\d+ more$/);
  });
});

import { describe, it, expect } from 'vitest';
import { appendTripFilters, tripFilterBody } from '../api';

describe('appendTripFilters', () => {
  it('serializes hour, goods, mode, F1, and group-relevant fields', () => {
    const params = new URLSearchParams();
    appendTripFilters(params, {
      vehicleType: 'truck',
      city: 'tokyo',
      simulationDay: 0,
      goodsType: 'kibutsu',
      minHour: 8,
      maxHour: 10,
      transportModes: [0, 3],
      minSpeed: 5,
      maxSpeed: 60,
      maxDwellMinutes: 30,
      minDetourRatio: 1.1,
      maxDetourRatio: 2,
    });
    expect(params.get('vehicle_type')).toBe('truck');
    expect(params.get('city')).toBe('tokyo');
    expect(params.get('simulation_day')).toBe('0');
    expect(params.get('goods_type')).toBe('kibutsu');
    expect(params.get('min_hour')).toBe('8');
    expect(params.get('max_hour')).toBe('10');
    expect(params.get('transport_modes')).toBe('0,3');
    expect(params.get('min_speed')).toBe('5');
    expect(params.get('max_speed')).toBe('60');
    expect(params.get('max_dwell_minutes')).toBe('30');
    expect(params.get('min_detour_ratio')).toBe('1.1');
    expect(params.get('max_detour_ratio')).toBe('2');
  });

  it('skips all-sources and empty optional fields', () => {
    const params = new URLSearchParams();
    appendTripFilters(params, { vehicleType: 'all', minHour: 0 });
    expect(params.get('vehicle_type')).toBeNull();
    expect(params.get('min_hour')).toBe('0');
    expect(params.get('transport_modes')).toBeNull();
  });
});

describe('tripFilterBody', () => {
  it('nulls empty vehicleType and includes hour', () => {
    const body = tripFilterBody({ vehicleType: '', minHour: 7, maxHour: 9 });
    expect(body.vehicle_type).toBeNull();
    expect(body.min_hour).toBe(7);
    expect(body.max_hour).toBe(9);
  });
});

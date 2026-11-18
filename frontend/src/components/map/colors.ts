/**
 * Speed-segment color mapping (F3 / Phase 2 Step 2.7).
 */

// Buckets: idle/slow/medium/fast/highway. Bucket edges chosen to make the
// gradient visible at typical PFLOW urban speeds (most segments fall 0-60).
export function speedToColor(kmh: number | null | undefined): [number, number, number, number] {
  if (kmh === null || kmh === undefined) return [128, 128, 128, 180];  // gray for unknown
  if (kmh < 5)  return [231, 76,  60,  220];   // red — idle/jam
  if (kmh < 20) return [243, 156, 18,  200];   // orange — slow city
  if (kmh < 50) return [241, 196, 15,  200];   // yellow — typical
  if (kmh < 80) return [43,  200, 80,  200];   // green — fast city
  return            [52,  152, 219, 200];      // blue — highway
}

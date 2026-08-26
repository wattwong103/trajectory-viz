/**
 * Tests for the `pc=` URL-hash codec (disabled POI categories).
 *
 * Mirror of App.tsx's encodeDisabledPoiCategories/decodeDisabledPoiCategories
 * — same convention as filter-encoding.test.ts: a change to App.tsx's codec
 * must force a corresponding edit here; the failing test is the alarm.
 *
 * Semantics: `pc=` carries the DISABLED category list (mirroring hs= for
 * hidden sources), so the default state — all categories enabled — encodes
 * to NOTHING and shareable URLs stay clean. Absent key ⇒ all enabled.
 */
import { describe, it, expect } from 'vitest';

// Mirrors the backend category pattern (routers/pois.py).
const POI_CATEGORY_RE = /^[A-Za-z0-9_ \-]{1,40}$/;

function encodeDisabledPoiCategories(disabled: string[]): string {
  if (disabled.length === 0) return '';
  return `pc=${encodeURIComponent(disabled.join(','))}`;
}

function decodeDisabledPoiCategories(hash: string): string[] {
  if (!hash || hash === '#') return [];
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const pc = new URLSearchParams(raw).get('pc');
  if (!pc) return [];
  return pc.split(',').map(s => s.trim()).filter(s => POI_CATEGORY_RE.test(s));
}

describe('pc= disabled-POI-categories hash encoding', () => {
  it('round-trips a disabled list', () => {
    const disabled = ['station', 'school'];
    expect(decodeDisabledPoiCategories('#' + encodeDisabledPoiCategories(disabled)))
      .toEqual(disabled);
  });

  it('round-trips categories containing spaces and hyphens', () => {
    const disabled = ['convenience store', 'warehouse-hub'];
    expect(decodeDisabledPoiCategories('#' + encodeDisabledPoiCategories(disabled)))
      .toEqual(disabled);
  });

  it('encodes nothing when nothing is disabled (default = all enabled)', () => {
    expect(encodeDisabledPoiCategories([])).toBe('');
  });

  it('absent key decodes to an empty list (= all enabled)', () => {
    expect(decodeDisabledPoiCategories('')).toEqual([]);
    expect(decodeDisabledPoiCategories('#')).toEqual([]);
    expect(decodeDisabledPoiCategories('#vt=taxi&tm=3')).toEqual([]);
  });

  it('drops invalid category names (defends against URL injection)', () => {
    const hash = '#pc=' + encodeURIComponent("station,<script>alert(1)</script>,schoo!,ok_one");
    expect(decodeDisabledPoiCategories(hash)).toEqual(['station', 'ok_one']);
  });

  it('drops over-long category names (> 40 chars)', () => {
    const tooLong = 'a'.repeat(41);
    expect(decodeDisabledPoiCategories('#pc=' + encodeURIComponent(`${tooLong},school`)))
      .toEqual(['school']);
  });

  it('coexists with the other hash keys', () => {
    const hash = '#vt=taxi&hs=truck&' + encodeDisabledPoiCategories(['station']);
    expect(decodeDisabledPoiCategories(hash)).toEqual(['station']);
  });

  it('does not double-decode (a literal % survives safely)', () => {
    // '%' is not in the category pattern, so it must be dropped — not throw.
    expect(decodeDisabledPoiCategories('#pc=%25')).toEqual([]);
  });
});

/**
 * Tests for friendlyFetchError — the raw-error → human-message mapping used
 * by the FilterPanel error box.
 */
import { describe, it, expect } from 'vitest';
import { friendlyFetchError } from '../friendlyError';

describe('friendlyFetchError', () => {
  it('maps network TypeErrors to a start-the-backend hint', () => {
    for (const raw of ['TypeError: Failed to fetch', 'NetworkError when attempting to fetch resource.', 'Load failed']) {
      const out = friendlyFetchError(raw);
      expect(out.text).toContain('Backend unreachable');
      expect(out.text).toContain('npm run dev');
      expect(out.retryable).toBe(true);
    }
  });

  it('keeps HTTP errors short and human, surfacing the backend fix-it hint', () => {
    const out = friendlyFetchError('API error: 409 Conflict — density_hourly not built — run: python -m backend.ingest --aggregates-only');
    expect(out.text).toContain('409');
    expect(out.text).toContain('aggregates-only');
    expect(out.retryable).toBe(true);
  });

  it('adds a console hint when the HTTP error has no detail', () => {
    expect(friendlyFetchError('API error: 500 Internal Server Error').text)
      .toBe('Backend error 500 — check the backend console.');
  });

  it('passes through unknown errors trimmed to one line', () => {
    expect(friendlyFetchError('something odd\nwith a second line').text).toBe('something odd');
    const long = 'x'.repeat(300);
    expect(friendlyFetchError(long).text.length).toBeLessThanOrEqual(160);
    expect(friendlyFetchError(long).text.endsWith('…')).toBe(true);
  });
});

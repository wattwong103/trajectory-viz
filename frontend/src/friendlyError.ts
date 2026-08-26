/**
 * friendlyFetchError — map raw fetch/API error strings to short, human,
 * actionable messages for the FilterPanel error box.
 *
 * Raw `TypeError: Failed to fetch` (browser network failure) means the
 * backend isn't reachable; FastAPI errors arrive via fetchJson as
 * "API error: <status> <statusText> — <detail>". Pure + unit-testable.
 */

export interface FriendlyError {
  text: string;
  /** Show a Retry button (transient/network failures). */
  retryable: boolean;
}

const NETWORK_RE = /failed to fetch|network ?error|load failed|econnrefused|err_connection/i;
const API_RE = /^API error: (\d{3})\s*[^—]*(?:—\s*(.*))?$/;

export function friendlyFetchError(raw: string): FriendlyError {
  if (NETWORK_RE.test(raw)) {
    return {
      text: 'Backend unreachable — start it with npm run dev (or trajectory-viz-demo --serve).',
      retryable: true,
    };
  }
  const m = raw.match(API_RE);
  if (m) {
    const status = m[1];
    const detail = (m[2] ?? '').trim();
    // Keep HTTP errors short and human; surface the backend's own fix-it
    // hint when one exists (e.g. the density-hourly 409).
    const text = detail
      ? `Backend error ${status} — ${detail}`
      : `Backend error ${status} — check the backend console.`;
    return { text: truncate(text), retryable: true };
  }
  return { text: truncate(raw), retryable: true };
}

function truncate(s: string, max = 160): string {
  const first = s.split('\n')[0].trim();
  return first.length > max ? first.slice(0, max - 1) + '…' : first;
}

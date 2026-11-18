/**
 * RegistryIssues — actionable sources.yaml / discovery / ingest problems.
 *
 * Backend: GET /api/stats/filter-options → registry.issues (TV-19).
 * Keeps demo/universal UX: renders nothing when issues is empty.
 */

import React, { useState } from 'react';
import type { RegistryIssue, RegistryStatus } from '../types';

interface RegistryIssuesProps {
  registry?: RegistryStatus | null;
  /** Compact panel style (FilterPanel) vs card style (EmptyState). */
  variant?: 'panel' | 'card';
  /** Optional re-fetch after the user fixes YAML / re-ingests. */
  onRetry?: () => void;
}

export const RegistryIssues: React.FC<RegistryIssuesProps> = ({
  registry,
  variant = 'panel',
  onRetry,
}) => {
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const issues = (registry?.issues ?? []).filter(
    (i) => !dismissed.has(issueKey(i)),
  );
  if (issues.length === 0) return null;

  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');
  const heading =
    errors.length > 0
      ? 'Source registry error'
      : 'Source discovery warning';

  return (
    <div
      style={variant === 'card' ? styles.card : styles.panel}
      role="alert"
      data-testid="registry-issues"
    >
      <div style={styles.header}>
        <span style={styles.heading}>{heading}</span>
        {onRetry && (
          <button type="button" onClick={onRetry} style={styles.retryBtn}>
            Retry
          </button>
        )}
      </div>
      {registry?.path && (
        <div style={styles.meta}>
          {registry.profile ? `${registry.profile} · ` : ''}
          <code style={styles.code}>{shortPath(registry.path)}</code>
        </div>
      )}
      <ul style={styles.list}>
        {[...errors, ...warnings].map((issue) => (
          <li key={issueKey(issue)} style={styles.item}>
            <div style={styles.row}>
              <span
                style={{
                  ...styles.badge,
                  background:
                    issue.severity === 'error'
                      ? 'rgba(239,83,80,0.25)'
                      : 'rgba(255,193,7,0.2)',
                  color: issue.severity === 'error' ? '#ef9a9a' : '#ffe082',
                }}
              >
                {issue.severity}
              </span>
              <button
                type="button"
                title="Dismiss"
                onClick={() =>
                  setDismissed((prev) => new Set(prev).add(issueKey(issue)))
                }
                style={styles.dismiss}
              >
                ✕
              </button>
            </div>
            <div style={styles.message}>{issue.message}</div>
            {issue.fix_it && (
              <pre style={styles.fixIt}>{issue.fix_it}</pre>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
};

function issueKey(issue: RegistryIssue): string {
  return `${issue.code}:${issue.source_key ?? ''}:${issue.message}`;
}

/** Display helper — API already redacts to repo-relative / ~/ / ellipsis. */
function shortPath(path: string): string {
  // Already truncated by the backend (…/a/b/c) or short relative/~ form.
  if (path.startsWith('…/') || path.startsWith('~/')) return path;
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.length <= 3) return path;
  return `…/${parts.slice(-3).join('/')}`;
}

const styles: Record<string, React.CSSProperties> = {
  panel: {
    marginTop: 10,
    marginBottom: 4,
    padding: '8px 10px',
    background: 'rgba(60, 24, 24, 0.85)',
    border: '1px solid rgba(239, 83, 80, 0.45)',
    borderRadius: 6,
    fontSize: 11,
    color: '#f0c0c0',
    lineHeight: 1.45,
  },
  card: {
    marginTop: 12,
    marginBottom: 4,
    padding: '12px 14px',
    background: 'rgba(60, 24, 24, 0.9)',
    border: '1px solid rgba(239, 83, 80, 0.5)',
    borderRadius: 8,
    fontSize: 12,
    color: '#f0c0c0',
    lineHeight: 1.5,
    textAlign: 'left',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    marginBottom: 4,
  },
  heading: {
    fontWeight: 700,
    fontSize: 12,
    color: '#ffab91',
  },
  meta: {
    fontSize: 10,
    color: '#a89a9a',
    marginBottom: 6,
  },
  code: {
    fontFamily: 'ui-monospace, Consolas, monospace',
    fontSize: 10,
    color: '#ffe566',
  },
  list: {
    listStyle: 'none',
    margin: 0,
    padding: 0,
  },
  item: {
    marginBottom: 8,
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 6,
    marginBottom: 2,
  },
  badge: {
    fontSize: 9,
    fontWeight: 700,
    textTransform: 'uppercase' as const,
    letterSpacing: 0.4,
    padding: '1px 6px',
    borderRadius: 3,
  },
  dismiss: {
    border: 'none',
    background: 'transparent',
    color: '#c08080',
    cursor: 'pointer',
    fontSize: 11,
    padding: 0,
    lineHeight: 1,
  },
  message: {
    color: '#f0c8c8',
    wordBreak: 'break-word' as const,
  },
  fixIt: {
    margin: '6px 0 0',
    padding: '6px 8px',
    background: 'rgba(0,0,0,0.35)',
    border: '1px solid rgba(255,255,255,0.12)',
    borderRadius: 4,
    fontFamily: 'ui-monospace, Consolas, monospace',
    fontSize: 10,
    color: '#ffe566',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word' as const,
    userSelect: 'all',
  },
  retryBtn: {
    background: 'rgba(79,195,247,0.12)',
    color: '#4fc3f7',
    border: '1px solid rgba(79,195,247,0.35)',
    borderRadius: 4,
    padding: '2px 8px',
    fontSize: 10,
    cursor: 'pointer',
  },
};

/**
 * RegistryIssues — TV-19 UI surface for sources.yaml / discovery errors.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { RegistryIssues } from '../components/RegistryIssues';
import type { RegistryStatus } from '../types';

const sample: RegistryStatus = {
  ok: false,
  profile: 'demo',
  // API redacts to repo-relative (or ~/ / …/) — see inspect_registry.
  path: 'demo/sources.demo.yaml',
  output_root: 'demo',
  source_count: 2,
  issues: [
    {
      severity: 'error',
      code: 'schema_invalid',
      message: 'sources.yaml schema invalid: sources.broken: Field required',
      fix_it:
        'python -m backend.sources_schema --validate demo/sources.demo.yaml',
    },
    {
      severity: 'warning',
      code: 'discovery_empty',
      message: 'No files matched under demo',
      fix_it:
        'python -m backend.sources_schema --discovery demo/sources.demo.yaml --output-root demo',
    },
  ],
};

describe('RegistryIssues', () => {
  it('renders nothing when there are no issues', () => {
    const { container } = render(
      <RegistryIssues registry={{ ...sample, ok: true, issues: [] }} />,
    );
    expect(container.querySelector('[data-testid="registry-issues"]')).toBeNull();
  });

  it('renders nothing when registry is missing', () => {
    const { container } = render(<RegistryIssues />);
    expect(container.querySelector('[data-testid="registry-issues"]')).toBeNull();
  });

  it('shows error heading, messages, and fix-it commands', () => {
    render(<RegistryIssues registry={sample} />);
    expect(screen.getByText('Source registry error')).toBeInTheDocument();
    expect(screen.getByText(/schema invalid/)).toBeInTheDocument();
    expect(screen.getByText(/No files matched/)).toBeInTheDocument();
    expect(screen.getByText(/--validate/)).toBeInTheDocument();
    expect(screen.getByText(/--discovery/)).toBeInTheDocument();
    // Redacted path chip — no absolute FS prefix.
    expect(screen.getByText('demo/sources.demo.yaml')).toBeInTheDocument();
    expect(screen.queryByText(/\/repo\//)).toBeNull();
  });

  it('calls onRetry when Retry is clicked', () => {
    const onRetry = vi.fn();
    render(<RegistryIssues registry={sample} onRetry={onRetry} />);
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('dismisses an individual issue', () => {
    render(<RegistryIssues registry={sample} />);
    const dismissButtons = screen.getAllByTitle('Dismiss');
    fireEvent.click(dismissButtons[0]);
    expect(screen.queryByText(/schema invalid/)).toBeNull();
    expect(screen.getByText(/No files matched/)).toBeInTheDocument();
  });
});

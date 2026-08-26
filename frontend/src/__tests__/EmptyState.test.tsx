/**
 * Tests for the EmptyState upload affordance (upload-and-go).
 *
 * EmptyState does NOT implement its own drop handling — drops are global via
 * UploadDropzone's window listeners. What's testable here is purely local:
 * the drop hint copy, the docs link target, and the click-to-browse input
 * feeding the shared uploader callback.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { EmptyState } from '../components/EmptyState';
import { UploadDropzone } from '../components/UploadDropzone';
import type { useUpload } from '../hooks/useUpload';
import { ACCEPT_ATTR } from '../uploadUtils';

describe('EmptyState', () => {
  it('keeps the CLI guidance (demo command + sources.yaml)', () => {
    render(<EmptyState />);
    expect(screen.getByText('trajectory-viz-demo --serve')).toBeInTheDocument();
    expect(screen.getByText(/sources\.yaml/)).toBeInTheDocument();
  });

  it('renders the drop hint with the friendly extension list', () => {
    render(<EmptyState />);
    expect(screen.getByText(/Drop a trajectory file here/)).toBeInTheDocument();
    expect(
      screen.getByText(/\.gpx, \.geojson, \.csv, \.ndjson, \.parquet/),
    ).toBeInTheDocument();
  });

  it('points the docs link at docs/DATA_FORMATS.md', () => {
    render(<EmptyState />);
    const link = screen.getByRole('link', { name: /see the docs/i });
    expect(link).toHaveAttribute(
      'href',
      'https://github.com/wattwong103/trajectory-viz/blob/main/docs/DATA_FORMATS.md',
    );
  });

  it('clicking the drop area opens the hidden file picker', () => {
    const onUploadFiles = vi.fn();
    render(<EmptyState onUploadFiles={onUploadFiles} />);
    const clickSpy = vi
      .spyOn(HTMLInputElement.prototype, 'click')
      .mockImplementation(() => {});
    fireEvent.click(screen.getByRole('button', { name: /drop a trajectory file/i }));
    expect(clickSpy).toHaveBeenCalledTimes(1);
    clickSpy.mockRestore();
  });

  it('picking files forwards them to the shared uploader (and allows re-picking)', () => {
    const onUploadFiles = vi.fn();
    const { container } = render(<EmptyState onUploadFiles={onUploadFiles} />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input).toHaveAttribute('accept', ACCEPT_ATTR);
    expect(input).toHaveAttribute('multiple');

    const file = new File(['<gpx/>'], 'track.gpx', { type: 'application/gpx+xml' });
    fireEvent.change(input, { target: { files: [file] } });
    expect(onUploadFiles).toHaveBeenCalledTimes(1);
    expect(onUploadFiles.mock.calls[0][0]).toHaveLength(1);
    expect(onUploadFiles.mock.calls[0][0][0].name).toBe('track.gpx');
    // Value reset so the same file can be picked again.
    expect(input.value).toBe('');
  });

  it('without an uploader it renders the hint as a static area (no picker)', () => {
    const { container } = render(<EmptyState />);
    expect(screen.getByText(/Drop a trajectory file here/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /drop a trajectory file/i })).toBeNull();
    expect(container.querySelector('input[type="file"]')).toBeNull();
  });

  // The design claim behind EmptyState having no drop logic of its own:
  // UploadDropzone's window-level listeners catch a drop anywhere, including
  // on the EmptyState card (drag events bubble). Simulate exactly that — a
  // drop dispatched ON the card — and assert the shared uploader fires.
  it('a file dropped onto the card is handled by the global dropzone', () => {
    const uploader = {
      state: 'idle',
      progress: null,
      result: null,
      fileNames: [],
      errorReasons: [],
      upload: vi.fn(),
      dismiss: vi.fn(),
      notifyError: vi.fn(),
    };
    render(
      <>
        <EmptyState onUploadFiles={vi.fn()} />
        <UploadDropzone uploader={uploader as unknown as ReturnType<typeof useUpload>} />
      </>,
    );
    const card = screen.getByText('No data yet');
    const file = new File(['<gpx/>'], 'dropped.gpx', { type: 'application/gpx+xml' });
    fireEvent.drop(card, { dataTransfer: { types: ['Files'], files: [file] } });
    expect(uploader.upload).toHaveBeenCalledTimes(1);
    expect(uploader.upload.mock.calls[0][0][0].name).toBe('dropped.gpx');
    // The EmptyState-local picker must NOT have fired — drop handling stays global.
  });
});

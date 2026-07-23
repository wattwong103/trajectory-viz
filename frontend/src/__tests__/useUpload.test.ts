/**
 * Tests for the useUpload state machine (upload-and-go).
 *
 * global.fetch is stubbed: the first call is the multipart POST (202 or
 * 422/413), subsequent calls are job polls. Poll interval is injected small
 * (5 ms) so real timers keep the tests fast and deterministic enough with
 * testing-library's waitFor.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useUpload } from '../hooks/useUpload';

function res(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `status-${status}`,
    json: async () => body,
  } as Response;
}

const DONE_JOB = {
  job_id: 'job-1',
  status: 'done',
  progress: { phase: 'done', file: null, done_files: 1, total_files: 1 },
  result: {
    trips: 3, waypoints: 120, source_ids: ['track'],
    files: [{ filename: 'track.gpx', source_id: 'track', label: 'track', trips: 3, waypoints: 120, vehicles: 2 }],
  },
  error: null,
  created_at: '2026-01-01T00:00:00',
};

function makeFile(name = 'track.gpx') {
  return new File(['<gpx/>'], name, { type: 'application/gpx+xml' });
}

describe('useUpload', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('idle → uploading → processing → done, storing the result', async () => {
    const mock = vi.mocked(fetch);
    mock
      .mockResolvedValueOnce(res(202, { job_id: 'job-1', status: 'queued', files: [] }))
      .mockResolvedValueOnce(res(200, { ...DONE_JOB, status: 'queued', progress: null, result: null }))
      .mockResolvedValueOnce(res(200, {
        ...DONE_JOB, status: 'running', result: null,
        progress: { phase: 'ingest', file: 'track.gpx', done_files: 0, total_files: 1 },
      }))
      .mockResolvedValueOnce(res(200, DONE_JOB));

    const onDone = vi.fn();
    const { result } = renderHook(() => useUpload({ pollMs: 5, onDone }));

    expect(result.current.state).toBe('idle');
    await act(async () => { result.current.upload([makeFile()]); });
    expect(result.current.state).toBe('processing');

    await waitFor(() => expect(result.current.state).toBe('done'), { timeout: 2000 });
    expect(result.current.result?.trips).toBe(3);
    expect(result.current.result?.files[0].vehicles).toBe(2);
    expect(onDone).toHaveBeenCalledTimes(1);
    // Multipart POST hit the upload endpoint; polls hit the job endpoint
    expect(String(mock.mock.calls[0][0])).toContain('/api/ingest/upload');
    expect(String(mock.mock.calls[1][0])).toContain('/api/ingest/jobs/job-1');
  });

  it('422 surfaces the reasons array', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(res(422, {
      detail: { reasons: ['track.gpx: could not identify a timestamp column (t, time)'] },
    }));
    const { result } = renderHook(() => useUpload({ pollMs: 5 }));
    await act(async () => { result.current.upload([makeFile()]); });
    expect(result.current.state).toBe('error');
    expect(result.current.errorReasons).toEqual([
      'track.gpx: could not identify a timestamp column (t, time)',
    ]);
  });

  it('422 with string detail still produces one reason', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(res(422, { detail: 'no files uploaded' }));
    const { result } = renderHook(() => useUpload({ pollMs: 5 }));
    await act(async () => { result.current.upload([makeFile()]); });
    expect(result.current.state).toBe('error');
    expect(result.current.errorReasons).toEqual(['no files uploaded']);
  });

  it('413 maps to the upload-cap message', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(res(413, {}));
    const { result } = renderHook(() => useUpload({ pollMs: 5 }));
    await act(async () => { result.current.upload([makeFile()]); });
    expect(result.current.state).toBe('error');
    expect(result.current.errorReasons[0]).toContain('200 MB');
  });

  it('job-level error ends polling and surfaces the job error', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(res(202, { job_id: 'job-1', status: 'queued', files: [] }))
      .mockResolvedValueOnce(res(200, { ...DONE_JOB, status: 'error', result: null, error: 'ingest exploded' }));
    const { result } = renderHook(() => useUpload({ pollMs: 5 }));
    await act(async () => { result.current.upload([makeFile()]); });
    await waitFor(() => expect(result.current.state).toBe('error'), { timeout: 2000 });
    expect(result.current.errorReasons).toEqual(['ingest exploded']);
  });

  it('dismiss resets to idle after completion', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(res(202, { job_id: 'job-1', status: 'queued', files: [] }))
      .mockResolvedValueOnce(res(200, DONE_JOB));
    const { result } = renderHook(() => useUpload({ pollMs: 5 }));
    await act(async () => { result.current.upload([makeFile()]); });
    await waitFor(() => expect(result.current.state).toBe('done'), { timeout: 2000 });
    act(() => result.current.dismiss());
    expect(result.current.state).toBe('idle');
    expect(result.current.result).toBeNull();
  });

  it('notifyError surfaces pre-validation failures without an upload', () => {
    const { result } = renderHook(() => useUpload({ pollMs: 5 }));
    act(() => result.current.notifyError(['Unsupported file type: notes.docx']));
    expect(result.current.state).toBe('error');
    expect(result.current.errorReasons).toEqual(['Unsupported file type: notes.docx']);
    expect(fetch).not.toHaveBeenCalled();
  });
});

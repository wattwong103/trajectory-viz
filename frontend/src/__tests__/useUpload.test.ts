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

  it('422 mapping_required opens the mapping state with census files', async () => {
    const mappingFile = {
      filename: 'opaque.csv',
      source_id: 'opaque',
      format: 'csv',
      staged_name: 'opaque.csv',
      columns: [{ name: 'xpos', sample_type: 'number', samples: ['1'], guessed_role: null, time_kind: null }],
      guesses: { lon: null, lat: null, time: null, vehicle_id: null, name: null, mode: null, time_kind: null },
      reasons: ['could not identify longitude/latitude columns'],
      tried_candidates: { lon: ['lon'], lat: ['lat'], time: ['ts'], vehicle_id: ['id'] },
    };
    vi.mocked(fetch).mockResolvedValueOnce(res(422, {
      detail: {
        reasons: ['opaque.csv: could not identify longitude/latitude columns'],
        mapping_required: true,
        files: [mappingFile],
      },
    }));
    const { result } = renderHook(() => useUpload({ pollMs: 5 }));
    await act(async () => { result.current.upload([makeFile('opaque.csv')]); });
    expect(result.current.state).toBe('mapping');
    expect(result.current.mappingFiles).toHaveLength(1);
    expect(result.current.mappingFiles[0].staged_name).toBe('opaque.csv');
  });

  it('confirmMapping posts mapping and polls the job', async () => {
    const mock = vi.mocked(fetch);
    mock
      .mockResolvedValueOnce(res(202, { job_id: 'job-2', status: 'queued', files: [] }))
      .mockResolvedValueOnce(res(200, DONE_JOB));
    const { result } = renderHook(() => useUpload({ pollMs: 5 }));
    await act(async () => {
      await result.current.confirmMapping([{
        staged_name: 'opaque.csv',
        source_id: 'opaque',
        filename: 'opaque.csv',
        mapping: { lon: 'xpos', lat: 'ypos', time: 'when', vehicle_id: 'device' },
      }]);
    });
    await waitFor(() => expect(result.current.state).toBe('done'), { timeout: 2000 });
    expect(String(mock.mock.calls[0][0])).toContain('/api/ingest/upload/confirm');
    const init = mock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(init.body)).files[0].mapping.lon).toBe('xpos');
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

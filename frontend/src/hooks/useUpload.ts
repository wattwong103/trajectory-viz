/**
 * useUpload — upload-and-go ingest state machine.
 *
 *   idle → uploading → processing (1 s job polling) → done | error
 *
 * Owned by App so both the global dropzone and the FilterPanel upload button
 * share one instance. `onDone` fires once when the job reaches 'done' — App
 * uses it to trigger the app-wide refetch (stats / filter-options /
 * trajectories) so the new source appears without a reload.
 *
 * Poll timer is cleared on terminal states, on dismiss(), and on unmount.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  uploadFiles, fetchIngestJob, UploadRejectedError,
} from '../api';
import type {
  UploadAccepted, IngestJobProgress, IngestJobResult,
} from '../types';

export type UploadState = 'idle' | 'uploading' | 'processing' | 'done' | 'error';

interface UseUploadOptions {
  pollMs?: number;          // default 1000; tests pass a small value
  onDone?: () => void;
}

export function useUpload(options: UseUploadOptions = {}) {
  const { pollMs = 1000 } = options;
  const [state, setState] = useState<UploadState>('idle');
  const [progress, setProgress] = useState<IngestJobProgress | null>(null);
  const [result, setResult] = useState<IngestJobResult | null>(null);
  const [fileNames, setFileNames] = useState<string[]>([]);
  const [errorReasons, setErrorReasons] = useState<string[]>([]);

  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onDoneRef = useRef(options.onDone);
  onDoneRef.current = options.onDone;

  const stopPolling = useCallback(() => {
    if (pollTimer.current) {
      clearTimeout(pollTimer.current);
      pollTimer.current = null;
    }
  }, []);

  // Clear any in-flight poll on unmount.
  useEffect(() => stopPolling, [stopPolling]);

  const upload = useCallback(async (files: File[]) => {
    if (files.length === 0) return;
    stopPolling();
    setState('uploading');
    setProgress(null);
    setResult(null);
    setErrorReasons([]);
    setFileNames(files.map(f => f.name));

    let accepted: UploadAccepted;
    try {
      accepted = await uploadFiles(files);
    } catch (e) {
      setErrorReasons(
        e instanceof UploadRejectedError
          ? e.reasons
          : [String((e as Error)?.message ?? e)],
      );
      setState('error');
      return;
    }

    setState('processing');
    const poll = async () => {
      try {
        const job = await fetchIngestJob(accepted.job_id);
        if (job.progress) setProgress(job.progress);
        if (job.status === 'done') {
          pollTimer.current = null;
          setResult(job.result);
          setState('done');
          onDoneRef.current?.();
          return;
        }
        if (job.status === 'error') {
          pollTimer.current = null;
          setErrorReasons([job.error ?? 'Ingest failed']);
          setState('error');
          return;
        }
        pollTimer.current = setTimeout(poll, pollMs);
      } catch (e) {
        pollTimer.current = null;
        setErrorReasons([String((e as Error)?.message ?? e)]);
        setState('error');
      }
    };
    pollTimer.current = setTimeout(poll, pollMs);
  }, [pollMs, stopPolling]);

  const dismiss = useCallback(() => {
    stopPolling();
    setState('idle');
    setProgress(null);
    setResult(null);
    setErrorReasons([]);
    setFileNames([]);
  }, [stopPolling]);

  // Out-of-band failure surface (e.g. dropzone pre-validation rejecting an
  // unsupported extension — nothing was uploaded, but the user needs to know).
  const notifyError = useCallback((reasons: string[]) => {
    stopPolling();
    setErrorReasons(reasons);
    setState('error');
  }, [stopPolling]);

  return { state, progress, result, fileNames, errorReasons,
           upload, dismiss, notifyError };
}

/**
 * useUpload — upload-and-go ingest state machine.
 *
 *   idle → overlay (GeoJSON role chooser) → uploading → processing → done|error
 *        → uploading → mapping | overlay(staged) | processing → …
 *
 * Owned by App so dropzone + FilterPanel share one instance.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  uploadFiles, confirmUploadMapping, confirmUploadOverlay,
  fetchIngestJob, UploadRejectedError,
} from '../api';
import type {
  UploadAccepted, IngestJobProgress, IngestJobResult,
  UploadMappingFile, ConfirmUploadFile, UploadOverlayFile,
  ConfirmOverlayFile, UploadOverlayRole,
} from '../types';
import {
  isGeoJsonUploadName, sniffGeoJsonFile,
} from '../uploadUtils';
import type { OverlayRoleDraft } from '../components/OverlayRoleSheet';
import { draftColorRgb } from '../components/OverlayRoleSheet';

export type UploadState =
  | 'idle' | 'overlay' | 'uploading' | 'mapping' | 'processing' | 'done' | 'error';

interface UseUploadOptions {
  pollMs?: number;
  onDone?: () => void;
}

function stemLabel(name: string): string {
  const base = name.includes('/') ? name.slice(name.lastIndexOf('/') + 1) : name;
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(0, i) : base;
}

export function useUpload(options: UseUploadOptions = {}) {
  const { pollMs = 1000 } = options;
  const [state, setState] = useState<UploadState>('idle');
  const [progress, setProgress] = useState<IngestJobProgress | null>(null);
  const [result, setResult] = useState<IngestJobResult | null>(null);
  const [fileNames, setFileNames] = useState<string[]>([]);
  const [errorReasons, setErrorReasons] = useState<string[]>([]);
  const [mappingFiles, setMappingFiles] = useState<UploadMappingFile[]>([]);
  const [overlayDrafts, setOverlayDrafts] = useState<OverlayRoleDraft[]>([]);
  const [overlayStaged, setOverlayStaged] = useState(false);

  const pendingFilesRef = useRef<File[]>([]);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onDoneRef = useRef(options.onDone);
  onDoneRef.current = options.onDone;

  const stopPolling = useCallback(() => {
    if (pollTimer.current) {
      clearTimeout(pollTimer.current);
      pollTimer.current = null;
    }
  }, []);

  useEffect(() => stopPolling, [stopPolling]);

  const startPolling = useCallback((accepted: UploadAccepted) => {
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
  }, [pollMs]);

  const postUpload = useCallback(async (
    files: File[],
    opts?: {
      roles?: Record<string, string>;
      labels?: Record<string, string>;
      colors?: Record<string, [number, number, number]>;
    },
  ) => {
    setState('uploading');
    setProgress(null);
    setResult(null);
    let accepted: UploadAccepted;
    try {
      accepted = await uploadFiles(files, opts);
    } catch (e) {
      if (e instanceof UploadRejectedError && e.mappingRequired && e.mappingFiles.length > 0) {
        setMappingFiles(e.mappingFiles);
        setErrorReasons(e.reasons);
        setFileNames(e.mappingFiles.map(f => f.filename));
        setOverlayDrafts([]);
        setState('mapping');
        return;
      }
      if (e instanceof UploadRejectedError && e.roleChoiceRequired && e.overlayFiles.length > 0) {
        setOverlayDrafts(e.overlayFiles.map(overlayFileToDraft));
        setOverlayStaged(true);
        setErrorReasons(e.reasons);
        setFileNames(e.overlayFiles.map(f => f.filename));
        setState('overlay');
        return;
      }
      setErrorReasons(
        e instanceof UploadRejectedError
          ? e.reasons
          : [String((e as Error)?.message ?? e)],
      );
      setState('error');
      return;
    }
    setOverlayDrafts([]);
    setMappingFiles([]);
    setOverlayStaged(false);
    pendingFilesRef.current = [];
    startPolling(accepted);
  }, [startPolling]);

  const upload = useCallback(async (files: File[]) => {
    if (files.length === 0) return;
    stopPolling();
    setErrorReasons([]);
    setMappingFiles([]);
    setResult(null);
    setProgress(null);
    setFileNames(files.map(f => f.name));

    const geo = files.filter(f => isGeoJsonUploadName(f.name));
    if (geo.length > 0) {
      const drafts: OverlayRoleDraft[] = [];
      for (const f of geo) {
        const sniff = await sniffGeoJsonFile(f);
        const role = (sniff.suggested_role
          ?? sniff.options[0]
          ?? 'trajectories') as UploadOverlayRole;
        drafts.push({
          filename: f.name,
          geometry_types: sniff.geometry_types,
          options: sniff.options.length ? sniff.options : ['trajectories', 'pois', 'zones'],
          role,
          label: stemLabel(f.name),
          color: '#78d28c',
        });
      }
      pendingFilesRef.current = files;
      setOverlayDrafts(drafts);
      setOverlayStaged(false);
      setState('overlay');
      return;
    }

    await postUpload(files);
  }, [stopPolling, postUpload]);

  const confirmOverlay = useCallback(async (drafts: OverlayRoleDraft[]) => {
    stopPolling();
    setErrorReasons([]);

    if (overlayStaged) {
      setState('uploading');
      const payload: ConfirmOverlayFile[] = drafts.map(d => ({
        staged_name: d.staged_name!,
        source_id: d.source_id,
        filename: d.filename,
        role: d.role,
        label: d.label || undefined,
        color: draftColorRgb(d),
      }));
      let accepted: UploadAccepted;
      try {
        accepted = await confirmUploadOverlay(payload);
      } catch (e) {
        setErrorReasons(
          e instanceof UploadRejectedError
            ? e.reasons
            : [String((e as Error)?.message ?? e)],
        );
        setState('overlay');
        return;
      }
      setOverlayDrafts([]);
      setOverlayStaged(false);
      startPolling(accepted);
      return;
    }

    const roles: Record<string, string> = {};
    const labels: Record<string, string> = {};
    const colors: Record<string, [number, number, number]> = {};
    for (const d of drafts) {
      roles[d.filename] = d.role;
      if (d.label) labels[d.filename] = d.label;
      const rgb = draftColorRgb(d);
      if (rgb) colors[d.filename] = rgb;
    }
    const files = pendingFilesRef.current;
    setOverlayDrafts(drafts);
    await postUpload(files, { roles, labels, colors });
  }, [overlayStaged, stopPolling, startPolling, postUpload]);

  const confirmMapping = useCallback(async (files: ConfirmUploadFile[]) => {
    if (files.length === 0) return;
    stopPolling();
    setState('uploading');
    setProgress(null);
    setResult(null);
    setErrorReasons([]);

    let accepted: UploadAccepted;
    try {
      accepted = await confirmUploadMapping(files);
    } catch (e) {
      if (e instanceof UploadRejectedError) {
        setErrorReasons(e.reasons);
        setState(mappingFiles.length > 0 ? 'mapping' : 'error');
        return;
      }
      setErrorReasons([String((e as Error)?.message ?? e)]);
      setState('error');
      return;
    }

    setMappingFiles([]);
    startPolling(accepted);
  }, [stopPolling, startPolling, mappingFiles.length]);

  const dismiss = useCallback(() => {
    stopPolling();
    setState('idle');
    setProgress(null);
    setResult(null);
    setErrorReasons([]);
    setFileNames([]);
    setMappingFiles([]);
    setOverlayDrafts([]);
    setOverlayStaged(false);
    pendingFilesRef.current = [];
  }, [stopPolling]);

  const notifyError = useCallback((reasons: string[]) => {
    stopPolling();
    setErrorReasons(reasons);
    setMappingFiles([]);
    setOverlayDrafts([]);
    setState('error');
  }, [stopPolling]);

  return {
    state, progress, result, fileNames, errorReasons, mappingFiles,
    overlayDrafts, overlayStaged,
    upload, confirmMapping, confirmOverlay, dismiss, notifyError,
  };
}

function overlayFileToDraft(f: UploadOverlayFile): OverlayRoleDraft {
  const role = (f.suggested_role
    ?? f.options[0]
    ?? 'trajectories') as UploadOverlayRole;
  return {
    filename: f.filename,
    staged_name: f.staged_name,
    source_id: f.source_id,
    geometry_types: f.geometry_types,
    options: f.options.length ? f.options : ['trajectories', 'pois', 'zones'],
    role,
    label: stemLabel(f.filename),
    color: '#78d28c',
  };
}

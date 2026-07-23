/**
 * UploadDropzone — upload-and-go UI: global drag-and-drop overlay, ingest
 * status card, and success/error toasts.
 *
 * Presentational + drag-detection only; the state machine lives in useUpload
 * (owned by App, shared with the FilterPanel upload button).
 *
 * Drag detection: window-level dragenter/leave with a counter (enter events
 * fire per hovered child element — a bare boolean flickers), dragover
 * preventDefault (required or drop won't fire), and drop. The overlay only
 * appears when the drag actually carries files (dataTransfer.types includes
 * 'Files') — not when dragging text/links inside the page.
 *
 * Visual language mirrors EmptyState (overlay/card) and the App toasts.
 */

import React, { useState, useEffect, useRef } from 'react';
import type { useUpload } from '../hooks/useUpload';
import { isAcceptedFile, phaseLabel, ACCEPTED_EXTENSIONS } from '../uploadUtils';

const SUCCESS_DISMISS_MS = 6000;

interface UploadDropzoneProps {
  uploader: ReturnType<typeof useUpload>;
}

export const UploadDropzone: React.FC<UploadDropzoneProps> = ({ uploader }) => {
  const { state, progress, result, fileNames, errorReasons,
          upload, dismiss, notifyError } = uploader;
  const [dragActive, setDragActive] = useState(false);
  const dragCounter = useRef(0);

  useEffect(() => {
    const hasFiles = (e: DragEvent) =>
      Array.from(e.dataTransfer?.types ?? []).includes('Files');
    const onDragEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragCounter.current += 1;
      setDragActive(true);
    };
    const onDragOver = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();   // required, or drop never fires
    };
    const onDragLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      dragCounter.current = Math.max(0, dragCounter.current - 1);
      if (dragCounter.current === 0) setDragActive(false);
    };
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragCounter.current = 0;
      setDragActive(false);
      const files = Array.from(e.dataTransfer?.files ?? []);
      const accepted = files.filter(f => isAcceptedFile(f.name));
      if (accepted.length > 0) {
        upload(accepted);
      } else if (files.length > 0) {
        notifyError([
          `Unsupported file type: ${files.map(f => f.name).join(', ')}`,
          `Accepted: ${ACCEPTED_EXTENSIONS.join(' ')}`,
        ]);
      }
      // Mixed drops: the accepted files upload; rejected ones are ignored
      // (the backend would 422 the whole batch otherwise).
    };
    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [upload, notifyError]);

  // Success toast auto-dismisses; error toasts stay until dismissed.
  useEffect(() => {
    if (state !== 'done') return;
    const t = setTimeout(dismiss, SUCCESS_DISMISS_MS);
    return () => clearTimeout(t);
  }, [state, dismiss]);

  return (
    <>
      {dragActive && (
        <div style={styles.overlay}>
          <div style={styles.dropTarget}>
            <div style={styles.dropTitle}>Drop trajectory files to visualize</div>
            <div style={styles.dropCaption}>
              .gpx .geojson .csv .ndjson .parquet — up to 200 MB per file
            </div>
          </div>
        </div>
      )}

      {(state === 'uploading' || state === 'processing') && (
        <div style={styles.statusCard}>
          <div style={styles.statusFiles}>{fileNames.join(', ')}</div>
          <div style={styles.statusPhase}>
            {state === 'uploading' ? 'Uploading…' : phaseLabel(progress)}
          </div>
          <div style={styles.progressTrack}>
            {progress && progress.total_files > 0 ? (
              <div style={{
                ...styles.progressFill,
                width: `${Math.round((progress.done_files / progress.total_files) * 100)}%`,
              }} />
            ) : (
              <div style={{ ...styles.progressFill, ...styles.progressIndeterminate }} />
            )}
          </div>
        </div>
      )}

      {state === 'done' && result && (
        <div style={{ ...styles.toast, ...styles.toastSuccess }}>
          <div style={{ flex: 1 }}>
            {result.files.map(f => (
              <div key={f.filename} style={styles.toastLine}>
                Added '{f.filename}': {f.trips.toLocaleString()} trips, {f.vehicles.toLocaleString()} vehicles
              </div>
            ))}
            {result.files.length === 0 && (
              <div style={styles.toastLine}>
                Added {result.trips.toLocaleString()} trips.
              </div>
            )}
          </div>
          <button onClick={dismiss} style={styles.toastClose} title="Dismiss">✕</button>
        </div>
      )}

      {state === 'error' && (
        <div style={{ ...styles.toast, ...styles.toastError }}>
          <div style={{ flex: 1 }}>
            {errorReasons.map((r, i) => (
              <div key={i} style={styles.toastLine}>{r}</div>
            ))}
          </div>
          <button onClick={dismiss} style={{ ...styles.toastClose, color: '#ef9a9a' }} title="Dismiss">
            ✕
          </button>
        </div>
      )}
      {/* Inline keyframe for the indeterminate progress bar */}
      <style>{`
        @keyframes upload-slide {
          0%   { margin-left: -40%; }
          100% { margin-left: 100%; }
        }
      `}</style>
    </>
  );
};

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'absolute',
    inset: 0,
    background: 'rgba(10, 12, 18, 0.72)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 30,
    backdropFilter: 'blur(2px)',
    pointerEvents: 'none',   // drop target is the window; keep visuals only
  },
  dropTarget: {
    border: '2px dashed rgba(79, 195, 247, 0.8)',
    borderRadius: 16,
    padding: '48px 64px',
    textAlign: 'center',
    background: 'rgba(15, 15, 25, 0.85)',
  },
  dropTitle: {
    fontSize: 20,
    fontWeight: 700,
    color: '#4fc3f7',
    marginBottom: 8,
  },
  dropCaption: {
    fontSize: 12,
    color: '#8a94a5',
  },
  statusCard: {
    position: 'absolute',
    bottom: 96,               // above the TimeSlider bar
    left: '50%',
    transform: 'translateX(-50%)',
    minWidth: 280,
    maxWidth: 420,
    background: 'rgba(15, 15, 25, 0.92)',
    border: '1px solid rgba(255,255,255,0.12)',
    borderRadius: 10,
    padding: '12px 16px',
    color: '#e0e0e0',
    zIndex: 20,
    backdropFilter: 'blur(8px)',
  },
  statusFiles: {
    fontSize: 12,
    fontWeight: 600,
    color: '#ddd',
    marginBottom: 4,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  statusPhase: {
    fontSize: 11,
    color: '#8ab4d8',
    marginBottom: 8,
  },
  progressTrack: {
    height: 4,
    borderRadius: 2,
    background: 'rgba(255,255,255,0.10)',
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    background: '#4fc3f7',
    borderRadius: 2,
    transition: 'width 0.4s ease',
  },
  progressIndeterminate: {
    width: '40%',
    animation: 'upload-slide 1.2s ease-in-out infinite',
  },
  toast: {
    position: 'absolute',
    bottom: 96,
    left: '50%',
    transform: 'translateX(-50%)',
    display: 'flex',
    alignItems: 'flex-start',
    gap: 10,
    minWidth: 280,
    maxWidth: 460,
    borderRadius: 8,
    padding: '10px 14px',
    fontSize: 12,
    zIndex: 20,
    backdropFilter: 'blur(8px)',
  },
  toastSuccess: {
    background: 'rgba(15, 35, 20, 0.92)',
    border: '1px solid rgba(67, 200, 100, 0.5)',
    color: '#b8e6c4',
  },
  toastError: {
    background: 'rgba(60, 20, 20, 0.92)',
    border: '1px solid rgba(239, 83, 80, 0.5)',
    color: '#ef9a9a',
  },
  toastLine: {
    lineHeight: 1.6,
  },
  toastClose: {
    border: 'none',
    background: 'transparent',
    color: '#b8e6c4',
    cursor: 'pointer',
    fontSize: 12,
    padding: 0,
    flexShrink: 0,
  },
};

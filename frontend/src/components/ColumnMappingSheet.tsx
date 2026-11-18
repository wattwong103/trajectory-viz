/**
 * ColumnMappingSheet — interactive role assignment when upload sniff fails.
 *
 * Assigns lon | lat | time | agent_id | name | mode | ignore per column,
 * optional time_kind + mode_map JSON. Confirm posts to /upload/confirm.
 */

import React, { useMemo, useState } from 'react';
import type {
  UploadMappingFile,
  ColumnMappingRole,
  UploadTimeKind,
  ConfirmUploadFile,
  ColumnMappingRequest,
} from '../types';

const ROLES: { value: ColumnMappingRole; label: string }[] = [
  { value: 'ignore', label: 'Ignore' },
  { value: 'lon', label: 'Longitude' },
  { value: 'lat', label: 'Latitude' },
  { value: 'time', label: 'Time' },
  { value: 'agent_id', label: 'Agent / device id' },
  { value: 'name', label: 'Name (optional)' },
  { value: 'mode', label: 'Mode (optional)' },
];

const TIME_KINDS: { value: UploadTimeKind; label: string }[] = [
  { value: 'iso', label: 'ISO-8601' },
  { value: 'epoch_ms', label: 'Epoch ms' },
  { value: 'epoch_s', label: 'Epoch seconds' },
];

const REQUIRED: ColumnMappingRole[] = ['lon', 'lat', 'time', 'agent_id'];

interface ColumnMappingSheetProps {
  files: UploadMappingFile[];
  errorReasons: string[];
  busy?: boolean;
  onConfirm: (files: ConfirmUploadFile[]) => void;
  onCancel: () => void;
}

type FileDraft = {
  roles: Record<string, ColumnMappingRole>;
  timeKind: UploadTimeKind | '';
  modeMapText: string;
};

function initialDraft(file: UploadMappingFile): FileDraft {
  const roles: Record<string, ColumnMappingRole> = {};
  for (const col of file.columns) {
    roles[col.name] = (col.guessed_role as ColumnMappingRole | null) ?? 'ignore';
  }
  // Apply top-level guesses when census entries lack guessed_role.
  const g = file.guesses;
  const assign = (role: ColumnMappingRole, col: string | null) => {
    if (col && roles[col] !== undefined) roles[col] = role;
  };
  assign('lon', g.lon);
  assign('lat', g.lat);
  assign('time', g.time);
  assign('agent_id', g.vehicle_id);
  assign('name', g.name);
  assign('mode', g.mode);

  return {
    roles,
    timeKind: g.time_kind ?? '',
    modeMapText: '',
  };
}

function roleToColumn(roles: Record<string, ColumnMappingRole>, role: ColumnMappingRole): string | undefined {
  return Object.entries(roles).find(([, r]) => r === role)?.[0];
}

export const ColumnMappingSheet: React.FC<ColumnMappingSheetProps> = ({
  files,
  errorReasons,
  busy = false,
  onConfirm,
  onCancel,
}) => {
  const [drafts, setDrafts] = useState<Record<string, FileDraft>>(() => {
    const init: Record<string, FileDraft> = {};
    for (const f of files) init[f.staged_name] = initialDraft(f);
    return init;
  });
  const [localError, setLocalError] = useState<string | null>(null);

  const validation = useMemo(() => {
    const problems: string[] = [];
    for (const f of files) {
      const d = drafts[f.staged_name];
      if (!d) continue;
      for (const role of REQUIRED) {
        if (!roleToColumn(d.roles, role)) {
          problems.push(`${f.filename}: assign a ${role === 'agent_id' ? 'agent/device id' : role} column`);
        }
      }
      const timeCol = roleToColumn(d.roles, 'time');
      if (timeCol && !d.timeKind) {
        // Allow empty if samples look inferable — backend will try; warn softly.
      }
      if (d.modeMapText.trim()) {
        try {
          const parsed = JSON.parse(d.modeMapText);
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            problems.push(`${f.filename}: mode_map must be a JSON object`);
          }
          if (!roleToColumn(d.roles, 'mode')) {
            problems.push(`${f.filename}: mode_map requires a mode column`);
          }
        } catch {
          problems.push(`${f.filename}: mode_map is not valid JSON`);
        }
      }
    }
    return problems;
  }, [files, drafts]);

  const setRole = (staged: string, col: string, role: ColumnMappingRole) => {
    setDrafts(prev => {
      const cur = prev[staged];
      if (!cur) return prev;
      const roles = { ...cur.roles };
      // Enforce one column per role (except ignore).
      if (role !== 'ignore') {
        for (const [name, r] of Object.entries(roles)) {
          if (r === role) roles[name] = 'ignore';
        }
      }
      roles[col] = role;
      return { ...prev, [staged]: { ...cur, roles } };
    });
    setLocalError(null);
  };

  const handleConfirm = () => {
    if (validation.length > 0) {
      setLocalError(validation[0]);
      return;
    }
    const payload: ConfirmUploadFile[] = files.map(f => {
      const d = drafts[f.staged_name];
      const mapping: ColumnMappingRequest = {
        lon: roleToColumn(d.roles, 'lon')!,
        lat: roleToColumn(d.roles, 'lat')!,
        time: roleToColumn(d.roles, 'time')!,
        vehicle_id: roleToColumn(d.roles, 'agent_id'),
      };
      const name = roleToColumn(d.roles, 'name');
      const mode = roleToColumn(d.roles, 'mode');
      if (name) mapping.name = name;
      if (mode) mapping.mode = mode;
      if (d.timeKind) mapping.time_kind = d.timeKind;
      if (d.modeMapText.trim()) {
        mapping.mode_map = JSON.parse(d.modeMapText) as Record<string, string>;
      }
      return {
        staged_name: f.staged_name,
        source_id: f.source_id,
        filename: f.filename,
        mapping,
      };
    });
    onConfirm(payload);
  };

  return (
    <div style={styles.backdrop} role="dialog" aria-modal="true" aria-label="Map columns">
      <div style={styles.sheet}>
        <div style={styles.header}>
          <div>
            <div style={styles.title}>Map columns to ingest</div>
            <div style={styles.subtitle}>
              Heuristics could not identify required fields. Assign longitude,
              latitude, time, and agent id — then ingest with the same pipeline.
            </div>
          </div>
          <button type="button" onClick={onCancel} style={styles.close} disabled={busy} title="Cancel">
            ✕
          </button>
        </div>

        {(errorReasons.length > 0 || localError) && (
          <div style={styles.reasons}>
            {localError && <div style={styles.reasonLine}>{localError}</div>}
            {errorReasons.slice(0, 6).map((r, i) => (
              <div key={i} style={styles.reasonLine}>{r}</div>
            ))}
          </div>
        )}

        {files.map(f => {
          const d = drafts[f.staged_name];
          if (!d) return null;
          const tried = f.tried_candidates;
          return (
            <div key={f.staged_name} style={styles.fileBlock}>
              <div style={styles.fileName}>{f.filename}</div>
              {tried && (
                <div style={styles.tried}>
                  Tried: lon [{(tried.lon || []).join(', ')}] · lat [{(tried.lat || []).join(', ')}]
                  · time [{(tried.time || []).join(', ')}] · id [{(tried.vehicle_id || []).join(', ')}]
                </div>
              )}
              <table style={styles.table}>
                <thead>
                  <tr>
                    <th style={styles.th}>Column</th>
                    <th style={styles.th}>Samples</th>
                    <th style={styles.th}>Role</th>
                  </tr>
                </thead>
                <tbody>
                  {f.columns.map(col => (
                    <tr key={col.name}>
                      <td style={styles.td}>
                        <code style={styles.code}>{col.name}</code>
                        <span style={styles.type}>{col.sample_type}</span>
                      </td>
                      <td style={{ ...styles.td, ...styles.samples }}>
                        {col.samples.slice(0, 3).join(' · ') || '—'}
                      </td>
                      <td style={styles.td}>
                        <select
                          value={d.roles[col.name] ?? 'ignore'}
                          disabled={busy}
                          onChange={e => setRole(
                            f.staged_name,
                            col.name,
                            e.target.value as ColumnMappingRole,
                          )}
                          style={styles.select}
                        >
                          {ROLES.map(r => (
                            <option key={r.value} value={r.value}>{r.label}</option>
                          ))}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <div style={styles.advanced}>
                <label style={styles.label}>
                  Time kind
                  <select
                    value={d.timeKind}
                    disabled={busy || !roleToColumn(d.roles, 'time')}
                    onChange={e => setDrafts(prev => ({
                      ...prev,
                      [f.staged_name]: {
                        ...prev[f.staged_name],
                        timeKind: e.target.value as UploadTimeKind | '',
                      },
                    }))}
                    style={styles.select}
                  >
                    <option value="">Auto-detect</option>
                    {TIME_KINDS.map(t => (
                      <option key={t.value} value={t.value}>{t.label}</option>
                    ))}
                  </select>
                </label>
                <label style={{ ...styles.label, flex: 1 }}>
                  mode_map JSON (optional int→label)
                  <input
                    type="text"
                    placeholder='{"0":"Walk","1":"Car"}'
                    value={d.modeMapText}
                    disabled={busy}
                    onChange={e => setDrafts(prev => ({
                      ...prev,
                      [f.staged_name]: {
                        ...prev[f.staged_name],
                        modeMapText: e.target.value,
                      },
                    }))}
                    style={styles.input}
                  />
                </label>
              </div>
            </div>
          );
        })}

        <div style={styles.footer}>
          <button type="button" onClick={onCancel} style={styles.btnGhost} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            style={styles.btnPrimary}
            disabled={busy || validation.length > 0}
          >
            {busy ? 'Ingesting…' : 'Confirm & ingest'}
          </button>
        </div>
      </div>
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  backdrop: {
    position: 'absolute',
    inset: 0,
    background: 'rgba(8, 10, 16, 0.78)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 40,
    padding: 16,
  },
  sheet: {
    width: 'min(720px, 100%)',
    maxHeight: 'min(86vh, 860px)',
    overflow: 'auto',
    background: 'rgba(18, 20, 28, 0.97)',
    border: '1px solid rgba(255,255,255,0.12)',
    borderRadius: 12,
    padding: '16px 18px 14px',
    color: '#e6e8ee',
    boxShadow: '0 18px 48px rgba(0,0,0,0.45)',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: 12,
    marginBottom: 12,
  },
  title: { fontSize: 16, fontWeight: 700, color: '#8ec8f0' },
  subtitle: { fontSize: 12, color: '#9aa3b2', marginTop: 4, lineHeight: 1.45 },
  close: {
    border: 'none', background: 'transparent', color: '#9aa3b2',
    cursor: 'pointer', fontSize: 14, padding: 4,
  },
  reasons: {
    background: 'rgba(80, 24, 24, 0.45)',
    border: '1px solid rgba(239, 83, 80, 0.35)',
    borderRadius: 8,
    padding: '8px 10px',
    marginBottom: 12,
    fontSize: 11,
    color: '#ef9a9a',
  },
  reasonLine: { lineHeight: 1.5 },
  fileBlock: { marginBottom: 14 },
  fileName: { fontSize: 13, fontWeight: 600, marginBottom: 4 },
  tried: { fontSize: 10, color: '#7d8796', marginBottom: 8, lineHeight: 1.4 },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 12 },
  th: {
    textAlign: 'left', padding: '6px 4px', color: '#8a94a5',
    borderBottom: '1px solid rgba(255,255,255,0.08)', fontWeight: 600,
  },
  td: {
    padding: '6px 4px',
    borderBottom: '1px solid rgba(255,255,255,0.05)',
    verticalAlign: 'middle',
  },
  code: {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    color: '#d7e3f4',
  },
  type: { marginLeft: 8, color: '#6f7a8a', fontSize: 10 },
  samples: { color: '#9aa3b2', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis' },
  select: {
    background: 'rgba(255,255,255,0.06)',
    border: '1px solid rgba(255,255,255,0.14)',
    color: '#e6e8ee',
    borderRadius: 6,
    padding: '4px 6px',
    fontSize: 12,
    minWidth: 140,
  },
  advanced: {
    display: 'flex',
    gap: 12,
    marginTop: 10,
    flexWrap: 'wrap',
    alignItems: 'flex-end',
  },
  label: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    fontSize: 11,
    color: '#9aa3b2',
  },
  input: {
    background: 'rgba(255,255,255,0.06)',
    border: '1px solid rgba(255,255,255,0.14)',
    color: '#e6e8ee',
    borderRadius: 6,
    padding: '6px 8px',
    fontSize: 12,
    width: '100%',
  },
  footer: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: 8,
    marginTop: 8,
    paddingTop: 10,
    borderTop: '1px solid rgba(255,255,255,0.08)',
  },
  btnGhost: {
    background: 'transparent',
    border: '1px solid rgba(255,255,255,0.18)',
    color: '#c5ccd8',
    borderRadius: 8,
    padding: '7px 12px',
    fontSize: 12,
    cursor: 'pointer',
  },
  btnPrimary: {
    background: '#2b7bb8',
    border: '1px solid #3d8fc9',
    color: '#fff',
    borderRadius: 8,
    padding: '7px 14px',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
  },
};

/**
 * ColumnMappingSheet — interactive role assignment when upload sniff fails.
 *
 * Supports GPS tracks (lon/lat/time/agent) and trips-only / OD arcs
 * (start/end lon/lat, starttime, trip_id, agent). Confirm posts to
 * /upload/confirm with kind=tracks|trips.
 */

import React, { useMemo, useState } from 'react';
import type {
  UploadMappingFile,
  ColumnMappingRole,
  UploadTimeKind,
  ConfirmUploadFile,
  ColumnMappingRequest,
  UploadTabularKind,
} from '../types';

const TRACK_ROLES: { value: ColumnMappingRole; label: string }[] = [
  { value: 'ignore', label: 'Ignore' },
  { value: 'lon', label: 'Longitude' },
  { value: 'lat', label: 'Latitude' },
  { value: 'time', label: 'Time' },
  { value: 'agent_id', label: 'Agent / device id' },
  { value: 'name', label: 'Name (optional)' },
  { value: 'mode', label: 'Mode (optional)' },
];

const TRIP_ROLES: { value: ColumnMappingRole; label: string }[] = [
  { value: 'ignore', label: 'Ignore' },
  { value: 'start_lon', label: 'Start lon' },
  { value: 'start_lat', label: 'Start lat' },
  { value: 'end_lon', label: 'End lon' },
  { value: 'end_lat', label: 'End lat' },
  { value: 'starttime', label: 'Start time' },
  { value: 'agent_id', label: 'Agent / device id' },
  { value: 'trip_id', label: 'Trip id' },
  { value: 'mode', label: 'Mode (optional)' },
];

const TRACK_TIME_KINDS: { value: UploadTimeKind; label: string }[] = [
  { value: 'iso', label: 'ISO-8601' },
  { value: 'epoch_ms', label: 'Epoch ms' },
  { value: 'epoch_s', label: 'Epoch seconds' },
];

const TRIP_TIME_KINDS: { value: UploadTimeKind; label: string }[] = [
  { value: 'day_seconds', label: 'Seconds from midnight' },
  { value: 'iso', label: 'ISO-8601' },
  { value: 'epoch_ms', label: 'Epoch ms' },
  { value: 'epoch_s', label: 'Epoch seconds' },
];

const TRACK_REQUIRED: ColumnMappingRole[] = ['lon', 'lat', 'time', 'agent_id'];
const TRIP_REQUIRED: ColumnMappingRole[] = [
  'start_lon', 'start_lat', 'end_lon', 'end_lat', 'starttime', 'agent_id', 'trip_id',
];

interface ColumnMappingSheetProps {
  files: UploadMappingFile[];
  errorReasons: string[];
  busy?: boolean;
  onConfirm: (files: ConfirmUploadFile[]) => void;
  onCancel: () => void;
}

type FileDraft = {
  kind: UploadTabularKind;
  roles: Record<string, ColumnMappingRole>;
  timeKind: UploadTimeKind | '';
  modeMapText: string;
};

function resolveKind(file: UploadMappingFile): UploadTabularKind {
  return file.kind ?? file.suggested_kind ?? 'tracks';
}

function initialDraft(file: UploadMappingFile): FileDraft {
  const kind = resolveKind(file);
  const roles: Record<string, ColumnMappingRole> = {};
  for (const col of file.columns) {
    roles[col.name] = (col.guessed_role as ColumnMappingRole | null) ?? 'ignore';
  }
  const g = file.guesses;
  const assign = (role: ColumnMappingRole, col: string | null | undefined) => {
    if (col && roles[col] !== undefined) roles[col] = role;
  };
  if (kind === 'trips') {
    assign('start_lon', g.start_lon);
    assign('start_lat', g.start_lat);
    assign('end_lon', g.end_lon);
    assign('end_lat', g.end_lat);
    assign('starttime', g.starttime);
    assign('agent_id', g.vehicle_id);
    assign('trip_id', g.trip_id);
    assign('mode', g.mode);
  } else {
    assign('lon', g.lon);
    assign('lat', g.lat);
    assign('time', g.time);
    assign('agent_id', g.vehicle_id);
    assign('name', g.name);
    assign('mode', g.mode);
  }

  return {
    kind,
    roles,
    timeKind: g.time_kind ?? '',
    modeMapText: '',
  };
}

function roleToColumn(roles: Record<string, ColumnMappingRole>, role: ColumnMappingRole): string | undefined {
  return Object.entries(roles).find(([, r]) => r === role)?.[0];
}

function roleLabel(role: ColumnMappingRole): string {
  if (role === 'agent_id') return 'agent/device id';
  return role.replace(/_/g, ' ');
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
      const required = d.kind === 'trips' ? TRIP_REQUIRED : TRACK_REQUIRED;
      for (const role of required) {
        if (!roleToColumn(d.roles, role)) {
          problems.push(`${f.filename}: assign a ${roleLabel(role)} column`);
        }
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

  const setKind = (staged: string, kind: UploadTabularKind) => {
    setDrafts(prev => {
      const cur = prev[staged];
      if (!cur) return prev;
      const file = files.find(f => f.staged_name === staged);
      if (!file) return prev;
      // Rebuild draft for the new kind from server guesses.
      const next = initialDraft({ ...file, kind, suggested_kind: kind });
      next.modeMapText = cur.modeMapText;
      return { ...prev, [staged]: next };
    });
    setLocalError(null);
  };

  const setRole = (staged: string, col: string, role: ColumnMappingRole) => {
    setDrafts(prev => {
      const cur = prev[staged];
      if (!cur) return prev;
      const roles = { ...cur.roles };
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
      const mapping: ColumnMappingRequest = { kind: d.kind };
      if (d.kind === 'trips') {
        mapping.start_lon = roleToColumn(d.roles, 'start_lon')!;
        mapping.start_lat = roleToColumn(d.roles, 'start_lat')!;
        mapping.end_lon = roleToColumn(d.roles, 'end_lon')!;
        mapping.end_lat = roleToColumn(d.roles, 'end_lat')!;
        mapping.starttime = roleToColumn(d.roles, 'starttime')!;
        mapping.vehicle_id = roleToColumn(d.roles, 'agent_id');
        mapping.trip_id = roleToColumn(d.roles, 'trip_id')!;
        const mode = roleToColumn(d.roles, 'mode');
        if (mode) mapping.mode = mode;
        if (d.timeKind) mapping.time_kind = d.timeKind;
      } else {
        mapping.lon = roleToColumn(d.roles, 'lon')!;
        mapping.lat = roleToColumn(d.roles, 'lat')!;
        mapping.time = roleToColumn(d.roles, 'time')!;
        mapping.vehicle_id = roleToColumn(d.roles, 'agent_id');
        const name = roleToColumn(d.roles, 'name');
        const mode = roleToColumn(d.roles, 'mode');
        if (name) mapping.name = name;
        if (mode) mapping.mode = mode;
        if (d.timeKind) mapping.time_kind = d.timeKind;
      }
      if (d.modeMapText.trim()) {
        mapping.mode_map = JSON.parse(d.modeMapText) as Record<string, string>;
      }
      return {
        staged_name: f.staged_name,
        source_id: f.source_id,
        filename: f.filename,
        kind: d.kind,
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
              Choose GPS tracks or an OD / trips table, then assign the required
              columns. Trips-only uploads draw as arcs (no waypoints).
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
          const roles = d.kind === 'trips' ? TRIP_ROLES : TRACK_ROLES;
          const timeKinds = d.kind === 'trips' ? TRIP_TIME_KINDS : TRACK_TIME_KINDS;
          const timeRole: ColumnMappingRole = d.kind === 'trips' ? 'starttime' : 'time';
          return (
            <div key={f.staged_name} style={styles.fileBlock}>
              <div style={styles.fileName}>{f.filename}</div>
              <div style={styles.kindRow} role="group" aria-label="Table kind">
                <button
                  type="button"
                  disabled={busy}
                  aria-pressed={d.kind === 'tracks'}
                  onClick={() => setKind(f.staged_name, 'tracks')}
                  style={d.kind === 'tracks' ? styles.kindActive : styles.kindIdle}
                >
                  GPS tracks
                </button>
                <button
                  type="button"
                  disabled={busy}
                  aria-pressed={d.kind === 'trips'}
                  onClick={() => setKind(f.staged_name, 'trips')}
                  style={d.kind === 'trips' ? styles.kindActive : styles.kindIdle}
                >
                  OD / trips table
                </button>
              </div>
              {tried && d.kind === 'tracks' && (
                <div style={styles.tried}>
                  Tried: lon [{(tried.lon || []).join(', ')}] · lat [{(tried.lat || []).join(', ')}]
                  · time [{(tried.time || []).join(', ')}] · id [{(tried.vehicle_id || []).join(', ')}]
                </div>
              )}
              {tried && d.kind === 'trips' && (
                <div style={styles.tried}>
                  Tried: start [{(tried.start_lon || []).join(', ')}] / [{(tried.start_lat || []).join(', ')}]
                  · end [{(tried.end_lon || []).join(', ')}] / [{(tried.end_lat || []).join(', ')}]
                  · starttime [{(tried.starttime || []).join(', ')}]
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
                          {roles.map(r => (
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
                    disabled={busy || !roleToColumn(d.roles, timeRole)}
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
                    {timeKinds.map(t => (
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
  kindRow: { display: 'flex', gap: 8, marginBottom: 8 },
  kindActive: {
    background: 'rgba(43, 123, 184, 0.35)',
    border: '1px solid #3d8fc9',
    color: '#e6e8ee',
    borderRadius: 8,
    padding: '5px 10px',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
  },
  kindIdle: {
    background: 'transparent',
    border: '1px solid rgba(255,255,255,0.18)',
    color: '#c5ccd8',
    borderRadius: 8,
    padding: '5px 10px',
    fontSize: 12,
    cursor: 'pointer',
  },
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

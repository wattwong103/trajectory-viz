/**
 * AgentTab — agent search + follow list (Phase 2A), rendered as the "⚑"
 * tab inside AnalysisPanel.
 *
 * Search box → GET /api/trips/vehicles (debounced 300 ms, vehicle_key prefix)
 * → result list with "+ follow" buttons. Followed agents show as chips with
 * their MapView highlight color; App fetches their full-day trajectory chains
 * via /api/trajectories/by-vehicle and renders bright trails + moving markers.
 */

import React, { useState, useEffect, useRef } from 'react';
import { fetchVehicles } from '../api';
import type { AgentInfo } from '../types';
import { AGENT_COLORS, agentChipColor } from '../utils/agentColor';

export const MAX_AGENTS = 20;
export { AGENT_COLORS };

function fmtTime(sec: number): string {
  const h = String(Math.floor(sec / 3600) % 24).padStart(2, '0');
  const m = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
  return `${h}:${m}`;
}

interface AgentTabProps {
  vehicleType: string;
  city?: string;
  simulationDay?: number;
  selectedAgents: string[];
  agentLoading: boolean;
  onAddAgent: (key: string) => void;
  onRemoveAgent: (key: string) => void;
  onClearAgents: () => void;
  colorBy?: 'source' | 'transportMode';
}

export const AgentTab: React.FC<AgentTabProps> = ({
  vehicleType, city, simulationDay,
  selectedAgents, agentLoading,
  onAddAgent, onRemoveAgent, onClearAgents,
  colorBy = 'source',
}) => {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<AgentInfo[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<number | undefined>(undefined);

  // Debounced search — also fires with an empty query to list top vehicles.
  useEffect(() => {
    window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(async () => {
      setSearching(true);
      setError(null);
      try {
        const res = await fetchVehicles(
          query || undefined, vehicleType || undefined, city, simulationDay, 30,
        );
        setResults(res.vehicles);
      } catch (e) {
        setError(String(e));
        setResults([]);
      }
      setSearching(false);
    }, 300);
    return () => window.clearTimeout(debounceRef.current);
  }, [query, vehicleType, city, simulationDay]);

  const atCap = selectedAgents.length >= MAX_AGENTS;

  return (
    <div>
      {/* Followed agents */}
      {selectedAgents.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          <div style={rowBetween}>
            <span style={sectionTitle}>Following ({selectedAgents.length}/{MAX_AGENTS})</span>
            <button onClick={onClearAgents} style={linkBtn}>clear all</button>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
            {selectedAgents.map((key, i) => {
              const c = agentChipColor(key, i, selectedAgents.length, colorBy);
              return (
                <span key={key} style={{
                  display: 'inline-flex', alignItems: 'center', gap: 4,
                  background: 'rgba(255,255,255,0.06)',
                  border: `1px solid rgb(${c[0]},${c[1]},${c[2]})`,
                  borderRadius: 10, padding: '2px 8px', fontSize: 11,
                }}>
                  <span style={{
                    width: 8, height: 8, borderRadius: 4,
                    background: `rgb(${c[0]},${c[1]},${c[2]})`,
                  }} />
                  {key}
                  <button
                    onClick={() => onRemoveAgent(key)}
                    style={{ ...linkBtn, fontSize: 12, padding: 0 }}
                    title="Unfollow"
                  >×</button>
                </span>
              );
            })}
          </div>
          {agentLoading && <div style={mutedText}>loading trajectories…</div>}
        </div>
      )}

      {/* Search */}
      <div style={sectionTitle}>Find agents</div>
      <input
        value={query}
        onChange={e => setQuery(e.target.value)}
        placeholder="vehicle_key prefix, e.g. taxi:tokyo:4"
        style={{
          width: '100%', boxSizing: 'border-box',
          background: 'rgba(255,255,255,0.06)', color: '#ddd',
          border: '1px solid rgba(255,255,255,0.15)', borderRadius: 4,
          padding: '5px 8px', fontSize: 12, marginTop: 4, marginBottom: 6,
        }}
      />
      {error && <div style={{ ...mutedText, color: '#e07b7b' }}>{error}</div>}
      {searching && <div style={mutedText}>searching…</div>}

      {/* Results */}
      <div style={{ maxHeight: 260, overflowY: 'auto' }}>
        {results.map(v => {
          const followed = selectedAgents.includes(v.vehicle_key);
          return (
            <div key={v.vehicle_key} style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '4px 2px', borderBottom: '1px solid rgba(255,255,255,0.05)',
              fontSize: 11,
            }}>
              <div>
                <div style={{ fontFamily: 'monospace', color: '#cfe3f7' }}>{v.vehicle_key}</div>
                <div style={mutedText}>
                  {v.trip_count} trips · {v.total_km ?? '?'} km · {fmtTime(v.first_start)}–{fmtTime(v.last_end)}
                </div>
              </div>
              <button
                onClick={() => followed ? onRemoveAgent(v.vehicle_key) : onAddAgent(v.vehicle_key)}
                disabled={!followed && atCap}
                style={{
                  background: followed ? 'rgba(255,230,100,0.15)' : 'rgba(79,195,247,0.15)',
                  color: followed ? '#ffe664' : '#4fc3f7',
                  border: 'none', borderRadius: 4, padding: '3px 8px',
                  cursor: (!followed && atCap) ? 'not-allowed' : 'pointer',
                  fontSize: 11, whiteSpace: 'nowrap',
                  opacity: (!followed && atCap) ? 0.4 : 1,
                }}
                title={!followed && atCap ? `Max ${MAX_AGENTS} agents` : undefined}
              >
                {followed ? '− unfollow' : '+ follow'}
              </button>
            </div>
          );
        })}
        {!searching && results.length === 0 && !error && (
          <div style={mutedText}>No matching vehicles.</div>
        )}
      </div>
    </div>
  );
};

const sectionTitle: React.CSSProperties = { fontSize: 11, color: '#bbb', fontWeight: 600 };
const mutedText: React.CSSProperties = { fontSize: 10, color: '#778' };
const rowBetween: React.CSSProperties = {
  display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
};
const linkBtn: React.CSSProperties = {
  background: 'none', border: 'none', color: '#888',
  cursor: 'pointer', fontSize: 10, padding: 2,
};

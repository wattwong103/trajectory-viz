import React from 'react';
import type { Trajectory } from '../../types';
import { TrajectoryDetail } from './TrajectoryDetail';

export interface DetailTabProps {
  selectedTrajectory: Trajectory;
  onClearSelectedTrajectory?: () => void;
  onAddAgent?: (key: string) => void;
  selectedAgents: string[];
  onFollowAgent: () => void;
}

export const DetailTab: React.FC<DetailTabProps> = ({
  selectedTrajectory, onClearSelectedTrajectory,
  onAddAgent, selectedAgents, onFollowAgent,
}) => (
  <>
    <TrajectoryDetail
      trajectory={selectedTrajectory}
      onClear={onClearSelectedTrajectory}
    />
    {/* Phase 2A — jump from one sampled trip to the agent's full day */}
    {onAddAgent && !selectedAgents.includes(selectedTrajectory.metadata.vehicle_key) && (
      <button
        onClick={onFollowAgent}
        style={{
          marginTop: 8, width: '100%',
          background: 'rgba(255,230,100,0.12)', color: '#ffe664',
          border: '1px solid rgba(255,230,100,0.4)', borderRadius: 4,
          padding: '5px 8px', fontSize: 11, cursor: 'pointer',
        }}
      >
        ★ Follow this agent (full day)
      </button>
    )}
  </>
);

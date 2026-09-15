import { describe, it, expect } from 'vitest';
import { agentHighlightColor, agentChipColor, FOLLOW_ORDER_CAP } from '../utils/agentColor';
import { AGENT_COLORS } from '../utils/agentColor';

const truck = { vehicle_type: 'truck', transport_mode: 1 };
const taxi = { vehicle_type: 'taxi', transport_mode: 8 };

describe('agentHighlightColor', () => {
  it('uses follow-order palette at or below the cap', () => {
    const selected = ['truck:1', 'taxi:tokyo:2'];
    expect(agentHighlightColor('truck:1', selected, truck, 'source'))
      .toEqual(AGENT_COLORS[0]);
    expect(agentHighlightColor('taxi:tokyo:2', selected, taxi, 'source'))
      .toEqual(AGENT_COLORS[1]);
  });

  it('colors a type cohort (>cap) by source, not rainbow', () => {
    const selected = Array.from({ length: FOLLOW_ORDER_CAP + 1 }, (_, i) => `truck:${i}`);
    const c = agentHighlightColor('truck:0', selected, truck, 'source', () => [253, 128, 93]);
    expect(c).toEqual([253, 128, 93]);
    expect(c).not.toEqual(AGENT_COLORS[0]);
  });

  it('colors a type cohort by transport mode when colorBy is mode', () => {
    const selected = Array.from({ length: FOLLOW_ORDER_CAP + 1 }, (_, i) => `truck:${i}`);
    const c = agentHighlightColor('truck:0', selected, truck, 'transportMode');
    expect(c).toEqual([26, 188, 156]); // bike — transport_mode 1
  });
});

describe('agentChipColor', () => {
  it('matches follow-order below the cap', () => {
    expect(agentChipColor('truck:1', 0, 3)).toEqual(AGENT_COLORS[0]);
  });

  it('uses the source prefix above the cap', () => {
    const below = agentChipColor('truck:1', 0, 3);
    const above = agentChipColor('truck:1', 0, FOLLOW_ORDER_CAP + 1);
    expect(above).not.toEqual(below);
  });
});

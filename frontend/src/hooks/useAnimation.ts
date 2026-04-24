/**
 * Animation hook — drives the 24-hour trajectory animation loop.
 *
 * Uses requestAnimationFrame for smooth 60fps updates.
 * currentTime cycles through 0-86399 (seconds in a day),
 * which maps directly to DeckGL TripsLayer's currentTime prop.
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import type { AnimationState } from '../types';

const LOOP_LENGTH = 86400; // seconds in a day
const DEFAULT_SPEED = 60;  // 1 second real-time = 1 minute sim-time
const DEFAULT_TRAIL = 1200; // 20 minutes of visible trail

export function useAnimation(): AnimationState & {
  setSpeed: (s: number) => void;
  togglePlay: () => void;
  setTime: (t: number) => void;
  setTrailLength: (t: number) => void;
} {
  const [state, setState] = useState<AnimationState>({
    currentTime: 0,
    speed: DEFAULT_SPEED,
    playing: true,
    trailLength: DEFAULT_TRAIL,
  });

  const stateRef = useRef(state);
  stateRef.current = state;

  const rafId = useRef<number>(0);
  const lastTimestamp = useRef<number>(0);

  const animate = useCallback((timestamp: number) => {
    const s = stateRef.current;
    if (s.playing) {
      const delta = lastTimestamp.current ? (timestamp - lastTimestamp.current) / 1000 : 0;
      const newTime = (s.currentTime + delta * s.speed) % LOOP_LENGTH;
      setState(prev => ({ ...prev, currentTime: newTime }));
    }
    lastTimestamp.current = timestamp;
    rafId.current = requestAnimationFrame(animate);
  }, []);

  useEffect(() => {
    rafId.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(rafId.current);
  }, [animate]);

  const setSpeed = useCallback((speed: number) => {
    setState(prev => ({ ...prev, speed }));
  }, []);

  const togglePlay = useCallback(() => {
    setState(prev => ({ ...prev, playing: !prev.playing }));
    lastTimestamp.current = 0; // reset to avoid delta jump
  }, []);

  const setTime = useCallback((t: number) => {
    setState(prev => ({ ...prev, currentTime: t % LOOP_LENGTH }));
    lastTimestamp.current = 0;
  }, []);

  const setTrailLength = useCallback((trailLength: number) => {
    setState(prev => ({ ...prev, trailLength }));
  }, []);

  return { ...state, setSpeed, togglePlay, setTime, setTrailLength };
}

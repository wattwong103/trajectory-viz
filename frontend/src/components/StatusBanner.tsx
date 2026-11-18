/**
 * StatusBanner — shared map-corner status / error / warn chip.
 *
 * Replaces the three nearly-identical absolute overlays in App (pulse,
 * drill, footfall) so stacking, typography, and dismiss affordances stay
 * consistent. Multiple banners stack upward from `bottom` via `stackIndex`.
 */

import React from 'react';

export type StatusTone = 'error' | 'warn' | 'info';

export interface StatusBannerProps {
  message: string;
  tone?: StatusTone;
  /** 0 = lowest; each step lifts the banner by ~52px. */
  stackIndex?: number;
  /** Base bottom offset in px (clears TimeSlider). Default 96. */
  bottom?: number;
  onDismiss?: () => void;
}

const TONE: Record<StatusTone, { bg: string; border: string; color: string }> = {
  error: {
    bg: 'rgba(60,20,20,0.92)',
    border: '1px solid #a55',
    color: '#f0c0c0',
  },
  warn: {
    bg: 'rgba(60,45,15,0.92)',
    border: '1px solid #a85',
    color: '#f0d8b0',
  },
  info: {
    bg: 'rgba(20,30,40,0.92)',
    border: '1px solid rgba(79,195,247,0.45)',
    color: '#c5e8f7',
  },
};

export const StatusBanner: React.FC<StatusBannerProps> = ({
  message,
  tone = 'error',
  stackIndex = 0,
  bottom = 96,
  onDismiss,
}) => {
  const t = TONE[tone];
  return (
    <div
      role="status"
      style={{
        position: 'absolute',
        bottom: bottom + stackIndex * 52,
        right: 12,
        maxWidth: 320,
        background: t.bg,
        border: t.border,
        borderRadius: 6,
        padding: '8px 10px',
        fontSize: 11,
        color: t.color,
        zIndex: 5,
        lineHeight: 1.45,
        display: 'flex',
        alignItems: 'flex-start',
        gap: 8,
        backdropFilter: 'blur(4px)',
      }}
    >
      <span style={{ flex: 1 }}>{message}</span>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          style={{
            background: 'none',
            border: 'none',
            color: t.color,
            cursor: 'pointer',
            fontSize: 14,
            lineHeight: 1,
            padding: 0,
            opacity: 0.75,
            flexShrink: 0,
          }}
        >
          ×
        </button>
      )}
    </div>
  );
};

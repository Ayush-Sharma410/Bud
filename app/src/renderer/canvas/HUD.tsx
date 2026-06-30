import React from 'react';
import type { CanvasHUDState } from '../../main/excalidraw/excalidrawTypes';

interface HUDProps {
  state: CanvasHUDState;
}

const labels: Record<CanvasHUDState, string> = {
  idle: 'Bud Canvas',
  listening: 'Listening',
  speaking: 'Speaking',
  proposalPending: 'Review',
  saved: 'Saved',
};

const backgroundForState = (state: CanvasHUDState): string => {
  switch (state) {
    case 'listening':
      return '#4f46e5'; // indigo-600
    case 'speaking':
      return '#059669'; // emerald-600
    case 'proposalPending':
      return '#d97706'; // amber-600
    case 'saved':
      return '#0ea5e9'; // sky-500
    case 'idle':
    default:
      return 'rgba(0, 0, 0, 0.6)';
  }
};

export default function HUD({ state }: HUDProps) {
  return (
    <div
      style={{
        position: 'fixed',
        top: 12,
        right: 12,
        zIndex: 999999,
        padding: '6px 12px',
        borderRadius: 16,
        background: backgroundForState(state),
        color: '#fff',
        fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        fontSize: 13,
        fontWeight: 500,
        pointerEvents: 'none',
        userSelect: 'none',
        boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
        transition: 'background 150ms ease',
      }}
    >
      {labels[state]}
    </div>
  );
}

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { StatusBanner } from '../components/StatusBanner';

describe('StatusBanner', () => {
  it('renders the message with status role', () => {
    render(<StatusBanner message="Pulse layer unavailable: not built" />);
    expect(screen.getByRole('status')).toHaveTextContent(/Pulse layer unavailable/);
  });

  it('fires onDismiss when the dismiss control is clicked', () => {
    const onDismiss = vi.fn();
    render(<StatusBanner message="Area query failed" onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('omits the dismiss control when onDismiss is absent', () => {
    render(<StatusBanner message="Footfall fallback" tone="warn" />);
    expect(screen.queryByRole('button', { name: /dismiss/i })).toBeNull();
  });
});

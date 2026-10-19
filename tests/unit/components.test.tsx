import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { DataState } from '@/components/shared/DataState';
import { MoneyInput } from '@/components/shared/MoneyInput';
import { MoneyText } from '@/components/shared/MoneyText';
import { OneTimeSecretDialog } from '@/components/shared/OneTimeSecretDialog';
import { AppError } from '@/lib/errors';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';

const base = { data: undefined, error: null, fetchStatus: 'idle' as const };

describe('DataState', () => {
  const child = (d: string[]) => <p>rows: {d.join(',')}</p>;

  it('M2X: the previous results of a new query that is paused offline are not shown as its answer', () => {
    const prev = { ...base, status: 'success' as const, data: ['Aarav', 'Anaya'], isPlaceholderData: true };
    const { rerender } = render(<DataState query={{ ...prev, fetchStatus: 'paused' }}>{child}</DataState>);
    expect(screen.getByText('You are offline')).toBeInTheDocument();
    expect(screen.queryByText(/rows:/)).not.toBeInTheDocument();
    // online, the previous results stay visible while the new ones load
    rerender(<DataState query={{ ...prev, fetchStatus: 'fetching' }}>{child}</DataState>);
    expect(screen.getByText('rows: Aarav,Anaya')).toBeInTheDocument();
    // cached data of the SAME query, refetch paused offline: still its real data
    rerender(
      <DataState query={{ ...prev, isPlaceholderData: false, fetchStatus: 'paused' }}>{child}</DataState>,
    );
    expect(screen.getByText('rows: Aarav,Anaya')).toBeInTheDocument();
  });

  it('distinguishes loading, empty, error, forbidden, offline and data', () => {
    const { rerender } = render(
      <DataState query={{ ...base, status: 'pending', fetchStatus: 'fetching' }}>{child}</DataState>,
    );
    expect(screen.getByLabelText('Loading')).toBeInTheDocument();

    rerender(<DataState query={{ ...base, status: 'pending', fetchStatus: 'paused' }}>{child}</DataState>);
    expect(screen.getByText('You are offline')).toBeInTheDocument();

    rerender(
      <DataState
        query={{ ...base, status: 'success', data: [] }}
        isEmpty={(d) => d.length === 0}
        emptyTitle="No schools yet"
      >
        {child}
      </DataState>,
    );
    expect(screen.getByText('No schools yet')).toBeInTheDocument();

    rerender(
      <DataState
        query={{
          ...base,
          status: 'error',
          error: new AppError('UNKNOWN', 'Something went wrong.', 'req-42'),
        }}
      >
        {child}
      </DataState>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load this');
    expect(screen.getByText('req-42')).toBeInTheDocument();

    rerender(
      <DataState
        query={{
          ...base,
          status: 'error',
          error: new AppError('FORBIDDEN', 'Operator access required', 'r'),
        }}
      >
        {child}
      </DataState>,
    );
    expect(screen.getByText("You don't have access to this")).toBeInTheDocument();

    rerender(
      <DataState query={{ ...base, status: 'error', error: new AppError('NETWORK', 'offline', 'r') }}>
        {child}
      </DataState>,
    );
    expect(screen.getByText('You are offline')).toBeInTheDocument();

    rerender(<DataState query={{ ...base, status: 'success', data: ['a', 'b'] }}>{child}</DataState>);
    expect(screen.getByText('rows: a,b')).toBeInTheDocument();
  });
});

describe('MoneyText', () => {
  it('shows missing as a dash, never as ₹0', () => {
    const { rerender } = render(<MoneyText paise={null} />);
    expect(screen.getByText('No amount')).toBeInTheDocument();
    expect(screen.queryByText(/₹/)).toBeNull();
    rerender(<MoneyText paise={0} />);
    expect(screen.getByText('₹0.00')).toBeInTheDocument();
    rerender(<MoneyText paise={10000050} />);
    expect(screen.getByText('₹1,00,000.50')).toBeInTheDocument();
  });
});

describe('MoneyInput', () => {
  it('emits integer paise from typed rupees and flags invalid input', async () => {
    const onChange = vi.fn();
    render(<MoneyInput value={null} onChange={onChange} />);
    const input = screen.getByRole('textbox');
    await userEvent.type(input, '1,00,000.50');
    expect(onChange).toHaveBeenLastCalledWith(10000050, null);
    await userEvent.type(input, '9');
    expect(onChange.mock.lastCall?.[0]).toBeNull();
    expect(input).toHaveAttribute('aria-invalid', 'true');
  });
});

describe('OneTimeSecretDialog', () => {
  function Harness() {
    const [secret, setSecret] = useState<string | null>('Temp-Pass-123');
    return <OneTimeSecretDialog secret={secret} username="demo.admin" onClose={() => setSecret(null)} />;
  }

  it('shows the password once and removes it from the DOM when closed', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<Harness />);
    expect(screen.getByTestId('one-time-secret')).toHaveTextContent('Temp-Pass-123');
    await userEvent.click(screen.getByRole('button', { name: 'Copy password' }));
    expect(writeText).toHaveBeenCalledWith('Temp-Pass-123');
    expect(await screen.findByText('Copied to clipboard.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /I have noted it/ }));
    expect(screen.queryByText('Temp-Pass-123')).toBeNull();
    expect(document.body.innerHTML).not.toContain('Temp-Pass-123');
  });
});

describe('Dialog focus (M2X keyboard walkthrough)', () => {
  function Opener() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          New class
        </button>
        {open && (
          <Dialog open onOpenChange={setOpen}>
            <DialogContent>
              <DialogTitle>New class</DialogTitle>
              <DialogDescription>Opened from state, no DialogTrigger.</DialogDescription>
              <input aria-label="Class name" />
            </DialogContent>
          </Dialog>
        )}
      </>
    );
  }

  it('a dialog opened without a trigger gives the focus back to its opener on Escape', async () => {
    const user = userEvent.setup();
    render(<Opener />);
    const button = screen.getByRole('button', { name: 'New class' });
    button.focus();
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(document.activeElement?.closest('[role="dialog"]')).not.toBeNull();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(document.activeElement).toBe(button);
  });
});

import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '@/lib/errors';
import { applyServerFieldError, serverErrorField } from '@/lib/save-feedback';
import { fakeSupabase, onRpc, resetFake, rpcCalls, setupSnapshotRow } from './fake-supabase';
import { renderPage, setContext } from './render';

// M2X (close-out of M0–M2): adoption of migration 2310 and the 375px roster fix.

vi.mock('@/lib/supabase', () => ({ supabase: fakeSupabase }));

const { ClassesPage } = await import('@/features/setup/ClassesPage');

const calls = (fn: string) => rpcCalls.filter((c) => c.fn === fn);

beforeEach(() => resetFake());

/** A hinted server error as PostgREST returns it: `details` is the JSON `private.fail` stored. */
function hinted(hint: string, message: string, details: Record<string, unknown>) {
  return { error: { code: 'P0001', hint, message, details: JSON.stringify(details) } };
}

// ------------------------------------------------------------------ §1 readable errors
describe('server field errors (migration 2310 details.field)', () => {
  function fakeForm(values: Record<string, unknown>) {
    const setError = vi.fn();
    return { form: { setError, getValues: () => values }, setError };
  }

  it('reads details.field only from VALIDATION_ERROR / DUPLICATE', () => {
    const dup = new AppError('DUPLICATE', 'A class with this name already exists', 'r', { field: 'name' });
    expect(serverErrorField(dup)).toBe('name');
    expect(serverErrorField(new AppError('CONFLICT', 'x', 'r', { field: 'name' }))).toBeNull();
    expect(serverErrorField(new AppError('VALIDATION_ERROR', 'x', 'r', null))).toBeNull();
    expect(serverErrorField(new Error('x'))).toBeNull();
  });

  it('maps a database column to the form field through the alias map', () => {
    const { form, setError } = fakeForm({ name: '', phone: '' });
    const err = new AppError('VALIDATION_ERROR', 'Mobile number must be 10 digits', 'r', { field: 'phone' });
    expect(applyServerFieldError(err, form)).toBe(true);
    expect(setError).toHaveBeenCalledWith(
      'phone',
      { type: 'server', message: 'Mobile number must be 10 digits' },
      { shouldFocus: true },
    );
    const aliased = new AppError('DUPLICATE', 'Taken', 'r', { field: 'full_name' });
    expect(applyServerFieldError(aliased, form, { full_name: 'name' })).toBe(true);
    expect(setError).toHaveBeenLastCalledWith('name', expect.anything(), expect.anything());
  });

  it('a field the form does not have is left for the form-level error area', () => {
    const { form, setError } = fakeForm({ name: '' });
    const err = new AppError('VALIDATION_ERROR', 'Code: 1–20 letters', 'r', { field: 'udise_code' });
    expect(applyServerFieldError(err, form)).toBe(false);
    expect(setError).not.toHaveBeenCalled();
  });

  it('New class: DUPLICATE on the name is shown under the Name field, not as a form error', async () => {
    setContext(['setup.manage']);
    onRpc((fn) => {
      if (fn === 'get_setup_snapshot') return { data: setupSnapshotRow() };
      if (fn === 'save_class')
        return hinted('DUPLICATE', 'A class with this name already exists', {
          field: 'name',
          constraint: 'classes_name_uq',
        });
      return { data: null };
    });
    renderPage(<ClassesPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'New class' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Class name'), 'Class 1');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(calls('save_class')).toHaveLength(1));
    const name = within(dialog).getByLabelText('Class name');
    await waitFor(() => expect(name).toHaveAttribute('aria-invalid', 'true'));
    const describedBy = (name.getAttribute('aria-describedby') ?? '').split(' ');
    const message = within(dialog).getByText('A class with this name already exists');
    expect(describedBy).toContain(message.id);
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument();
    expect(name).toHaveValue('Class 1'); // the user's input is kept
  });

  it('New class: an error naming no field of the form goes to the form error area', async () => {
    setContext(['setup.manage']);
    onRpc((fn) => {
      if (fn === 'get_setup_snapshot') return { data: setupSnapshotRow() };
      if (fn === 'save_class')
        return hinted('VALIDATION_ERROR', 'A value has the wrong format', { field: 'something_else' });
      return { data: null };
    });
    renderPage(<ClassesPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'New class' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Class name'), 'Class 9');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('A value has the wrong format');
    expect(within(dialog).getByLabelText('Class name')).not.toHaveAttribute('aria-invalid', 'true');
  });
});

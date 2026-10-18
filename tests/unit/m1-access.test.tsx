import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { buildNav } from '@/app/navigation';
import { RequireCapability } from '@/app/RequireCapability';
import { contextSchema } from '@/contracts/session';
import { contextRow } from './fake-supabase';
import { renderPage, setContext } from './render';

// Capabilities exactly as private.role_has_cap grants them (20261005000800_security_rls.sql).
const TEACHER = ['staff.member', 'timetable.read_all', 'staff.read'];
const PRINCIPAL = [
  'staff.member',
  'students.read_all',
  'timetable.read_all',
  'attendance.read_all',
  'attendance.summary',
  'academic.read_all',
  'staff.read',
  'staff_attendance.read',
];
const ADMIN = [...PRINCIPAL, 'setup.manage', 'users.manage', 'admissions.manage', 'staff_finance.read'];

const liveLabels = (caps: string[], role: string) =>
  buildNav(contextSchema.parse(contextRow(1, role, caps)), false)
    .filter((i) => i.kind === 'live')
    .map((i) => i.label);

describe('users & setup screens are only offered with the capability', () => {
  it('teacher: no Users & logins, Students, Admissions or School setup; calendar and staff are offered', () => {
    const labels = liveLabels(TEACHER, 'teacher');
    expect(labels).not.toContain('Users & logins');
    expect(labels).not.toContain('Students');
    expect(labels).not.toContain('Admissions');
    expect(labels).not.toContain('School setup');
    expect(labels).toEqual(expect.arrayContaining(['Staff', 'School calendar']));
  });

  it('principal: students and staff, but no Users & logins or setup', () => {
    const labels = liveLabels(PRINCIPAL, 'principal');
    expect(labels).toEqual(expect.arrayContaining(['Students', 'Staff', 'School calendar']));
    expect(labels).not.toContain('Users & logins');
    expect(labels).not.toContain('School setup');
  });

  it('admin: Users & logins and School setup (calendar lives inside setup)', () => {
    const labels = liveLabels(ADMIN, 'admin');
    expect(labels).toEqual(expect.arrayContaining(['Users & logins', 'School setup', 'Admissions']));
    expect(labels).not.toContain('School calendar');
  });

  it('opening /users directly without users.manage shows "no access", not the screen', () => {
    setContext(TEACHER, 'teacher');
    renderPage(
      <RequireCapability anyOf={['users.manage']}>
        <p>users screen</p>
      </RequireCapability>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent("You don't have access to this page");
    expect(screen.queryByText('users screen')).not.toBeInTheDocument();
  });

  it('with users.manage the screen renders', () => {
    setContext(ADMIN, 'admin');
    renderPage(
      <RequireCapability anyOf={['users.manage']}>
        <p>users screen</p>
      </RequireCapability>,
    );
    expect(screen.getByText('users screen')).toBeInTheDocument();
  });
});

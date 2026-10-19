import { useQuery } from '@tanstack/react-query';
import type { AttendanceStatus } from '@/contracts/attendance';
import { getStaffAttendance, markStaffAttendance } from '@/lib/rpc';
import { useScopedKey } from '@/lib/scope';

// Staff attendance (brief §5): roster for a date with the staff calendar day type and paid leave.

export function useStaffAttendance(date: string, groupId: string | null) {
  const key = useScopedKey();
  return useQuery({
    queryKey: key('staff-attendance', date, groupId),
    queryFn: ({ signal }) =>
      getStaffAttendance({ p_date: date, ...(groupId ? { p_staff_group_id: groupId } : {}) }, { signal }),
    refetchOnWindowFocus: false,
    staleTime: 0,
  });
}

export interface StaffMark {
  staff_id: string;
  status: AttendanceStatus;
  expected_version: number | null;
}

/** The exact mark_staff_attendance arguments (unit-tested). */
export function staffMarkArgs(date: string, operationId: string, marks: StaffMark[]) {
  return {
    p_operation_id: operationId,
    p_date: date,
    p_marks: marks.map((m) => ({
      staff_id: m.staff_id,
      status: m.status,
      expected_version: m.expected_version,
    })),
  };
}

export function sendStaffMarks(date: string, operationId: string, marks: StaffMark[]) {
  return markStaffAttendance(staffMarkArgs(date, operationId, marks));
}

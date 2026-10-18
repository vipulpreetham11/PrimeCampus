import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { DataState } from '@/components/shared/DataState';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { formatDate, schoolToday } from '@/lib/dates';
import { useCan } from '@/lib/scope';
import { useSetupSnapshot } from '@/features/setup/hooks';
import { LinkLoginCard } from '@/features/users/LinkLoginCard';
import { StaffFinanceCard } from './StaffFinanceCard';
import { StaffFormDialog } from './StaffFormDialog';
import { AssignmentDialog, AssignmentList } from './TeachingAssignments';
import { useStaffGroups, useStaffList, useStaffRecord, useTeachingAssignments } from './hooks';

const GENDER = { male: 'Male', female: 'Female', transgender: 'Transgender' } as const;

function TeachingCard({ staffId }: { staffId: string }) {
  const canManage = useCan('timetable.manage');
  const [showEnded, setShowEnded] = useState(false);
  // Current and upcoming (starting later); with the switch, ended ones too.
  const query = useTeachingAssignments({ staffId, notEndedOn: showEnded ? null : schoolToday() });
  const snapshot = useSetupSnapshot(null);
  const staff = useStaffList(null, false);
  const [adding, setAdding] = useState(false);
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
        <CardTitle className="text-base">Teaches</CardTitle>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={showEnded} onCheckedChange={setShowEnded} /> Show ended
          </label>
          {canManage && (
            <Button size="sm" onClick={() => setAdding(true)} disabled={!snapshot.data}>
              Add
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent>
        <AssignmentList
          query={query}
          show="staff"
          emptyText={showEnded ? 'No assignments' : 'No current or upcoming assignments'}
        />
      </CardContent>
      {adding && snapshot.data && (
        <AssignmentDialog
          snapshot={snapshot.data}
          staff={staff.data ?? []}
          fixedStaffId={staffId}
          open
          onOpenChange={(o) => !o && setAdding(false)}
        />
      )}
    </Card>
  );
}

export function StaffProfilePage() {
  const { staffId } = useParams();
  const query = useStaffRecord(staffId);
  const groups = useStaffGroups();
  const canTeaching = useCan('staff.member');
  const [editing, setEditing] = useState(false);

  return (
    <div className="space-y-4">
      <Link to="/staff" className="text-sm underline-offset-2 hover:underline">
        ← All staff
      </Link>
      <DataState query={query}>
        {(r) => (
          <>
            <Card>
              <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2">
                <div>
                  <CardTitle className="text-lg" data-testid="staff-name">
                    {r.full_name}
                  </CardTitle>
                  <p className="text-muted-foreground text-sm">
                    {r.employee_no} · {r.group}
                    {r.designation ? ` · ${r.designation}` : ''}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {r.status !== 'active' && <Badge variant="outline">Inactive</Badge>}
                  {r.can.edit && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setEditing(true)}
                      disabled={!groups.data}
                    >
                      Edit
                    </Button>
                  )}
                </div>
              </CardHeader>
              <CardContent>
                <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[10rem_1fr]">
                  <dt className="text-muted-foreground">Gender</dt>
                  <dd>{r.gender ? GENDER[r.gender] : 'Not recorded'}</dd>
                  <dt className="text-muted-foreground">Mobile</dt>
                  <dd>{r.phone ?? '—'}</dd>
                  <dt className="text-muted-foreground">Email</dt>
                  <dd>{r.email ?? '—'}</dd>
                  <dt className="text-muted-foreground">Teaching staff</dt>
                  <dd>{r.is_teaching ? 'Yes' : 'No'}</dd>
                  <dt className="text-muted-foreground">Joined</dt>
                  <dd>{formatDate(r.joined_on)}</dd>
                  <dt className="text-muted-foreground">Left</dt>
                  <dd>{r.left_on ? formatDate(r.left_on) : '—'}</dd>
                  {!r.can.link_login && (
                    <>
                      <dt className="text-muted-foreground">Login</dt>
                      <dd>{r.has_login ? 'Has a login' : 'No login'}</dd>
                    </>
                  )}
                </dl>
              </CardContent>
            </Card>
            {r.can.link_login && <LinkLoginCard kind="staff" recordId={r.staff_id} login={r.login} />}
            {canTeaching && <TeachingCard staffId={r.staff_id} />}
            {/* Confidential: rendered only with staff_finance.read (the card re-checks the capability). */}
            {r.can.finance && <StaffFinanceCard staffId={r.staff_id} />}
            {editing && groups.data && (
              <StaffFormDialog
                record={r}
                groups={groups.data.filter((g) => g.status === 'active' || g.id === r.staff_group_id)}
                open
                onOpenChange={(o) => !o && setEditing(false)}
                onReload={() => void query.refetch()}
              />
            )}
          </>
        )}
      </DataState>
    </div>
  );
}

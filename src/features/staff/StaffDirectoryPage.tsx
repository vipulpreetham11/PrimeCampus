import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { DataState } from '@/components/shared/DataState';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatDate } from '@/lib/dates';
import { useCan } from '@/lib/scope';
import { StaffFormDialog } from './StaffFormDialog';
import { useStaffGroups, useStaffList } from './hooks';

const ALL = '__all__';

export function StaffDirectoryPage() {
  const canManage = useCan('staff.manage');
  const [groupId, setGroupId] = useState<string | null>(null);
  const [includeInactive, setIncludeInactive] = useState(false);
  const groups = useStaffGroups();
  const list = useStaffList(groupId, includeInactive);
  const [creating, setCreating] = useState(false);
  const navigate = useNavigate();

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-4">
        <div className="space-y-1">
          <Label htmlFor="staff-group-filter">Group</Label>
          <Select value={groupId ?? ALL} onValueChange={(v) => setGroupId(v === ALL ? null : v)}>
            <SelectTrigger id="staff-group-filter" className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All groups</SelectItem>
              {(groups.data ?? []).map((g) => (
                <SelectItem key={g.id} value={g.id}>
                  {g.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={includeInactive} onCheckedChange={setIncludeInactive} /> Include inactive staff
        </label>
        {canManage && (
          <Button className="ml-auto" size="sm" onClick={() => setCreating(true)} disabled={!groups.data}>
            New staff member
          </Button>
        )}
      </div>
      <DataState
        query={list}
        isEmpty={(d) => d.length === 0}
        emptyTitle="No staff found"
        emptyDescription={
          includeInactive ? undefined : 'Inactive staff are hidden. Use the switch to include them.'
        }
      >
        {(rows) => (
          <>
            <ul className="space-y-2 sm:hidden">
              {rows.map((s) => (
                <li key={s.staff_id}>
                  <Link
                    to={`/staff/${s.staff_id}`}
                    className="bg-background hover:bg-accent block rounded-md border p-3"
                  >
                    <p className="font-medium">{s.name}</p>
                    <p className="text-muted-foreground text-sm">
                      {s.employee_no} · {s.group}
                      {s.designation ? ` · ${s.designation}` : ''}
                    </p>
                    {s.status !== 'active' && <Badge variant="outline">Inactive</Badge>}
                  </Link>
                </li>
              ))}
            </ul>
            <div className="hidden overflow-x-auto sm:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Employee no.</TableHead>
                    <TableHead>Group</TableHead>
                    <TableHead>Designation</TableHead>
                    <TableHead>Joined</TableHead>
                    <TableHead>Login</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((s) => (
                    <TableRow key={s.staff_id} data-testid={`staff-row-${s.employee_no}`}>
                      <TableCell>
                        <Link
                          to={`/staff/${s.staff_id}`}
                          className="font-medium underline-offset-2 hover:underline"
                        >
                          {s.name}
                        </Link>
                      </TableCell>
                      <TableCell className="font-mono">{s.employee_no}</TableCell>
                      <TableCell>{s.group}</TableCell>
                      <TableCell>{s.designation ?? '—'}</TableCell>
                      <TableCell>{formatDate(s.joined_on)}</TableCell>
                      <TableCell>{s.has_login ? 'Yes' : 'No'}</TableCell>
                      <TableCell>
                        {s.status === 'active' ? 'Active' : <Badge variant="outline">Inactive</Badge>}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </>
        )}
      </DataState>
      {creating && groups.data && (
        <StaffFormDialog
          record={null}
          groups={groups.data.filter((g) => g.status === 'active')}
          open
          onOpenChange={(o) => !o && setCreating(false)}
          onSaved={(id) => navigate(`/staff/${id}`)}
        />
      )}
    </div>
  );
}

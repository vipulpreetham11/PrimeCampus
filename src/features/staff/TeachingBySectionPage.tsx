import { useState } from 'react';
import { DataState } from '@/components/shared/DataState';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { compareIsoDates, schoolToday } from '@/lib/dates';
import { useCan } from '@/lib/scope';
import { useSetupSnapshot } from '@/features/setup/hooks';
import { AssignmentDialog, AssignmentList, sectionOptions } from './TeachingAssignments';
import { useStaffList, useTeachingAssignments } from './hooks';

/** Section view: who is class teacher and who teaches which subject today (brief §2.4). */
export function TeachingBySectionPage() {
  const snapshot = useSetupSnapshot(null);
  const canManage = useCan('timetable.manage');
  const [sectionId, setSectionId] = useState<string | null>(null);
  const staff = useStaffList(null, false);
  const today = schoolToday();
  // Current and upcoming assignments (an upcoming one shows "Starts <date>").
  const query = useTeachingAssignments({ sectionId, notEndedOn: today });
  const [adding, setAdding] = useState(false);

  return (
    <DataState query={snapshot}>
      {(snap) => {
        const options = sectionOptions(snap);
        const rows = query.data ?? [];
        const classTeacher = rows.find(
          (r) => r.kind === 'class_teacher' && compareIsoDates(r.effective_from, today) <= 0,
        );
        return (
          <div className="space-y-4">
            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-1">
                <Label htmlFor="tbs-section">Section (current year)</Label>
                <Select value={sectionId ?? ''} onValueChange={setSectionId}>
                  <SelectTrigger id="tbs-section" className="w-48">
                    <SelectValue placeholder={options.length ? 'Choose a section' : 'No sections yet'} />
                  </SelectTrigger>
                  <SelectContent>
                    {options.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {canManage && sectionId && (
                <Button size="sm" onClick={() => setAdding(true)}>
                  Add teacher
                </Button>
              )}
            </div>
            {sectionId && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">
                    {options.find((o) => o.value === sectionId)?.label} — current and upcoming teachers
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3 text-sm">
                  {query.isSuccess && (
                    <p data-testid="class-teacher">
                      <span className="text-muted-foreground">Class teacher: </span>
                      {classTeacher ? (
                        <span className="font-medium">{classTeacher.staff}</span>
                      ) : (
                        'Not assigned'
                      )}
                    </p>
                  )}
                  <AssignmentList
                    query={query}
                    show="section"
                    emptyText="No current or upcoming teachers for this section"
                  />
                </CardContent>
              </Card>
            )}
            {adding && sectionId && (
              <AssignmentDialog
                snapshot={snap}
                staff={staff.data ?? []}
                fixedSectionId={sectionId}
                open
                onOpenChange={(o) => !o && setAdding(false)}
              />
            )}
          </div>
        );
      }}
    </DataState>
  );
}

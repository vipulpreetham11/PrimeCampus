import { useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { DataState } from '@/components/shared/DataState';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { StudentAttendance } from '@/features/attendance/StudentAttendance';
import type { ProfileGuardian, StudentProfile } from '@/contracts/students';
import { addDays, formatDate } from '@/lib/dates';
import { LinkLoginCard } from '@/features/users/LinkLoginCard';
import {
  AddGuardianDialog,
  GuardianEditDialog,
  GuardianLinkDialog,
  RELATIONSHIP_LABEL,
} from './GuardianDialogs';
import { SensitiveCard } from './SensitiveCard';
import { StudentEditDialog } from './StudentEditDialog';
import { useStudentProfile } from './hooks';

const GENDER = { male: 'Male', female: 'Female', transgender: 'Transgender' } as const;

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd>{children ?? '—'}</dd>
    </>
  );
}

function GuardiansCard({ data }: { data: StudentProfile }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [linking, setLinking] = useState<ProfileGuardian | null>(null);
  const [adding, setAdding] = useState(false);
  const canEdit = data.can.edit;
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="text-base">Parents &amp; guardians</CardTitle>
        {canEdit && (
          <Button size="sm" onClick={() => setAdding(true)}>
            Add
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {data.guardians.length === 0 ? (
          <p className="text-muted-foreground text-sm">No guardian linked.</p>
        ) : (
          <ul className="space-y-2" data-testid="guardians">
            {data.guardians.map((g) => (
              <li
                key={g.guardian_id}
                className="flex flex-wrap items-start justify-between gap-2 rounded-md border p-2 text-sm"
              >
                <div>
                  <p className="font-medium">
                    {g.name}{' '}
                    <span className="text-muted-foreground font-normal">
                      ({RELATIONSHIP_LABEL[g.relationship]})
                    </span>
                  </p>
                  <p className="text-muted-foreground">
                    {[g.phone, g.email, g.occupation].filter(Boolean).join(' · ') || 'No contact details'}
                  </p>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {g.is_primary && <Badge>Primary</Badge>}
                    <Badge variant="outline">
                      {g.portal_access ? 'Can see this child' : 'No portal access'}
                    </Badge>
                    <Badge variant="outline">{g.has_login ? 'Has login' : 'No login'}</Badge>
                  </div>
                </div>
                {canEdit && (
                  <div className="flex gap-2">
                    <Button size="sm" variant="outline" onClick={() => setLinking(g)}>
                      Relationship
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setEditing(g.guardian_id)}>
                      Details
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
      {editing && (
        <GuardianEditDialog guardianId={editing} open onOpenChange={(o) => !o && setEditing(null)} />
      )}
      {linking && (
        <GuardianLinkDialog
          studentId={data.profile.id}
          link={linking}
          open
          onOpenChange={(o) => !o && setLinking(null)}
        />
      )}
      {adding && (
        <AddGuardianDialog
          studentId={data.profile.id}
          existingIds={data.guardians.map((g) => g.guardian_id)}
          open
          onOpenChange={setAdding}
        />
      )}
    </Card>
  );
}

export function StudentProfilePage() {
  const { studentId } = useParams();
  const query = useStudentProfile(studentId);
  const [editing, setEditing] = useState(false);

  return (
    <div className="space-y-4">
      <Link to="/students" className="text-sm underline-offset-2 hover:underline">
        ← All students
      </Link>
      <DataState query={query}>
        {(data) => {
          const s = data.profile;
          const current = data.placements.find((p) => p.to === null) ?? data.placements[0];
          return (
            <>
              <Card>
                <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2">
                  <div>
                    <CardTitle className="text-lg" data-testid="student-name">
                      {s.full_name}
                    </CardTitle>
                    <p className="text-muted-foreground text-sm">
                      Adm. {s.admission_no}
                      {current
                        ? ` · ${current.class} ${current.section}${current.roll_no ? ` · Roll ${current.roll_no}` : ''}`
                        : ' · No current section'}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {s.status !== 'active' && (
                      <Badge variant="outline" className="capitalize">
                        {s.status}
                      </Badge>
                    )}
                    {data.can.edit && (
                      <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
                        Edit
                      </Button>
                    )}
                  </div>
                </CardHeader>
                <CardContent>
                  <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[11rem_1fr_11rem_1fr]">
                    <Row label="Gender">{GENDER[s.gender]}</Row>
                    <Row label="Date of birth">
                      {formatDate(s.date_of_birth)}
                      {data.age_today !== null ? ` (age ${data.age_today})` : ''}
                    </Row>
                    <Row label="Admitted on">{formatDate(s.admission_date)}</Row>
                    <Row label="Blood group">{s.blood_group}</Row>
                    <Row label="Mother tongue">{s.mother_tongue}</Row>
                    <Row label="Nationality">{s.is_indian_national ? 'Indian' : s.nationality}</Row>
                    <Row label="Mother’s name">{s.mother_name}</Row>
                    <Row label="Father’s name">{s.father_name}</Row>
                    <Row label="Guardian’s name">{s.guardian_name}</Row>
                    <Row label="Mobile">{s.mobile}</Row>
                    <Row label="Alternate mobile">{s.alt_mobile}</Row>
                    <Row label="Email">{s.email}</Row>
                    <Row label="Address">
                      {s.address_line}
                      {s.pincode ? ` — ${s.pincode}` : ''}
                    </Row>
                    <Row label="Previous school">
                      {s.previous_school}
                      {s.previous_class ? ` (${s.previous_class})` : ''}
                    </Row>
                  </dl>
                </CardContent>
              </Card>

              <GuardiansCard data={data} />

              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Class history</CardTitle>
                </CardHeader>
                <CardContent>
                  {data.placements.length === 0 ? (
                    <p className="text-muted-foreground text-sm">No placement recorded.</p>
                  ) : (
                    // `to` is the exclusive effective_to: the last day in the section is the day before.
                    <ol className="space-y-1 text-sm" data-testid="placements">
                      {data.placements.map((p) => (
                        <li
                          key={`${p.section_id}-${p.from}`}
                          className="bg-muted/50 flex flex-wrap justify-between gap-2 rounded px-2 py-1"
                        >
                          <span>
                            {p.year}: {p.class} {p.section}
                            {p.roll_no ? ` · Roll ${p.roll_no}` : ''}
                          </span>
                          <span className="text-muted-foreground">
                            {formatDate(p.from)} – {p.to ? formatDate(addDays(p.to, -1)) : 'now'}
                            {p.reason ? ` · ${p.reason}` : ''}
                          </span>
                        </li>
                      ))}
                    </ol>
                  )}
                </CardContent>
              </Card>

              {data.can.attendance && (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Attendance</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <StudentAttendance studentId={s.id} />
                  </CardContent>
                </Card>
              )}

              {data.can.link_login && <LinkLoginCard kind="student" recordId={s.id} login={data.login} />}
              <SensitiveCard studentId={s.id} sensitive={data.sensitive} />

              {editing && (
                <StudentEditDialog
                  key={s.version}
                  student={s}
                  open
                  onOpenChange={setEditing}
                  onReload={() => void query.refetch()}
                />
              )}
            </>
          );
        }}
      </DataState>
    </div>
  );
}

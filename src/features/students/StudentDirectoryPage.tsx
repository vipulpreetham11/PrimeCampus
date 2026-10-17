import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { DataState } from '@/components/shared/DataState';
import { PageHeader } from '@/components/shared/PageHeader';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { StudentListItem } from '@/contracts/students';
import { useCan } from '@/lib/scope';
import { useSetupSnapshot } from '@/features/setup/hooks';
import { MovePlacementsDialog } from './MovePlacementsDialog';
import { useStudentDirectory } from './hooks';

const ALL = '__all__';

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function placementText(s: StudentListItem) {
  return s.class ? `${s.class} ${s.section ?? ''}`.trim() : 'No current section';
}

export function StudentDirectoryPage() {
  const canManage = useCan('students.manage');
  const canAdmit = useCan('admissions.manage');
  const snapshot = useSetupSnapshot(null);
  const [search, setSearch] = useState('');
  const [classId, setClassId] = useState<string | null>(null);
  const [sectionId, setSectionId] = useState<string | null>(null);
  const debounced = useDebounced(search, 300);
  const query = useStudentDirectory({ search: debounced, classId, sectionId });
  const [selected, setSelected] = useState<Map<string, StudentListItem>>(new Map());
  const [moving, setMoving] = useState(false);

  const classes = snapshot.data?.classes.filter((c) => c.status === 'active') ?? [];
  const sections = (snapshot.data?.sections ?? []).filter(
    (s) => s.status === 'active' && (!classId || s.class_id === classId),
  );
  const className = new Map(classes.map((c) => [c.id, c.name]));
  const rows = query.data?.pages.flatMap((p) => p.items) ?? [];

  const toggle = (s: StudentListItem, on: boolean) =>
    setSelected((m) => {
      const n = new Map(m);
      if (on) n.set(s.student_id, s);
      else n.delete(s.student_id);
      return n;
    });

  return (
    <div className="space-y-4">
      <PageHeader
        title="Students"
        actions={
          <>
            {canManage && selected.size > 0 && (
              <Button size="sm" variant="outline" onClick={() => setMoving(true)}>
                Move {selected.size} selected
              </Button>
            )}
            {canAdmit && (
              <Button size="sm" asChild>
                <Link to="/admissions/admit">Admit a student</Link>
              </Button>
            )}
          </>
        }
      />
      <div className="grid gap-3 sm:grid-cols-[1fr_12rem_10rem]">
        <div className="space-y-1">
          <Label htmlFor="student-search">Search</Label>
          <Input
            id="student-search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Name or admission number"
            autoComplete="off"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="student-class">Class</Label>
          <Select
            value={classId ?? ALL}
            onValueChange={(v) => {
              setClassId(v === ALL ? null : v);
              setSectionId(null);
            }}
          >
            <SelectTrigger id="student-class" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All classes</SelectItem>
              {classes.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="student-section">Section</Label>
          <Select value={sectionId ?? ALL} onValueChange={(v) => setSectionId(v === ALL ? null : v)}>
            <SelectTrigger id="student-section" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All sections</SelectItem>
              {sections.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {className.get(s.class_id) ?? ''} {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <DataState
        query={query}
        isEmpty={(d) => d.pages[0]?.items.length === 0}
        emptyTitle={debounced || classId || sectionId ? 'No students match these filters' : 'No students yet'}
      >
        {() => (
          <div className="space-y-3">
            <ul className="bg-background divide-y rounded-md border" aria-label="Students">
              {rows.map((s) => (
                <li
                  key={s.student_id}
                  className="flex items-center gap-3 p-3"
                  data-testid={`student-${s.admission_no}`}
                >
                  {canManage && (
                    <Checkbox
                      checked={selected.has(s.student_id)}
                      onCheckedChange={(v) => toggle(s, v === true)}
                      aria-label={`Select ${s.name}`}
                    />
                  )}
                  <Link to={`/students/${s.student_id}`} className="min-w-0 flex-1">
                    <span className="block font-medium underline-offset-2 hover:underline">{s.name}</span>
                    <span className="text-muted-foreground block text-sm">
                      {s.admission_no} · {placementText(s)}
                      {s.roll_no ? ` · Roll ${s.roll_no}` : ''}
                    </span>
                  </Link>
                  {s.status !== 'active' && (
                    <Badge variant="outline" className="capitalize">
                      {s.status}
                    </Badge>
                  )}
                </li>
              ))}
            </ul>
            <div className="text-muted-foreground flex items-center justify-between text-sm">
              <span role="status">
                Showing {rows.length} student{rows.length === 1 ? '' : 's'}
                {query.hasNextPage ? ' — more available' : ''}
              </span>
              {query.hasNextPage && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void query.fetchNextPage()}
                  disabled={query.isFetchingNextPage}
                >
                  {query.isFetchingNextPage ? 'Loading…' : 'Load more'}
                </Button>
              )}
            </div>
          </div>
        )}
      </DataState>
      {moving && snapshot.data && (
        <MovePlacementsDialog
          students={[...selected.values()]}
          snapshot={snapshot.data}
          open
          onOpenChange={(o) => !o && setMoving(false)}
          onDone={() => {
            setSelected(new Map());
            setMoving(false);
          }}
        />
      )}
    </div>
  );
}

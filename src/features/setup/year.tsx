import { useSearchParams } from 'react-router';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { AcademicYearRow } from '@/contracts/setup';
import { useCurrentYearId } from '@/lib/scope';

/**
 * Year selection for setup pages, kept in the URL (?year=) so it survives navigation and reload.
 * Defaults to the school's current year (brief §1.2).
 */
export function useSelectedYear(): [string | null, (id: string) => void] {
  const [params, setParams] = useSearchParams();
  const current = useCurrentYearId();
  const year = params.get('year') ?? current;
  const setYear = (id: string) =>
    setParams(
      (p) => {
        const next = new URLSearchParams(p);
        next.set('year', id);
        return next;
      },
      { replace: true },
    );
  return [year, setYear];
}

export function YearSelect({
  years,
  value,
  onChange,
}: {
  years: AcademicYearRow[];
  value: string | null;
  onChange: (id: string) => void;
}) {
  if (years.length === 0) return null;
  return (
    <div className="flex items-center gap-2">
      <Label htmlFor="year-select" className="shrink-0">
        Academic year
      </Label>
      <Select value={value ?? ''} onValueChange={onChange}>
        <SelectTrigger id="year-select" className="w-44">
          <SelectValue placeholder="Choose a year" />
        </SelectTrigger>
        <SelectContent>
          {years.map((y) => (
            <SelectItem key={y.id} value={y.id}>
              {y.name}
              {y.is_current ? ' (current)' : ''}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

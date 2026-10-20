import { useQuery } from '@tanstack/react-query';
import { getAcademicCoverage, getFeeHeadReport } from '@/lib/rpc';
import { useScopedKey } from '@/lib/scope';

// Academic coverage (Principal/Admin) and fee-head totals (fees.read).

export function useAcademicCoverage(from: string, to: string, sectionId: string | null, enabled = true) {
  const key = useScopedKey();
  return useQuery({
    queryKey: key('academic-coverage', from, to, sectionId),
    queryFn: ({ signal }) =>
      getAcademicCoverage(
        { p_from: from, p_to: to, ...(sectionId ? { p_section_id: sectionId } : {}) },
        { signal },
      ),
    enabled,
  });
}

export function useFeeHeadReport(yearId: string | null, termId: string | null) {
  const key = useScopedKey();
  return useQuery({
    queryKey: key('fee-head-report', yearId, termId),
    queryFn: ({ signal }) =>
      getFeeHeadReport(
        {
          ...(yearId ? { p_academic_year_id: yearId } : {}),
          ...(termId ? { p_fee_term_id: termId } : {}),
        },
        { signal },
      ),
    enabled: yearId !== null,
  });
}

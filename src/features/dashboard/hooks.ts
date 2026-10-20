import { useQuery } from '@tanstack/react-query';
import { getDashboard } from '@/lib/rpc';
import { useScopedKey } from '@/lib/scope';

/** get_dashboard: one capability-scoped summary for the home screens (2400, fees changed in 2410). */
export function useDashboard(date: string) {
  const key = useScopedKey();
  return useQuery({
    queryKey: key('dashboard', date),
    queryFn: ({ signal }) => getDashboard({ p_date: date }, { signal }),
  });
}

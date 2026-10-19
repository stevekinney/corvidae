/**
 * The one query behind what each schedule is (`lib/schedule-kinds.ts`), shared by the list, a
 * schedule's page, and the drawers, so the Bureau is asked once and every write invalidates it with
 * the rest of the schedules.
 */
import type { HttpClient } from '@lostgradient/weft';

import { queryKeys } from '../../lib/query.ts';
import { loadScheduleOverlay } from '../../lib/schedule-kinds.ts';

export function scheduleOverlayOptions(client: HttpClient) {
  return {
    queryKey: queryKeys.schedules.overlay(),
    queryFn: ({ signal }: { signal: AbortSignal }) => loadScheduleOverlay(client, { signal }),
    retry: false,
  };
}

<script lang="ts">
  /**
   * When a schedule last fired and how that run ended, said at the end of a row's second line:
   * "Last run Oct 29", "Last run Oct 30, failed", or "Never run" for a schedule that has not fired.
   * How it ended is the status of the newest run the schedule launched, which is the same read as
   * the schedule's page shows as its recent runs, so the two share one cache entry. A run that
   * succeeded, that is still going, or that the engine no longer lists is said by its date alone.
   * A phone's third line says "Last ran Oct 24" and has nothing to say of a schedule that never ran.
   */
  import { formatDate } from '@lostgradient/cinder';

  import { createQuery } from '@tanstack/svelte-query';

  import { getClient } from '../../lib/client.ts';
  import { fetchScheduleRunHistory, scheduleRunHistoryQueryKey } from './schedule-queries.ts';

  interface Props {
    scheduleId: string;
    /** When the schedule last fired, in milliseconds; `undefined` for one that never has. */
    lastFireAt: number | undefined;
    /** Say "Last ran" and nothing for a schedule that never ran, as a phone's third line does. */
    phone?: boolean;
  }

  let { scheduleId, lastFireAt, phone = false }: Props = $props();

  const client = getClient();
  const history = createQuery(() => ({
    queryKey: scheduleRunHistoryQueryKey(scheduleId),
    queryFn: () => fetchScheduleRunHistory(client, scheduleId),
    enabled: lastFireAt !== undefined,
    retry: false,
  }));

  const newest = $derived(history.data?.items[0]);
  const outcome = $derived.by<'succeeded' | 'failed' | 'canceled' | null>(() => {
    switch (newest?.status) {
      case 'completed':
        return 'succeeded';
      case 'failed':
      case 'timed-out':
        return 'failed';
      case 'cancelled':
        return 'canceled';
      default:
        return null;
    }
  });
  const ending = $derived(
    outcome === 'failed' ? ', failed' : outcome === 'canceled' ? ', canceled' : '',
  );
</script>

{#if lastFireAt === undefined}
  {#if !phone}<span data-testid="schedule-last-fire" data-outcome="never">Never run</span>{/if}
{:else}
  <span data-testid="schedule-last-fire" data-outcome={outcome ?? 'unknown'}
    >{phone ? 'Last ran' : 'Last run'}
    {formatDate(lastFireAt, 'en-US', { month: 'short', day: 'numeric' })}{ending}</span
  >
{/if}

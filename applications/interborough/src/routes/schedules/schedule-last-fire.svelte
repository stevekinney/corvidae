<script lang="ts">
  /**
   * When a schedule last fired and how that run ended: "last ✓ 19h ago". How it ended is the
   * status of the newest run the schedule launched, which is the same read as the schedule's page
   * shows as its recent runs, so the two share one cache entry. A run that is still going, or that
   * the engine no longer lists, is said by its time alone.
   */
  import { CircleCheck, CircleX } from '@lucide/svelte';

  import { createQuery } from '@tanstack/svelte-query';

  import { SCHEDULE_COPY } from '../../app/copy.ts';
  import { getClient } from '../../lib/client.ts';
  import { formatRelativeTime } from '../../lib/format/index.ts';
  import { fetchScheduleRunHistory, scheduleRunHistoryQueryKey } from './schedule-queries.ts';

  interface Props {
    scheduleId: string;
    /** When the schedule last fired, in milliseconds; `undefined` for one that never has. */
    lastFireAt: number | undefined;
  }

  let { scheduleId, lastFireAt }: Props = $props();

  const client = getClient();
  const history = createQuery(() => ({
    queryKey: scheduleRunHistoryQueryKey(scheduleId),
    queryFn: () => fetchScheduleRunHistory(client, scheduleId),
    enabled: lastFireAt !== undefined,
    retry: false,
  }));

  const newest = $derived(history.data?.items[0]);
  const outcome = $derived.by<'succeeded' | 'failed' | null>(() => {
    switch (newest?.status) {
      case 'completed':
        return 'succeeded';
      case 'failed':
      case 'timed-out':
      case 'cancelled':
        return 'failed';
      default:
        return null;
    }
  });
</script>

{#if lastFireAt === undefined}
  <span>{SCHEDULE_COPY.neverFired}</span>
{:else}
  <span data-testid="schedule-last-fire" data-outcome={outcome ?? 'unknown'}
    >last
    {#if outcome === 'succeeded'}
      <CircleCheck class="ib-schedule-glyph" size={14} aria-label={SCHEDULE_COPY.lastSucceeded} />
    {:else if outcome === 'failed'}
      <CircleX class="ib-schedule-glyph" size={14} aria-label={SCHEDULE_COPY.lastFailed} />
    {/if}
    {formatRelativeTime(lastFireAt)}</span
  >
{/if}

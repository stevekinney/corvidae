<script lang="ts">
  /**
   * When a schedule last fired and how that run ended, said at the end of a row's second line:
   * "Last run Oct 29", "Last run Oct 30, failed", or "Never run" for a schedule that has not fired.
   * How it ended is the status of the run the last fire launched, which is the newest run the
   * schedule launched that started no later than the fire (a run a person started with Run now
   * after it is not the fire's). It is the same read as the schedule's page shows as its recent
   * runs, so the two share one cache entry. A run that succeeded, that is still going, or that the
   * engine no longer lists is said by its date alone. A phone's third line says "Last ran Oct 24"
   * and has nothing to say of a schedule that never ran. The schedule's own page says it in the
   * summary line, "Last ran Oct 29, done", "Last ran Oct 30, failed at step 2" or "Never run", so a
   * run that succeeded is "done" there and a run that failed says the step it stopped at.
   */
  import { formatDate } from '@lostgradient/cinder';

  import { createQuery } from '@tanstack/svelte-query';

  import { SCHEDULE_COPY } from '../../app/copy.ts';
  import { getClient } from '../../lib/client.ts';
  import { fetchRunDetail, runDetailQueryKey } from './schedule-run-details.ts';
  import { fetchScheduleRunHistory, scheduleRunHistoryQueryKey } from './schedule-queries.ts';

  /** A run is launched a moment after the fire that launches it; a later start is another run's. */
  const FIRE_TOLERANCE_MILLISECONDS = 60_000;

  interface Props {
    scheduleId: string;
    /** When the schedule last fired, in milliseconds; `undefined` for one that never has. */
    lastFireAt: number | undefined;
    /** Say "Last ran" and nothing for a schedule that never ran, as a phone's third line does. */
    phone?: boolean;
    /** Say it as the summary line of the schedule's page does: "Last ran Oct 29, done", and "Never run". */
    summary?: boolean;
  }

  let { scheduleId, lastFireAt, phone = false, summary = false }: Props = $props();

  const client = getClient();
  const history = createQuery(() => ({
    queryKey: scheduleRunHistoryQueryKey(scheduleId),
    queryFn: () => fetchScheduleRunHistory(client, scheduleId),
    enabled: lastFireAt !== undefined,
    retry: false,
  }));

  const newest = $derived(
    lastFireAt === undefined
      ? undefined
      : history.data?.items.find(
          (run) => run.createdAt <= lastFireAt + FIRE_TOLERANCE_MILLISECONDS,
        ),
  );
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
  // Only the summary line says where a run that failed stopped, so only it reads the run's steps.
  const detail = createQuery(() => ({
    queryKey: runDetailQueryKey(newest?.id ?? ''),
    queryFn: () => fetchRunDetail(client, newest?.id ?? ''),
    enabled: summary && outcome === 'failed' && newest !== undefined,
    retry: false,
  }));
  const failedStep = $derived(detail.data?.failedStep);
  const ending = $derived(
    outcome === 'failed'
      ? summary && failedStep !== undefined
        ? SCHEDULE_COPY.detail.summary.failedAtStep(failedStep)
        : ', failed'
      : outcome === 'canceled'
        ? ', canceled'
        : summary && outcome === 'succeeded'
          ? ', done'
          : '',
  );
</script>

{#if lastFireAt === undefined}
  {#if !phone}<span data-testid="schedule-last-fire" data-outcome="never">Never run</span>{/if}
{:else}
  <span data-testid="schedule-last-fire" data-outcome={outcome ?? 'unknown'}
    >{phone || summary ? 'Last ran' : 'Last run'}
    {formatDate(lastFireAt, 'en-US', { month: 'short', day: 'numeric' })}{ending}</span
  >
{/if}

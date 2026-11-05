<script lang="ts">
  /**
   * The four counts under the tab bar, the same four with the same labels and windows as Home:
   * Running now, Needs you, Failed in 24 hours and Missed schedule runs (7 days), each with a line
   * that says what the number means in words. An amber dot comes before a label only when its
   * count is a non-zero bad one, so a healthy page carries none. A count that could not be read
   * shows a dash and says so, and never a zero. On the page's first read all four show a placeholder
   * block where the number will be (row 76x), because a count waits for its data rather than showing
   * zero.
   */
  import { Statistic, StatisticGroup } from '@lostgradient/cinder';

  import { HEALTH_COUNTS_COPY as copy } from './health-copy.ts';
  import type { HealthCount } from './health-overview-data.ts';

  interface Props {
    running: HealthCount;
    needsYou: HealthCount;
    failed: HealthCount;
    missed: HealthCount;
    /** Whether the page is still on its first read: every count then waits, whatever has answered. */
    loading?: boolean;
  }

  let { running, needsYou, failed, missed, loading = false }: Props = $props();

  const cards = $derived([
    { key: 'running', label: copy.runningNow, count: running },
    { key: 'needs-you', label: copy.needsYou, count: needsYou },
    { key: 'failed', label: copy.failedIn24Hours, count: failed },
    { key: 'missed', label: copy.missedRuns, count: missed },
  ]);
</script>

<StatisticGroup variant="cards" columns={4} label={copy.label} data-testid="health-counts">
  {#each cards as card (card.key)}
    {#if loading || card.count.value === undefined}
      <Statistic label={card.label} value={0} loading data-count={card.key} />
    {:else}
      <Statistic
        label={card.label}
        value={card.count.value ?? copy.unavailable}
        caption={card.count.value === null ? 'Couldn’t be read' : card.count.caption}
        attention={card.count.bad && card.count.value !== null && card.count.value > 0}
        data-count={card.key}
      />
    {/if}
  {/each}
</StatisticGroup>

<script lang="ts">
  /**
   * The four counts under the tab bar, the same four with the same labels and windows as Home:
   * Running now, Needs you, Failed in 24 hours and Missed schedule runs (7 days), each with a line
   * that says what the number means in words. An amber dot comes before a label only when its
   * count is a non-zero bad one, so a healthy page carries none. A count that could not be read
   * shows a dash and says so, and never a zero.
   */
  import { Skeleton, Statistic, StatisticGroup } from '@lostgradient/cinder';

  import { HEALTH_COUNTS_COPY as copy } from './health-copy.ts';
  import type { HealthCount } from './health-overview-data.ts';

  interface Props {
    running: HealthCount;
    needsYou: HealthCount;
    failed: HealthCount;
    missed: HealthCount;
  }

  let { running, needsYou, failed, missed }: Props = $props();

  const cards = $derived([
    { key: 'running', label: copy.runningNow, count: running },
    { key: 'needs-you', label: copy.needsYou, count: needsYou },
    { key: 'failed', label: copy.failedIn24Hours, count: failed },
    { key: 'missed', label: copy.missedRuns, count: missed },
  ]);
</script>

<StatisticGroup variant="cards" columns={4} label={copy.label} data-testid="health-counts">
  {#each cards as card (card.key)}
    {#if card.count.value === undefined}
      <div
        class="ib-health-count"
        role="status"
        aria-busy="true"
        aria-label={`Loading ${card.label}`}
      >
        <Statistic label={card.label} value="" />
        <Skeleton height="1.75rem" width="3rem" />
      </div>
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

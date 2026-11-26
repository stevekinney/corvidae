<script lang="ts">
  /**
   * The counts under the tab bar, the same four with the same labels and windows as Home: Running
   * now, Needs you, Failed in 24 hours and Missed runs in 7 days, each with a line that says what the
   * number means in words. They follow the rule Home's count follows (`lib/worth-showing.ts`, owner
   * 2026-11-19): a count is a tile only when it is not zero, so a healthy page, where every count is
   * zero, draws no tile row at all, and a count that has not answered draws no tile either. A count
   * that could not be read shows a dash and says so, and never a zero. An amber dot comes before a
   * label only when its count is a non-zero bad one. No label carries a parenthesised qualifier.
   */
  import { Statistic } from '@lostgradient/cinder';

  import { countsWorthShowing } from '../../lib/worth-showing.ts';
  import { HEALTH_COUNTS_COPY as copy } from './health-copy.ts';
  import type { HealthCount } from './health-overview-data.ts';

  interface Props {
    running: HealthCount;
    needsYou: HealthCount;
    failed: HealthCount;
    missed: HealthCount;
  }

  let { running, needsYou, failed, missed }: Props = $props();

  const cards = $derived(
    countsWorthShowing([
      { key: 'running', label: copy.runningNow, ...running },
      { key: 'needs-you', label: copy.needsYou, ...needsYou },
      { key: 'failed', label: copy.failedIn24Hours, ...failed },
      { key: 'missed', label: copy.missedRuns, ...missed },
    ]),
  );
</script>

{#if cards.length > 0}
  <div role="group" aria-label={copy.label} class="ib-health-counts" data-testid="health-counts">
    {#each cards as card (card.key)}
      <Statistic
        label={card.label}
        value={card.value ?? copy.unavailable}
        caption={card.value === null ? copy.unreadable : card.caption}
        attention={card.bad && card.value !== null && card.value !== undefined && card.value > 0}
        data-count={card.key}
      />
    {/each}
  </div>
{/if}

<style>
  .ib-health-counts {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--cinder-space-4);
  }

  @media (min-width: 30rem) {
    .ib-health-counts {
      grid-template-columns: repeat(4, minmax(0, 1fr));
    }
  }
</style>

<script lang="ts">
  /**
   * The three metric cards beside the Needs attention list: Storage use, Runs started and Time to
   * finish, each for the last 24 hours (row 76n). Storage use shows the latest reported size and,
   * once two sizes have been reported, a thin trend line with the window named at each end; until
   * then it says "Charts fill in as Interborough runs." and draws none (sweep S76). A figure that
   * could not be read shows a dash and says so, and never zero. While the page loads each card keeps
   * its heading and shows bars where its figure will be (row 76x).
   */
  import { Card, Skeleton, Sparkbar } from '@lostgradient/cinder';

  import { HEALTH_METRICS_COPY as copy } from './health-copy.ts';
  import {
    finishTime,
    startedCaption,
    storageUseSize,
    type StartedSummary,
  } from './health-overview-data.ts';
  import type { StorageSample } from './storage-sizes.svelte.ts';

  interface Props {
    /** The latest reported size in bytes, `undefined` while nothing has reported one. */
    storageBytes: number | undefined;
    /** The sizes reported in the window, oldest first. */
    samples: readonly StorageSample[];
    /** The runs started in the window: `undefined` while loading, `null` when they could not be read. */
    started: StartedSummary | undefined | null;
    /** The median finish time: `undefined` while loading, `null` when unreadable, `'none'` when no run finished. */
    finish: { milliseconds: number; count: number } | undefined | null | 'none';
    /** Whether the page is still loading: every card then shows placeholders, never a figure or a dash. */
    loading?: boolean;
  }

  let { storageBytes, samples, started, finish, loading = false }: Props = $props();

  const hasChart = $derived(samples.length >= 2);
  const first = $derived(samples[0]);
</script>

<!-- The same two bars in every card while the page loads: the figure, then what draws under it. -->
{#snippet placeholder()}
  <div class="ib-metric-card__placeholder">
    <Skeleton height="1.5rem" width="40%" />
    <Skeleton height="2.25rem" />
  </div>
{/snippet}

<div class="ib-metric-cards" data-testid="metric-cards">
  <Card class="ib-metric-card" data-metric="storage">
    {#snippet header()}
      <div class="ib-metric-card__heading">
        <h2 class="ib-metric-card__title">{copy.storageUse}</h2>
        <span class="ib-metric-card__window">{copy.window}</span>
      </div>
    {/snippet}
    {#if loading}
      {@render placeholder()}
    {:else if storageBytes === undefined}
      <p class="ib-metric-card__value">{copy.unavailable}</p>
      <p class="ib-metric-card__caption">{copy.noSizeCaption}</p>
    {:else}
      <p class="ib-metric-card__value">{storageUseSize(storageBytes)}</p>
      {#if hasChart && first !== undefined}
        <Sparkbar
          size="md"
          points={samples.map((sample) => sample.bytes)}
          label={copy.storageSeries(storageUseSize(storageBytes))}
          startLabel={copy.axisStart(storageUseSize(first.bytes))}
          endLabel={copy.axisEnd}
        />
      {:else}
        <p class="ib-metric-card__caption">{copy.chartsFill}</p>
      {/if}
    {/if}
  </Card>

  <Card class="ib-metric-card" data-metric="runs-started">
    {#snippet header()}
      <div class="ib-metric-card__heading">
        <h2 class="ib-metric-card__title">{copy.runsStarted}</h2>
        <span class="ib-metric-card__window">{copy.window}</span>
      </div>
    {/snippet}
    {#if loading || started === undefined}
      {@render placeholder()}
    {:else if started === null}
      <p class="ib-metric-card__value">{copy.unavailable}</p>
      <p class="ib-metric-card__caption">{copy.unavailableCaption}</p>
    {:else}
      <p class="ib-metric-card__value">{started.total}</p>
      <p class="ib-metric-card__caption">{startedCaption(started)}</p>
    {/if}
  </Card>

  <Card class="ib-metric-card" data-metric="time-to-finish">
    {#snippet header()}
      <div class="ib-metric-card__heading">
        <h2 class="ib-metric-card__title">{copy.timeToFinish}</h2>
        <span class="ib-metric-card__window">{copy.window}</span>
      </div>
    {/snippet}
    {#if loading || finish === undefined}
      {@render placeholder()}
    {:else if finish === null}
      <p class="ib-metric-card__value">{copy.unavailable}</p>
      <p class="ib-metric-card__caption">{copy.unavailableCaption}</p>
    {:else if finish === 'none'}
      <p class="ib-metric-card__value">{copy.unavailable}</p>
      <p class="ib-metric-card__caption">{copy.noFinished}</p>
    {:else}
      <p class="ib-metric-card__value">{finishTime(finish.milliseconds)}</p>
      <p class="ib-metric-card__caption">{copy.medianCaption(finish.count, started?.total)}</p>
    {/if}
  </Card>
</div>

<style>
  .ib-metric-cards {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-4);
    min-width: 0;
  }

  /* Under Needs attention the three cards sit in a row; in the narrow column beside it they stack. */
  @container (min-width: 36rem) {
    .ib-metric-cards {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }
  }

  .ib-metric-card__heading {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--cinder-space-2);
  }

  .ib-metric-card__title {
    margin: 0;
    font-size: var(--cinder-text-md);
    font-weight: 600;
  }

  .ib-metric-card__window {
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-sm);
  }

  .ib-metric-card__placeholder {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-3);
  }

  .ib-metric-card__value {
    margin: 0;
    font-size: var(--cinder-text-3xl);
    font-variant-numeric: tabular-nums;
    font-weight: var(--cinder-font-semibold);
    line-height: 1.1;
  }

  .ib-metric-card__caption {
    margin: var(--cinder-space-1) 0 0;
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-sm);
  }
</style>

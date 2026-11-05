<script lang="ts">
  /**
   * The three metric cards beside the Needs attention list: Storage use, Runs started and Time to
   * finish, each for the last 24 hours (row 76n). Storage use shows the latest reported size and,
   * once two sizes have been reported, a thin trend line with the window named at each end; until
   * then it says "Charts fill in as Interborough runs." and draws none (sweep S76). A figure that
   * could not be read shows a dash and says so, and never zero.
   */
  import { Card, Skeleton, Sparkbar } from '@lostgradient/cinder';

  import { formatBytes } from '../../lib/format/index.ts';
  import { HEALTH_METRICS_COPY as copy } from './health-copy.ts';
  import { finishTime, startedCaption, type StartedSummary } from './health-overview-data.ts';
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
    /** Whether the page is still waiting on the figures that come from the engine. */
    loading?: boolean;
  }

  let { storageBytes, samples, started, finish, loading = false }: Props = $props();

  const hasChart = $derived(samples.length >= 2);
  const first = $derived(samples[0]);
</script>

<div class="ib-metric-cards" data-testid="metric-cards">
  <Card class="ib-metric-card" data-metric="storage">
    {#snippet header()}
      <div class="ib-metric-card__heading">
        <h2 class="ib-metric-card__title">{copy.storageUse}</h2>
        <span class="ib-metric-card__window">{copy.window}</span>
      </div>
    {/snippet}
    {#if loading}
      <Skeleton height="2rem" width="40%" />
      <Skeleton height="4rem" />
    {:else if storageBytes === undefined}
      <p class="ib-metric-card__value">{copy.unavailable}</p>
      <p class="ib-metric-card__caption">{copy.noSizeCaption}</p>
    {:else}
      <p class="ib-metric-card__value">{formatBytes(storageBytes)}</p>
      {#if hasChart && first !== undefined}
        <Sparkbar
          size="md"
          points={samples.map((sample) => sample.bytes)}
          label={copy.storageSeries(formatBytes(storageBytes))}
          startLabel={copy.axisStart(formatBytes(first.bytes))}
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
    {#if started === undefined}
      <Skeleton height="2rem" width="30%" />
      <Skeleton height="1rem" width="60%" />
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
    {#if finish === undefined}
      <Skeleton height="2rem" width="30%" />
      <Skeleton height="1rem" width="60%" />
    {:else if finish === null}
      <p class="ib-metric-card__value">{copy.unavailable}</p>
      <p class="ib-metric-card__caption">{copy.unavailableCaption}</p>
    {:else if finish === 'none'}
      <p class="ib-metric-card__value">{copy.unavailable}</p>
      <p class="ib-metric-card__caption">{copy.noFinished}</p>
    {:else}
      <p class="ib-metric-card__value">{finishTime(finish.milliseconds)}</p>
      <p class="ib-metric-card__caption">{copy.medianCaption(finish.count)}</p>
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

<script lang="ts">
  /**
   * One update of the run's history: its name, when it arrived, and what became of it. A completed
   * update's result is read here (`weft.updates.result.get`, a query of its own so each row asks for
   * only its own); every other outcome is in the history entry. See `updates-data.ts` for which fact
   * comes from where.
   */
  import { Badge } from '@lostgradient/cinder';
  import { Ban, CircleCheck, CircleX } from '@lucide/svelte';
  import { createQuery } from '@tanstack/svelte-query';

  import { RUN_DETAIL_COPY } from '../../../../app/copy.ts';
  import { faultTreatment } from '../../../../lib/faults.ts';
  import { formatRelativeTime } from '../../../../lib/format/index.ts';
  import {
    describeUpdate,
    entryNeedsResult,
    readUpdateResult,
    updateResultQueryKey,
    type UpdateHistoryEntry,
    type UpdatesClient,
  } from './updates-data.ts';

  interface UpdateHistoryRowProps {
    readonly client: UpdatesClient;
    readonly entry: UpdateHistoryEntry;
    /** Whether the run has ended: a pending update on one never will be answered. */
    readonly runIsTerminal: boolean;
    /** The tab's clock, for the relative time. */
    readonly now: number;
  }

  let { client, entry, runIsTerminal, now }: UpdateHistoryRowProps = $props();

  const copy = RUN_DETAIL_COPY.updates;

  // The answer is kept five minutes and never changes once stored, so one read is enough.
  const resultQuery = createQuery(() => ({
    queryKey: updateResultQueryKey(entry.updateId),
    queryFn: () => readUpdateResult(client, entry.updateId),
    enabled: entryNeedsResult(entry),
    staleTime: Number.POSITIVE_INFINITY,
  }));

  const display = $derived(describeUpdate(entry, resultQuery.data, runIsTerminal));
  const resultFault = $derived(resultQuery.isError ? faultTreatment(resultQuery.error) : null);
</script>

<div
  class="weft-send-tab__history-row"
  data-update-id={entry.updateId}
  data-status={entry.outcome}
  data-display={display.kind}
>
  {#if display.kind === 'awaiting'}
    <span class="weft-update-row__spinner" aria-hidden="true"></span>
  {:else if display.kind === 'never-answered'}
    <Ban aria-hidden="true" size={15} color="var(--cinder-text-subtle)" />
  {:else if display.kind === 'failed'}
    <CircleX aria-hidden="true" size={15} color="var(--cinder-status-danger-text)" />
  {:else}
    <CircleCheck aria-hidden="true" size={15} color="var(--cinder-status-success-text)" />
  {/if}

  <div class="weft-send-tab__history-name">
    {entry.name}
    <div class="weft-update-row__detail" data-kind={display.kind}>
      {#if display.kind === 'awaiting'}
        {copy.awaiting}
      {:else if display.kind === 'never-answered'}
        {copy.neverAnswered}
      {:else if display.kind === 'failed'}
        {display.message}
      {:else if display.kind === 'swept'}
        {copy.resultSwept}
      {:else if display.kind === 'result'}
        <span class="weft-update-row__result">{JSON.stringify(display.value)}</span>
      {:else if resultFault !== null}
        {resultFault.message}
      {:else}
        {copy.loadingResult}
      {/if}
    </div>
  </div>

  {#if display.kind === 'awaiting'}
    <Badge variant="info" size="sm">pending</Badge>
  {:else}
    <span class="weft-send-tab__history-time">{formatRelativeTime(entry.receivedAt, now)}</span>
  {/if}
</div>

<style>
  .weft-update-row__detail {
    font-size: var(--cinder-text-xs);
    color: var(--cinder-text-subtle);
  }

  .weft-update-row__detail[data-kind='failed'] {
    color: var(--cinder-status-danger-text);
  }

  .weft-update-row__result {
    font-family: var(--cinder-font-mono);
    overflow-wrap: anywhere;
  }

  .weft-update-row__spinner {
    flex: none;
    width: 13px;
    height: 13px;
    border: 2px solid var(--cinder-status-info-border);
    border-top-color: transparent;
    border-radius: 50%;
    display: inline-block;
    animation: weft-update-row-spin 0.7s linear infinite;
  }

  @media (prefers-reduced-motion: reduce) {
    .weft-update-row__spinner {
      animation-duration: 0.001ms;
    }
  }

  @keyframes weft-update-row-spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>

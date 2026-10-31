<script lang="ts">
  /**
   * Updates tab (plan T2.6, rebuilt for COR-1463): every update the run has received, newest first,
   * and a form that sends another.
   *
   * ## Where the history comes from
   *
   * It comes from the run, not from this browser session. `weft.workflows.updates.list` lists the
   * updates the run received through the durable request path, including ones sent before this page
   * loaded and ones whose submission timed out; the entry is written with the request, before the
   * wait. `updates/updates-data.ts` says which fact each row's outcome comes from (the history for
   * `failed`, `weft.updates.result.get` for a result, whether the run has ended for "never answered").
   *
   * A submission that times out is not a fault: the update stays queued. The wait ending is a notice,
   * the update stays listed (as awaiting its result), and the history is asked again every two
   * seconds while the run is live and any update is unanswered, so its result appears when it lands.
   * That poll runs only while the fleet feed is not live: `update:received` and `update:completed`
   * frames invalidate the history (`applyFleetEventFrame`), which asks again when one arrives.
   *
   * Without `updates:write` the send form is not drawn.
   */
  import { Button, Input, JsonEditor, Skeleton } from '@lostgradient/cinder';
  import type { WorkflowState } from '@lostgradient/weft';
  import { createQuery, keepPreviousData, useQueryClient } from '@tanstack/svelte-query';
  import { onDestroy } from 'svelte';

  import { RUN_DETAIL_COPY } from '../../../app/copy.ts';
  import { useFleetEventsLive } from '../../../app/live-polling.svelte.ts';
  import { classifyFault, faultTreatment, type FaultTreatment } from '../../../lib/faults.ts';
  import RunFaultBanner from './run-fault-banner.svelte';
  import { TickingClock } from './ticking-clock.svelte.ts';
  import UpdateHistoryRow from './updates/update-history-row.svelte';
  import {
    isSubmissionTimeout,
    readUpdateHistoryPages,
    sendUpdate,
    UPDATE_HISTORY_POLL_INTERVAL_MS,
    updateHistoryQueryKey,
    type UpdatesClient,
  } from './updates/updates-data.ts';
  import { isTerminalStatus } from './workflow-status.ts';

  interface UpdatesTabProps {
    readonly client: UpdatesClient;
    readonly workflow: WorkflowState;
    /** Whether the principal holds `updates:write`, which `weft.workflows.update` requires. Without it the form is not drawn. */
    readonly canSend: boolean;
  }

  let { client, workflow, canSend }: UpdatesTabProps = $props();

  const copy = RUN_DETAIL_COPY.updates;
  const queryClient = useQueryClient();
  const clock = new TickingClock();
  onDestroy(() => clock.dispose());

  const runIsTerminal = $derived(isTerminalStatus(workflow.status));

  // How many pages of the history are showing. "Load older updates" adds one. Every read (a poll, or the
  // refresh after a send) reads all of them again, each from the cursor the one before returned
  // (`readUpdateHistoryPages`), so no update falls between two pages and a pending update on an older
  // page is refreshed with the rest.
  let pageCount = $state(1);

  const fleetLive = useFleetEventsLive();
  const historyQuery = createQuery(() => {
    // Read here, not in the interval below, which TanStack calls on its own and so is not tracked.
    const polling = !fleetLive();
    return {
      queryKey: [...updateHistoryQueryKey(workflow.id), pageCount],
      queryFn: () => readUpdateHistoryPages(client, workflow.id, pageCount),
      placeholderData: keepPreviousData,
      // poll-reason: fallback
      refetchInterval: (query) =>
        polling &&
        !runIsTerminal &&
        query.state.data?.items.some((item) => item.outcome === 'pending')
          ? UPDATE_HISTORY_POLL_INTERVAL_MS
          : false,
    };
  });

  const entries = $derived(historyQuery.data?.items ?? []);
  const nextCursor = $derived(historyQuery.data?.nextCursor);
  const loadingOlder = $derived(historyQuery.isPlaceholderData);

  // A read of more pages that fails goes back to the pages that read fine, and says why.
  let olderFault = $state<FaultTreatment | null>(null);
  $effect(() => {
    if (historyQuery.isError && pageCount > 1) {
      olderFault = faultTreatment(historyQuery.error);
      pageCount -= 1;
    }
  });

  function loadOlder(): void {
    olderFault = null;
    pageCount += 1;
  }

  let updateName = $state('');
  let payloadText = $state('');
  let idempotencyKey = $state('');
  let timeoutSeconds = $state(30);
  let payloadError = $state<string | null>(null);
  let submitting = $state(false);
  let submitFault = $state<FaultTreatment | null>(null);
  let timedOutName = $state<string | null>(null);

  function parsePayload(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
    const trimmed = text.trim();
    if (trimmed.length === 0) return { ok: true, value: undefined };
    try {
      return { ok: true, value: JSON.parse(trimmed) };
    } catch {
      return { ok: false, error: 'Payload must be valid JSON (or left blank).' };
    }
  }

  /** A rejected submission as a fault to show: the client's own classification, else the error's message. */
  function submissionFault(error: unknown): FaultTreatment {
    return (
      classifyFault(error) ?? {
        kind: 'internal',
        message: error instanceof Error ? error.message : 'The update failed.',
        maskedByRest: false,
        tryViaJsonRpc: false,
      }
    );
  }

  async function submit(): Promise<void> {
    const trimmedName = updateName.trim();
    if (trimmedName.length === 0) return;
    const parsed = parsePayload(payloadText);
    if (!parsed.ok) {
      payloadError = parsed.error;
      return;
    }
    payloadError = null;
    submitFault = null;
    timedOutName = null;

    const timeoutMs = Math.max(1, timeoutSeconds) * 1000;
    submitting = true;
    updateName = '';
    payloadText = '';

    try {
      await sendUpdate(client, workflow.id, {
        name: trimmedName,
        payload: parsed.value,
        timeoutMs,
        idempotencyKey: idempotencyKey.trim().length > 0 ? idempotencyKey.trim() : undefined,
      });
    } catch (error) {
      // A handler's own failure and a validator's refusal both come back as `Unprocessable`: shown
      // here, and the history lists the failed update when one was queued.
      if (isSubmissionTimeout(error)) timedOutName = trimmedName;
      else submitFault = submissionFault(error);
    } finally {
      submitting = false;
      // Whatever happened, the run's history is the record: ask it again.
      await queryClient.invalidateQueries({ queryKey: updateHistoryQueryKey(workflow.id) });
    }
  }
</script>

<div class="weft-send-tab" data-form={canSend ? 'present' : 'absent'}>
  <div class="weft-send-tab__history">
    <h4 class="weft-panel-title">{copy.heading}</h4>
    {#if timedOutName !== null}
      <p class="weft-update-tab__notice" role="status">{copy.timedOut(timedOutName)}</p>
    {/if}
    {#if historyQuery.isError}
      <div class="weft-update-tab__fault">
        <RunFaultBanner treatment={faultTreatment(historyQuery.error)} />
      </div>
    {:else if historyQuery.isPending}
      <div class="weft-update-tab__loading" aria-busy="true" aria-label={copy.loading}>
        <Skeleton height="3rem" />
      </div>
    {:else if entries.length === 0}
      <p class="weft-update-tab__empty">{copy.empty}</p>
    {:else}
      {#each entries as entry (entry.updateId)}
        <UpdateHistoryRow {client} {entry} {runIsTerminal} now={clock.now} />
      {/each}
      {#if olderFault !== null}
        <div class="weft-update-tab__fault"><RunFaultBanner treatment={olderFault} /></div>
      {/if}
      {#if nextCursor !== undefined}
        <div class="weft-update-tab__more">
          <Button
            variant="ghost"
            size="sm"
            label={copy.loadMore}
            loading={loadingOlder}
            disabled={loadingOlder}
            onclick={loadOlder}
          />
        </div>
      {/if}
    {/if}
  </div>

  {#if canSend}
    <div class="weft-send-tab__form">
      <div class="weft-send-tab__form-title">Send update</div>
      <Input
        id={`update-name-${workflow.id}`}
        label="Update name"
        placeholder="applyDiscount"
        bind:value={updateName}
      />
      <JsonEditor
        id={`update-payload-${workflow.id}`}
        label="Payload"
        description="JSON, optional"
        rows={3}
        value={payloadText}
        onValueChange={(next) => (payloadText = next)}
        validFeedbackVisible={false}
      />
      <div class="weft-send-tab__row">
        <Input
          id={`update-idempotency-${workflow.id}`}
          label="Idempotency key"
          placeholder="auto"
          bind:value={idempotencyKey}
        />
        <Input
          id={`update-timeout-${workflow.id}`}
          label="Timeout (s)"
          type="number"
          value={String(timeoutSeconds)}
          oninput={(event) => {
            const parsed = Number((event.currentTarget as HTMLInputElement).value);
            if (Number.isFinite(parsed) && parsed > 0) timeoutSeconds = parsed;
          }}
        />
      </div>
      {#if payloadError}
        <p class="weft-send-tab__error">{payloadError}</p>
      {/if}
      {#if submitFault !== null}
        <RunFaultBanner treatment={submitFault} />
      {/if}
      <Button
        variant="primary"
        size="sm"
        fullWidth
        label={submitting ? 'Sending…' : 'Send update'}
        loading={submitting}
        disabled={updateName.trim().length === 0 || submitting}
        onclick={() => void submit()}
      />
    </div>
  {/if}
</div>

<style>
  /* Without the form the history takes the whole row. */
  .weft-send-tab[data-form='absent'] {
    grid-template-columns: 1fr;
  }

  .weft-send-tab__row {
    display: flex;
    gap: 10px;
  }

  .weft-send-tab__row > :global(*) {
    flex: 1;
    min-width: 0;
  }

  .weft-update-tab__notice,
  .weft-update-tab__empty {
    margin: 0;
    padding: var(--cinder-density-pad-block) var(--cinder-density-pad-inline);
    font-size: var(--cinder-text-sm);
    color: var(--cinder-text-subtle);
  }

  .weft-update-tab__notice {
    border-bottom: 1px solid var(--cinder-border-muted);
  }

  .weft-update-tab__fault,
  .weft-update-tab__loading,
  .weft-update-tab__more {
    padding: var(--cinder-density-pad-block) var(--cinder-density-pad-inline);
  }
</style>

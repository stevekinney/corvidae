<script lang="ts">
  /**
   * The delivery log beside a hook's steps (design rows 84u to 84y, 85k and 86a to 86c): the heading
   * "Delivery log" with an All / Failed switch at its right, and the hook's recent deliveries, newest
   * first, as plain lines, not a table. Each line reads what the delivery is about, where it
   * stands (a status word, with the receiver's answer or the try it is on), and when, with a
   * disclosure chevron. A line opens to its cause and the facts, its tries, the payload it sent in
   * the payload inspector, and Retry delivery for one that failed. A delivery still retrying shows
   * when its next try is due with Retry now beside it, closed or open.
   *
   * The log is read again when the editor sends a test event or saves, and each time the page opens;
   * a test event is a line of its own. Its states are its own and leave the form untouched: a new
   * hook has no log yet, a slow read shows placeholders (and after ten seconds a status line with
   * Cancel), a read that failed offers Try again for the log alone. A delivery holds the payload it
   * sent, so no plugin formatter's sentence is written for it: formatters read payloads, and a
   * sentence built on an empty one would name nothing.
   */
  import {
    Button,
    Collapsible,
    EmptyState,
    ErrorState,
    Segment,
    SegmentedControl,
    Skeleton,
    StatusDot,
  } from '@lostgradient/cinder';
  import { Webhook } from '@lucide/svelte';
  import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query';

  import { RETRY_LABEL } from '../../app/copy/views.ts';
  import { showFault, showToast } from '../../app/toast-host.svelte';
  import {
    listHookDeliveries,
    retryHookDelivery,
    type HookDelivery,
  } from '../../lib/bureau-hooks.ts';
  import { faultTreatment } from '../../lib/faults.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { HOOKS_COPY } from './hook-copy.ts';
  import HookDeliveryDetail from './hook-delivery-detail.svelte';
  import {
    deliveryLogFailure,
    deliveryStamp,
    deliveryStatusWord,
    deliverySubject,
    nextTryWords,
    retryKind,
  } from './hook-delivery-presentation.ts';
  import { deliveryFailed } from './hook-presentation.ts';

  interface Props {
    /** The hook whose log this is, or `undefined` for a hook not yet saved, which has none. */
    hookId: string | undefined;
  }

  let { hookId }: Props = $props();

  const copy = HOOKS_COPY.editor.deliveries;
  const DELIVERIES_SHOWN = 20;
  /** How long a read is let to finish before anything is drawn for it, which is Cinder's loading rule. */
  const LOADING_DELAY_MILLISECONDS = 300;
  /** How long a read runs before the placeholders say it is taking longer than usual. */
  const STILL_LOADING_MILLISECONDS = 10_000;
  const queryClient = useQueryClient();

  // hidden-label-allowed: the Delivery log heading beside the switch is the visible label of the filter
  const hiddenLabel = { labelVisible: false } as const;

  type Filter = 'all' | 'failed';
  let filter = $state<Filter>('all');

  const deliveries = createQuery(
    () => ({
      queryKey: queryKeys.hooks.deliveries(hookId ?? ''),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        listHookDeliveries(hookId ?? '', DELIVERIES_SHOWN, { signal }),
      enabled: hookId !== undefined,
      retry: false,
    }),
    undefined,
  );

  // "Cancel" in the still-loading line stopped the first read, and "Try again" reads again.
  let loadStopped = $state(false);
  const stopped = $derived(deliveries.isPending && loadStopped);
  const loading = $derived(deliveries.isPending && !loadStopped);
  function stopLoading(): void {
    loadStopped = true;
    void queryClient.cancelQueries({ queryKey: queryKeys.hooks.deliveries(hookId ?? '') });
  }
  function readAgain(): void {
    loadStopped = false;
    void deliveries.refetch();
  }

  /** The moment the log was read, which "Next try in" counts from. */
  const now = $derived.by(() => {
    void deliveries.dataUpdatedAt;
    return Date.now();
  });

  const shown = $derived(
    filter === 'failed'
      ? (deliveries.data ?? []).filter((delivery) => deliveryFailed(delivery))
      : (deliveries.data ?? []),
  );

  const retrying = createMutation(() => ({
    mutationFn: (delivery: HookDelivery): Promise<HookDelivery> => {
      if (hookId === undefined)
        throw new Error('A hook that is not saved has no delivery to retry.');
      return retryHookDelivery(hookId, delivery.id);
    },
    onSuccess: (sent) => {
      showToast(
        sent.status === 'delivered'
          ? copy.retried.delivered
          : sent.status === 'pending'
            ? copy.retried.waiting
            : copy.retried.failed,
        { variant: sent.status === 'delivered' ? 'success' : 'info' },
      );
    },
    onError: (error: unknown) => {
      const treatment = faultTreatment(error);
      showFault({ ...treatment, message: `${copy.retryFailed}. ${treatment.message}` });
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['hooks'] }),
  }));
</script>

<section
  class="ib-hook-deliveries"
  aria-labelledby="ib-hook-deliveries-heading"
  data-testid="hook-deliveries"
>
  <div class="ib-hook-deliveries__top">
    <h2 id="ib-hook-deliveries-heading" class="ib-hook-deliveries__heading">{copy.heading}</h2>
    {#if deliveries.isSuccess && deliveries.data.length > 0}
      <SegmentedControl
        id="ib-hook-deliveries-filter"
        label={copy.filterLabel}
        {...hiddenLabel}
        size="sm"
        value={filter}
        onValueChange={(next: Filter) => (filter = next)}
      >
        <Segment value="all">{copy.all}</Segment>
        <Segment value="failed">{copy.failed}</Segment>
      </SegmentedControl>
    {/if}
  </div>

  {#if hookId === undefined}
    <EmptyState
      size="compact"
      kind="first-use"
      title={copy.none.title}
      description={copy.none.description}
      headingLevel={3}
    >
      {#snippet icon()}<Webhook aria-hidden="true" />{/snippet}
    </EmptyState>
  {:else if loading}
    <div data-testid="hook-deliveries-loading">
      <Skeleton
        lines={3}
        delay={LOADING_DELAY_MILLISECONDS}
        stillLoadingAfter={STILL_LOADING_MILLISECONDS}
        stillLoadingLabel={copy.stillLoading}
        label={copy.loadingLabel}
        onCancel={stopLoading}
      />
    </div>
  {:else if stopped}
    <ErrorState
      tone="neutral"
      title={copy.stopped.title}
      description={copy.stopped.description}
      headingLevel={3}
      retryLabel={RETRY_LABEL}
      retryVariant="secondary"
      onRetry={readAgain}
    />
  {:else if deliveries.isError}
    <ErrorState
      title={copy.loadFailed.title}
      description={deliveryLogFailure(deliveries.error)}
      headingLevel={3}
      retryLabel={RETRY_LABEL}
      onRetry={readAgain}
    />
  {:else if deliveries.data === undefined || deliveries.data.length === 0}
    <EmptyState
      size="compact"
      kind="first-use"
      title={copy.none.title}
      description={copy.none.description}
      headingLevel={3}
    >
      {#snippet icon()}<Webhook aria-hidden="true" />{/snippet}
    </EmptyState>
  {:else if shown.length === 0}
    <EmptyState
      size="compact"
      kind="done"
      title={copy.noneFailed.title}
      description={copy.noneFailed.description}
      headingLevel={3}
    />
  {:else}
    <ul class="ib-hook-deliveries__list" data-testid="hook-delivery-list">
      {#each shown as delivery (delivery.id)}
        <li
          class="ib-hook-deliveries__item"
          data-delivery={delivery.id}
          data-status={delivery.status}
        >
          <Collapsible variant="flat" chevron="end">
            {#snippet trigger()}
              <span class="ib-hook-deliveries__line">
                <span class="ib-hook-deliveries__subject">{deliverySubject(delivery)}</span>
                {#if !delivery.test}
                  <code class="ib-hook-deliveries__kind" data-testid="event-kind"
                    >{delivery.kind}</code
                  >
                {/if}
                <StatusDot
                  word={deliveryStatusWord(delivery)}
                  size="sm"
                  wordTone={delivery.test ? 'status' : 'muted'}
                  data-status-word={delivery.status}
                />
                <span class="ib-hook-deliveries__muted">{deliveryStamp(delivery.updatedAt)}</span>
              </span>
            {/snippet}
            <HookDeliveryDetail
              {delivery}
              retrying={retrying.isPending}
              onRetry={() => retrying.mutate(delivery)}
            />
          </Collapsible>
          {#if retryKind(delivery) === 'retry-now' && delivery.nextAttemptAt !== null}
            <p class="ib-hook-deliveries__soon" data-testid="hook-delivery-next-try">
              <span class="ib-hook-deliveries__muted"
                >{copy.nextTry(nextTryWords(delivery.nextAttemptAt, now))}</span
              >
              <Button
                variant="secondary"
                size="sm"
                data-changes
                disabled={retrying.isPending}
                onclick={() => retrying.mutate(delivery)}>{copy.retryNow}</Button
              >
            </p>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .ib-hook-deliveries {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-3);
    min-width: 0;
  }

  .ib-hook-deliveries__top {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--cinder-space-2);
  }

  .ib-hook-deliveries__heading {
    margin: 0;
    font-size: var(--cinder-text-md);
    font-weight: 600;
  }

  .ib-hook-deliveries__list {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-2);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .ib-hook-deliveries__item {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-1);
    min-width: 0;
    overflow-wrap: anywhere;
  }

  /* One line: what the delivery is about, its word, and its time. The chevron is the disclosure's own. */
  .ib-hook-deliveries__line {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--cinder-space-1) var(--cinder-space-3);
    min-width: 0;
  }

  .ib-hook-deliveries__subject {
    font-weight: 600;
  }

  .ib-hook-deliveries__muted {
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-sm);
  }

  .ib-hook-deliveries__kind {
    font-family: var(--cinder-font-mono);
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-sm);
  }

  .ib-hook-deliveries__soon {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--cinder-space-2);
    margin: 0;
  }
</style>

<script lang="ts">
  /**
   * The recent deliveries of one hook, beside its editor, as plain lines: where each stands, which
   * event it carried (or that it was a test), what the receiver answered or why there was no
   * answer, how many attempts it took, and when. Newest first. They are read again when the editor
   * sends a test event or saves, and each time the page opens.
   */
  import { Alert, RelativeTime, Skeleton } from '@lostgradient/cinder';
  import { createQuery } from '@tanstack/svelte-query';

  import { listHookDeliveries } from '../../lib/bureau-hooks.ts';
  import EventSentence from '../../lib/event-sentence.svelte';
  import { queryKeys } from '../../lib/query.ts';
  import StatusLabel from '../../lib/status-label.svelte';
  import { HOOKS_COPY } from './hook-copy.ts';
  import { deliveryLine, deliveryWord, eventWords } from './hook-presentation.ts';

  interface Props {
    hookId: string;
  }

  let { hookId }: Props = $props();

  const copy = HOOKS_COPY.editor.deliveries;
  const DELIVERIES_SHOWN = 20;

  const deliveries = createQuery(
    () => ({
      queryKey: queryKeys.hooks.deliveries(hookId),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        listHookDeliveries(hookId, DELIVERIES_SHOWN, { signal }),
      retry: false,
    }),
    undefined,
  );
</script>

<section
  class="ib-hook-deliveries"
  aria-labelledby="ib-hook-deliveries-heading"
  data-testid="hook-deliveries"
>
  <h2 id="ib-hook-deliveries-heading" class="ib-hook-deliveries__heading">{copy.heading}</h2>
  {#if deliveries.isPending}
    <Skeleton height="1.25rem" width="60%" />
  {:else if deliveries.isError}
    <Alert variant="danger">{copy.loadFailed}</Alert>
  {:else if deliveries.data.length === 0}
    <p class="ib-hook-deliveries__none">{copy.none}</p>
  {:else}
    <ul class="ib-hook-deliveries__list">
      {#each deliveries.data as delivery (delivery.id)}
        <li
          class="ib-hook-deliveries__item"
          data-delivery={delivery.id}
          data-status={delivery.status}
        >
          <StatusLabel word={deliveryWord(delivery.status)} />
          <span class="ib-hook-deliveries__what">
            {#if delivery.test}
              {copy.testEvent}
            {:else}
              <EventSentence kind={delivery.kind} words={eventWords(delivery.kind)} />
            {/if}
          </span>
          <span class="ib-hook-deliveries__line">{deliveryLine(delivery)}</span>
          {#if delivery.attempts.length > 1}
            <span class="ib-hook-deliveries__muted"
              >{copy.attempts(delivery.attempts.length, delivery.maxAttempts)}</span
            >
          {/if}
          {#if delivery.request !== null}
            <span class="ib-hook-deliveries__muted ib-hook-deliveries__address"
              >{delivery.request.url}</span
            >
          {/if}
          <RelativeTime date={delivery.updatedAt} class="ib-hook-deliveries__muted" />
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

  .ib-hook-deliveries__heading {
    margin: 0;
    font-size: var(--cinder-text-md);
    font-weight: 600;
  }

  .ib-hook-deliveries__none {
    margin: 0;
    color: var(--cinder-text-muted);
  }

  .ib-hook-deliveries__list {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-3);
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

  .ib-hook-deliveries__muted {
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-sm);
  }

  .ib-hook-deliveries__address {
    font-family: var(--cinder-font-mono);
  }
</style>

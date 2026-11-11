<script lang="ts">
  /**
   * What one open delivery of the delivery log holds (design rows 84v to 84y): the cause when it
   * ended badly and what to try, the facts (the event, where it went, the last answer), the tries
   * made (the first three, the rest folded under "Show all"), the payload it sent in the payload
   * inspector (Fields first, with JSON and Copy), and "Retry delivery" for one that failed. The log
   * owns the retry itself; this draws what the delivery says and asks the log to send it again.
   */
  import { Button, PayloadInspector } from '@lostgradient/cinder';
  import { RefreshCw } from '@lucide/svelte';

  import type { HookDelivery } from '../../lib/bureau-hooks.ts';
  import { HOOKS_COPY } from './hook-copy.ts';
  import {
    ATTEMPTS_SHOWN,
    attemptAnswer,
    attemptList,
    deliveryCause,
    deliveryFacts,
    deliveryPayload,
    deliveryStamp,
    payloadFieldText,
    retryKind,
  } from './hook-delivery-presentation.ts';

  interface Props {
    /** The delivery, as the Bureau holds it. */
    delivery: HookDelivery;
    /** Whether a retry of some delivery of this log is being sent, which holds every Retry button. */
    retrying: boolean;
    /** Sends this delivery again from its record. */
    onRetry: () => void;
  }

  let { delivery, retrying, onRetry }: Props = $props();

  const copy = HOOKS_COPY.editor.deliveries;

  let showAllTries = $state(false);

  const cause = $derived(deliveryCause(delivery));
  const facts = $derived(deliveryFacts(delivery));
  const tries = $derived(attemptList(delivery, showAllTries));
  const payload = $derived(deliveryPayload(delivery));
  const canRetry = $derived(retryKind(delivery) === 'retry');
</script>

<div class="ib-hook-delivery" data-testid="hook-delivery-detail">
  {#if cause !== undefined}
    <p class="ib-hook-delivery__cause" data-testid="hook-delivery-cause">{cause}</p>
  {/if}

  <dl class="ib-hook-delivery__facts" data-testid="hook-delivery-facts">
    {#each facts as fact (fact.label)}
      <div class="ib-hook-delivery__fact">
        <dt>{fact.label}</dt>
        <dd>
          {fact.value}
          {#if fact.code !== undefined}
            <code class="ib-hook-delivery__code">{fact.code}</code>
          {/if}
        </dd>
      </div>
    {/each}
  </dl>

  {#if delivery.attempts.length > 0}
    <section class="ib-hook-delivery__tries" aria-label={copy.triesHeading}>
      <ol class="ib-hook-delivery__try-list" data-testid="hook-delivery-tries">
        {#each tries.shown as attempt (attempt.number)}
          <li class="ib-hook-delivery__try">
            <span>{copy.tryNumber(attempt.number)}</span>
            <span class="ib-hook-delivery__muted">{deliveryStamp(attempt.startedAt)}</span>
            <span class="ib-hook-delivery__answer">{attemptAnswer(attempt)}</span>
          </li>
        {/each}
      </ol>
      {#if tries.folded !== undefined}
        <p class="ib-hook-delivery__folded">
          <span class="ib-hook-delivery__muted">{tries.folded}</span>
          <Button variant="ghost" size="sm" onclick={() => (showAllTries = true)}
            >{copy.showAll}</Button
          >
        </p>
      {:else if showAllTries && delivery.attempts.length > ATTEMPTS_SHOWN}
        <p class="ib-hook-delivery__folded">
          <Button variant="ghost" size="sm" onclick={() => (showAllTries = false)}
            >{copy.showFewer}</Button
          >
        </p>
      {/if}
    </section>
  {/if}

  {#if payload.kind === 'none'}
    <p class="ib-hook-delivery__muted" data-testid="hook-delivery-payload">{copy.noPayload}</p>
  {:else if payload.kind === 'text'}
    <div data-testid="hook-delivery-payload">
      <PayloadInspector label={copy.payloadLabel} value={payload.value} plain />
    </div>
  {:else}
    <div data-testid="hook-delivery-payload">
      <PayloadInspector
        label={copy.payloadLabel}
        value={payload.value}
        formatValue={({ path, value }) => payloadFieldText(path, value)}
      />
    </div>
  {/if}

  {#if canRetry}
    <div class="ib-hook-delivery__actions">
      <Button variant="secondary" size="sm" data-changes disabled={retrying} onclick={onRetry}>
        {#snippet leadingIcon()}<RefreshCw aria-hidden="true" />{/snippet}
        {copy.retry}
      </Button>
    </div>
  {/if}
</div>

<style>
  .ib-hook-delivery {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-3);
    min-width: 0;
    padding-block: var(--cinder-space-2);
    overflow-wrap: anywhere;
  }

  .ib-hook-delivery__cause {
    margin: 0;
  }

  .ib-hook-delivery__facts {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-1);
    margin: 0;
  }

  .ib-hook-delivery__fact {
    display: grid;
    grid-template-columns: 7rem minmax(0, 1fr);
    gap: var(--cinder-space-3);
  }

  .ib-hook-delivery__fact dt {
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-sm);
  }

  .ib-hook-delivery__fact dd {
    margin: 0;
  }

  .ib-hook-delivery__code {
    font-family: var(--cinder-font-mono);
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-sm);
  }

  .ib-hook-delivery__tries {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-1);
    min-width: 0;
  }

  .ib-hook-delivery__try-list {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-1);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  /* A try is its number, its time, and its answer, which sits at the right edge. */
  .ib-hook-delivery__try {
    display: grid;
    grid-template-columns: 4rem minmax(0, 1fr) auto;
    gap: var(--cinder-space-3);
    align-items: baseline;
  }

  .ib-hook-delivery__answer {
    text-align: end;
  }

  .ib-hook-delivery__folded {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--cinder-space-2);
    margin: 0;
  }

  .ib-hook-delivery__muted {
    margin: 0;
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-sm);
  }

  .ib-hook-delivery__actions {
    display: flex;
    gap: var(--cinder-space-2);
  }
</style>

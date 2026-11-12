<script lang="ts" module>
  import type { ChatAvailability } from './chat-availability.ts';

  export type ChatAvailabilityStateProps = {
    /** What is wrong with the conversation, or that it is still loading. */
    availability: ChatAvailability;
  };
</script>

<script lang="ts">
  /**
   * Stands where the transcript will be while the conversation is not available (COR-2285, rows V2
   * and V3): skeleton turns with a status line that counts the seconds while it loads, a canceled
   * read with Retry, and Cinder's `ErrorState` for a conversation that could not be read or was
   * deleted. The ticking number is never in a live region: a screen reader hears the status line
   * once, and again when the read turns slow.
   */
  import {
    Button,
    Callout,
    ChevronLeft,
    EmptyState,
    ErrorState,
    Skeleton,
    Spinner,
    Trash2,
    X,
  } from '@lostgradient/cinder';

  import {
    availabilityLabels,
    formatElapsedSeconds,
    isSlowRead,
    type ChatAvailabilityAction,
  } from './chat-availability.ts';

  let { availability }: ChatAvailabilityStateProps = $props();

  const labels = $derived(availabilityLabels(availability));
  const loading = $derived(availability.kind === 'loading');
  const allConversations = $derived<ChatAvailabilityAction | undefined>(
    availability.kind === 'canceled' ||
      availability.kind === 'error' ||
      availability.kind === 'deleted'
      ? availability.allConversations
      : undefined,
  );

  // Seconds since the read began. It counts only while the read is going on, and starts over for
  // the next one.
  let elapsed = $state(0);
  $effect(() => {
    if (!loading) return;
    const started = Date.now();
    elapsed = 0;
    const timer = setInterval(() => {
      elapsed = Math.floor((Date.now() - started) / 1000);
    }, 1000);
    return () => clearInterval(timer);
  });
</script>

{#if availability.kind === 'loading'}
  {@const slow = isSlowRead(elapsed, availability.slowAfterSeconds)}
  {@const reading = formatElapsedSeconds(elapsed)}
  <div
    class="chat-availability chat-availability-loading"
    data-chat-availability="loading"
    data-slow={slow ? '' : undefined}
    aria-busy="true"
  >
    <div class="chat-availability-turns" aria-hidden="true">
      <div class="chat-availability-user">
        <Skeleton height="2.25rem" width="min(15rem, 60%)" radius="var(--cinder-radius-lg)" />
      </div>
      <div class="chat-availability-reply">
        <Skeleton height="0.75rem" width="85%" />
        <Skeleton height="0.75rem" width="70%" />
        <Skeleton height="0.75rem" width="50%" />
      </div>
      <div class="chat-availability-user">
        <Skeleton height="2.25rem" width="min(12rem, 50%)" radius="var(--cinder-radius-lg)" />
      </div>
    </div>
    <div class="chat-availability-status" dir="auto">
      {#if slow}
        <!-- The slow read is one notice: the spinner as its icon, the elapsed time in the
             sentence, and Cancel as the inline action. -->
        <Callout
          class="chat-availability-notice"
          semantic="note"
          actionLayout="inline"
          aria-label={labels.slow}
          {...availability.onCancel === undefined ? {} : { action: cancelButton }}
        >
          {#snippet icon()}
            <Spinner size="sm" label={labels.slow} class="chat-availability-spinner" />
          {/snippet}
          <span class="chat-availability-reading">{labels.slow}</span>
          <span class="chat-availability-elapsed" data-chat-availability-elapsed>{reading}</span>
        </Callout>
      {:else}
        <span class="chat-availability-reading" aria-hidden="true">{labels.loading}</span>
        {#if elapsed > 0}
          <span class="chat-availability-elapsed" data-chat-availability-elapsed aria-hidden="true">
            {reading}
          </span>
        {/if}
        <span class="cinder-sr-only" role="status">{labels.loading}</span>
      {/if}
    </div>
  </div>
{:else if availability.kind === 'canceled'}
  <div class="chat-availability">
    <ErrorState
      data-chat-availability="canceled"
      tone="neutral"
      headingLevel={2}
      title={labels.canceledTitle}
      description={labels.canceledDescription}
      retryLabel={labels.retry}
      onRetry={availability.onRetry}
      {...allConversations === undefined ? {} : { secondaryAction: allConversationsButton }}
    >
      {#snippet icon()}
        <X class="chat-availability-canceled-icon" aria-hidden="true" />
      {/snippet}
    </ErrorState>
  </div>
{:else if availability.kind === 'error'}
  <div class="chat-availability">
    <ErrorState
      data-chat-availability="error"
      headingLevel={2}
      title={labels.errorTitle}
      description={availability.cause}
      {...availability.detail === undefined ? {} : { detail: availability.detail }}
      retryLabel={labels.tryAgain}
      onRetry={availability.onRetry}
      {...allConversations === undefined ? {} : { secondaryAction: allConversationsButton }}
    />
  </div>
{:else if availability.kind === 'unconfigured'}
  {@const connect = availability.onConnect}
  <div class="chat-availability">
    <EmptyState
      data-chat-availability="unconfigured"
      kind="disabled"
      headingLevel={2}
      title={labels.unconfiguredTitle}
      description={labels.unconfiguredDescription}
    >
      {#snippet action()}
        <Button variant="primary" class="chat-availability-connect" onclick={connect}>
          {labels.connectProvider}
        </Button>
      {/snippet}
    </EmptyState>
  </div>
{:else}
  <div class="chat-availability">
    <ErrorState
      data-chat-availability="deleted"
      tone="neutral"
      headingLevel={2}
      title={labels.deletedTitle}
      description={labels.deletedDescription}
      retryLabel={availability.allConversations.label}
      onRetry={availability.allConversations.onclick}
    >
      {#snippet icon()}
        <Trash2 class="chat-availability-deleted-icon" aria-hidden="true" />
      {/snippet}
      {#snippet retryIcon()}
        <ChevronLeft size={14} aria-hidden="true" />
      {/snippet}
    </ErrorState>
  </div>
{/if}

{#snippet cancelButton()}
  {#if availability.kind === 'loading' && availability.onCancel !== undefined}
    <Button type="button" variant="secondary" size="sm" onclick={availability.onCancel}>
      {labels.cancel}
    </Button>
  {/if}
{/snippet}

{#snippet allConversationsButton()}
  {#if allConversations !== undefined}
    <Button type="button" variant="secondary" onclick={allConversations.onclick}>
      {allConversations.label}
    </Button>
  {/if}
{/snippet}

<style>
  @media (any-pointer: coarse) {
    :global(.chat-availability-connect) {
      min-block-size: var(--cinder-touch-target-min);
      min-inline-size: var(--cinder-touch-target-min);
    }
  }

  .chat-availability {
    display: flex;
    flex: 1;
    flex-direction: column;
    justify-content: center;
    min-block-size: 0;
    box-sizing: border-box;
    inline-size: 100%;
    padding: var(--cinder-chat-timeline-padding, var(--cinder-space-4));
  }

  .chat-availability-loading {
    justify-content: flex-start;
    gap: var(--cinder-space-6);
  }

  .chat-availability-turns {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: var(--cinder-space-6);
    min-block-size: 0;
  }

  .chat-availability-user {
    display: flex;
    justify-content: flex-end;
  }

  .chat-availability-reply {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-2);
  }

  /* The status line sits under the turns and above the composer, where the placeholders end. */
  .chat-availability-status {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--cinder-space-2);
    color: var(--cinder-text-muted);
    font-size: var(--_cinder-chat-text-sm, var(--cinder-text-sm));
  }

  .chat-availability-loading[data-slow] .chat-availability-status {
    display: block;
  }

  .chat-availability-status :global(.cinder-spinner) {
    color: var(--cinder-accent-text);
    --cinder-spinner-size: 1rem;
    --cinder-spinner-indicator: currentColor;
    --cinder-spinner-track: color-mix(in srgb, currentColor 30%, transparent);
  }

  .chat-availability-reading {
    min-inline-size: 0;
  }

  .chat-availability-elapsed {
    font-variant-numeric: tabular-nums;
  }
</style>

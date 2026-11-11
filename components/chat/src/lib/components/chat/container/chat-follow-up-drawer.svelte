<script lang="ts" module>
  import type { QueuedFollowUp } from './chat-follow-up-queue.ts';

  export type ChatFollowUpDrawerProps = {
    /** Prefixes the drawer's element ids. */
    id: string;
    /** The follow-ups waiting, in the order they were typed. */
    items: readonly QueuedFollowUp[];
    /** Whether Send now instead is offered: the run takes live input. */
    canSendNow: boolean;
    /** Called when Send now instead is activated. */
    onsendnow: () => void;
    /** Called with a follow-up's id when its Edit is activated. */
    onedit: (id: string) => void;
    /** Called with a follow-up's id when its remove control is activated. */
    onremove: (id: string) => void;
  };
</script>

<script lang="ts">
  import { Button, X } from '@lostgradient/cinder';
  import {
    FOLLOW_UP_DRAWER_TITLE,
    FOLLOW_UP_SEND_NOW_LABEL,
    followUpPreview,
    followUpQueueSummary,
  } from './chat-follow-up-queue.ts';

  let { id, items, canSendNow, onsendnow, onedit, onremove }: ChatFollowUpDrawerProps = $props();

  const titleId = $derived(`${id}-follow-ups-title`);
</script>

<!-- The Up next drawer above the composer while follow-ups wait for the run. It pushes the
     transcript up and leaves the composer's bottom edge where it was. Each follow-up is a dashed
     ghost of the user message it will become, numbered in the order it will go. -->
<section class="chat-follow-up-drawer" aria-labelledby={titleId} data-chat-follow-up-drawer="">
  <div class="chat-follow-up-drawer-header">
    <p class="chat-follow-up-drawer-heading" id={titleId}>
      <span class="chat-follow-up-drawer-title">{FOLLOW_UP_DRAWER_TITLE}</span>
      <span class="chat-follow-up-drawer-summary">{followUpQueueSummary(items.length)}</span>
    </p>
    {#if canSendNow}
      <Button
        type="button"
        variant="ghost-accent"
        size="sm"
        class="chat-follow-up-drawer-action"
        label={FOLLOW_UP_SEND_NOW_LABEL}
        onclick={onsendnow}
      />
    {/if}
  </div>
  <ol class="chat-follow-up-drawer-list">
    {#each items as item, index (item.id)}
      <li class="chat-follow-up-ghost" data-chat-follow-up={item.id}>
        <span class="chat-follow-up-ghost-index" aria-hidden="true">{index + 1}</span>
        <p class="chat-follow-up-ghost-text" dir="auto">{followUpPreview(item)}</p>
        <div class="chat-follow-up-ghost-actions">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            class="chat-follow-up-ghost-action"
            label="Edit"
            aria-label={`Edit queued follow-up ${index + 1}`}
            onclick={() => onedit(item.id)}
          />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            class="chat-follow-up-ghost-action"
            aria-label={`Remove queued follow-up ${index + 1}`}
            onclick={() => onremove(item.id)}
          >
            <X class="cinder-icon-xs" aria-hidden="true" />
          </Button>
        </div>
      </li>
    {/each}
  </ol>
</section>

<style>
  .chat-follow-up-drawer {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-1);
    margin-block-end: var(--cinder-space-2);
    font-size: var(--cinder-text-sm);
  }

  .chat-follow-up-drawer-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--cinder-space-2);
    padding-inline-start: var(--cinder-space-2);
  }

  /* The title and the summary are their own elements, never joined by a separator glyph. */
  .chat-follow-up-drawer-heading {
    line-height: var(--cinder-leading-tight);
    min-inline-size: 0;
    margin: 0;
    text-align: start;
  }

  .chat-follow-up-drawer-title {
    color: var(--cinder-text-default);
    font-weight: var(--cinder-font-medium);
  }

  .chat-follow-up-drawer-summary {
    margin-inline-start: var(--cinder-space-1);
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-xs);
  }

  .chat-follow-up-drawer :global(.chat-follow-up-drawer-action) {
    flex: none;
  }

  /* Many follow-ups scroll inside the drawer, so the composer is never pushed off the pane. */
  .chat-follow-up-drawer-list {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-1);
    max-block-size: 12rem;
    margin: 0;
    padding: 0;
    overflow-y: auto;
    list-style: none;
  }

  .chat-follow-up-ghost {
    display: flex;
    align-items: center;
    gap: var(--cinder-space-2);
    min-inline-size: 0;
    padding-inline-start: var(--cinder-space-2);
    border: 1px dashed var(--cinder-border-control);
    border-radius: var(--cinder-radius-md);
    color: var(--cinder-text-muted);
  }

  .chat-follow-up-ghost-index {
    flex: none;
    min-inline-size: 1rem;
    color: var(--cinder-text-subtle);
    font-variant-numeric: tabular-nums;
    text-align: center;
  }

  .chat-follow-up-ghost-text {
    flex: 1 1 auto;
    min-inline-size: 0;
    margin: 0;
    overflow: hidden;
    text-align: start;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .chat-follow-up-ghost-actions {
    display: flex;
    flex: none;
    align-items: center;
  }

  /* Coarse pointers get targets of at least 44 px. */
  @media (any-pointer: coarse) {
    .chat-follow-up-drawer :global(.chat-follow-up-drawer-action),
    .chat-follow-up-drawer :global(.chat-follow-up-ghost-action) {
      min-block-size: var(--cinder-touch-target-min);
      min-inline-size: var(--cinder-touch-target-min);
    }
  }
</style>

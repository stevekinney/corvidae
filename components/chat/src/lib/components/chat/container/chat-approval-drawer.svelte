<script lang="ts" module>
  import type { Snippet } from 'svelte';

  export type ChatApprovalDrawerProps = {
    /** Called when Review approval is activated: take the person to the approval that waits. */
    onreview: () => void;
    /** Transcript navigation shares the action row when present. */
    navigation?: Snippet;
  };
</script>

<script lang="ts">
  import { ArrowUp, Button, Info } from '@lostgradient/cinder';
  import { APPROVAL_DRAWER_ACTION, APPROVAL_DRAWER_TEXT } from './chat-approval-review.ts';

  let { onreview, navigation }: ChatApprovalDrawerProps = $props();
</script>

<!-- An information drawer above the composer while an approval waits. It pushes the transcript up
     and leaves the composer's bottom edge where it was. -->
<div
  class="chat-approval-drawer"
  role="group"
  aria-label="Approval waiting"
  data-chat-approval-drawer
>
  <Info class="chat-approval-drawer-glyph cinder-icon-sm" aria-hidden="true" />
  <p class="chat-approval-drawer-text" dir="auto">{APPROVAL_DRAWER_TEXT}</p>
  <div class="chat-approval-drawer-actions">
    <Button
      type="button"
      variant="secondary"
      size="sm"
      class="chat-approval-drawer-action"
      label={APPROVAL_DRAWER_ACTION}
      onclick={onreview}
    >
      {#snippet leadingIcon()}<ArrowUp class="cinder-icon-xs" aria-hidden="true" />{/snippet}
    </Button>
    {@render navigation?.()}
  </div>
</div>

<style>
  .chat-approval-drawer {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--cinder-space-2) var(--cinder-space-3);
    margin-block: var(--cinder-space-3);
    padding: var(--cinder-space-2) var(--cinder-space-3);
    border: 1px solid var(--cinder-status-info-border);
    border-radius: var(--cinder-radius-lg);
    background: var(--cinder-status-info-background);
    color: var(--cinder-status-info-text);
    font-size: var(--cinder-text-sm);
  }

  .chat-approval-drawer :global(.chat-approval-drawer-glyph) {
    flex: none;
  }

  .chat-approval-drawer-text {
    flex: 1 1 14rem;
    min-inline-size: 0;
    margin: 0;
    line-height: var(--cinder-leading-snug);
    text-align: start;
  }

  .chat-approval-drawer-actions {
    display: flex;
    align-items: center;
    gap: var(--cinder-space-2);
  }

  @container (max-width: 480px) {
    .chat-approval-drawer-actions {
      inline-size: 100%;
      justify-content: space-between;
    }
  }

  /* Coarse pointers get a target of at least 44 px. */
  @media (any-pointer: coarse) {
    .chat-approval-drawer :global(.chat-approval-drawer-glyph) {
      display: none;
    }

    .chat-approval-drawer :global(.chat-approval-drawer-action) {
      min-block-size: var(--cinder-touch-target-min);
      padding-inline: var(--cinder-space-3);
    }
  }
</style>

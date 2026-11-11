<script lang="ts" module>
  export type ChatApprovalDrawerProps = {
    /** Called when Review approval is activated: take the person to the approval that waits. */
    onreview: () => void;
  };
</script>

<script lang="ts">
  import { Button, Info } from '@lostgradient/cinder';
  import { APPROVAL_DRAWER_ACTION, APPROVAL_DRAWER_TEXT } from './chat-approval-review.ts';

  let { onreview }: ChatApprovalDrawerProps = $props();
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
  <Button
    type="button"
    variant="secondary"
    size="sm"
    class="chat-approval-drawer-action"
    label={APPROVAL_DRAWER_ACTION}
    onclick={onreview}
  />
</div>

<style>
  .chat-approval-drawer {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--cinder-space-2) var(--cinder-space-3);
    margin-block-end: var(--cinder-space-2);
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

  /* Coarse pointers get a target of at least 44 px. */
  @media (pointer: coarse) {
    .chat-approval-drawer :global(.chat-approval-drawer-action) {
      min-block-size: var(--cinder-touch-target-min);
    }
  }
</style>

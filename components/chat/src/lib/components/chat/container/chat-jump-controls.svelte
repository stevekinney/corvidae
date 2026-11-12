<script lang="ts" module>
  /**
   * Jump-to-latest button and new message indicator for the chat container.
   *
   * Displays:
   * - A jump button when scrolled far enough from bottom
   * - A centered "new messages" indicator in the hysteresis zone
   */
  export type ChatJumpControlsProps = {
    /** Whether the jump button should be visible */
    showJumpButton: boolean;
    /** Whether the new message indicator should be visible */
    hasNewMessageIndicator: boolean;
    /** Current unread message count */
    unreadCount: number;
    /** Formatted unread count for display (caps at "99+") */
    displayUnreadCount: string;
    /** Whether the count exceeds 99 (for compact badge styling) */
    hasLargeCount: boolean;
    /** Host-resolved accessible and visible jump labels. */
    labels: Pick<ChatLabels, 'jumpToLatest' | 'jumpToNewMessages' | 'newMessages'>;
    /** Places the control alongside the approval drawer's action. */
    inline?: boolean;
    /** Callback when jump-to-latest is clicked */
    onJumpToLatest?: () => void;
  };
</script>

<script lang="ts">
  import { ChevronDown } from '@lostgradient/cinder';
  import type { ChatLabels } from '../chat-labels.ts';

  let {
    showJumpButton,
    hasNewMessageIndicator,
    unreadCount,
    displayUnreadCount,
    hasLargeCount,
    labels,
    inline = false,
    onJumpToLatest,
  }: ChatJumpControlsProps = $props();

  function handleJump(): void {
    onJumpToLatest?.();
  }
</script>

{#if showJumpButton || hasNewMessageIndicator}
  <div
    class="chat-jump-dock"
    data-jump-latest={showJumpButton || undefined}
    data-inline={inline || undefined}
  >
    {#if showJumpButton}
      <button
        type="button"
        class="chat-jump-button"
        onclick={handleJump}
        aria-label={unreadCount > 0 ? labels.jumpToNewMessages(unreadCount) : labels.jumpToLatest}
      >
        <ChevronDown class="cinder-icon-sm" />
        {#if unreadCount > 0}
          <span class="chat-jump-badge" data-large={hasLargeCount || undefined}>
            {displayUnreadCount}
          </span>
        {/if}
      </button>
    {:else}
      <button
        type="button"
        class="chat-new-indicator"
        onclick={handleJump}
        aria-label={labels.newMessages(unreadCount)}
      >
        <ChevronDown class="cinder-icon-xs" />
        <span aria-hidden="true">{labels.newMessages(unreadCount)}</span>
      </button>
    {/if}
  </div>
{/if}

<style>
  /* The controls float over the transcript's bottom edge, above the composer, and take no height
   * of their own: no band is reserved, so no line of the transcript is ever sliced by one. */
  .chat-jump-dock {
    position: absolute;
    inset-block-end: calc(100% + var(--cinder-space-2));
    inset-inline: 0;
    z-index: 1;
    display: flex;
    justify-content: center;
    pointer-events: none;
  }

  .chat-jump-dock > * {
    pointer-events: auto;
  }

  .chat-jump-dock[data-jump-latest] {
    justify-content: end;
  }

  .chat-jump-dock[data-inline] {
    position: static;
    padding-inline: 0;
  }

  .chat-jump-dock[data-inline] .chat-jump-button {
    box-shadow: none;
  }

  .chat-jump-dock[data-inline] .chat-jump-button:focus-visible {
    box-shadow: var(--_cinder-focus-ring-shadow);
  }

  /* Jump to Latest Button: painted 32 px; the hit area reaches 44 px (WCAG 2.2 AA) through an
   * invisible ::before, so it never changes the layout. */
  .chat-jump-button {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 2rem;
    height: 2rem;
    padding: 0;
    /* --cinder-surface-raised does not exist in tokens; use --cinder-surface and
     * lean on the shadow + border for elevation against the inset chat timeline. */
    background: transparent;
    border: 1px solid var(--cinder-border-control);
    border-radius: var(--cinder-radius-full);
    box-shadow: var(--cinder-shadow-md);
    color: var(--cinder-text-default);
    cursor: pointer;
    transition:
      background var(--cinder-duration-fast) var(--cinder-ease-standard),
      box-shadow var(--cinder-duration-fast) var(--cinder-ease-standard),
      opacity var(--cinder-duration-fast) var(--cinder-ease-standard),
      transform var(--cinder-duration-fast) var(--cinder-ease-standard);
    animation: jump-button-enter var(--cinder-duration-base) var(--cinder-ease-decelerate);
  }

  .chat-jump-button::before {
    content: '';
    position: absolute;
    /* An absolute box insets from the padding edge, inside the 1px border, so the border is
     * added back: the area is 44 px, centred on the painted 32 px. */
    inset: calc((2rem - var(--cinder-touch-target-min)) / 2 - 1px);
  }

  .chat-jump-button > :global(svg) {
    display: block;
    color: var(--cinder-text-default);
    opacity: 1;
  }

  @keyframes jump-button-enter {
    from {
      opacity: 0;
      transform: scale(0.8);
    }
    to {
      opacity: 1;
      transform: scale(1) translateY(0);
    }
  }

  @media (hover: hover) {
    .chat-jump-button:hover {
      background: var(--cinder-surface-hover);
      box-shadow: var(--cinder-shadow-lg);
    }
  }

  .chat-jump-button:focus-visible {
    outline: var(--cinder-ring-width) solid transparent;
    box-shadow: var(--_cinder-focus-ring-shadow);
  }

  /* Unread Count Badge */
  .chat-jump-badge {
    position: absolute;
    top: calc(-1 * var(--cinder-space-1));
    right: calc(-1 * var(--cinder-space-1));
    display: flex;
    align-items: center;
    justify-content: center;
    min-width: 1.25rem;
    height: 1.25rem;
    padding: 0 var(--cinder-space-1);
    font-size: var(--_cinder-chat-text-3xs, var(--cinder-text-2xs));
    font-weight: var(--cinder-font-semibold);
    background: var(--cinder-accent-solid);
    color: var(--cinder-accent-contrast);
    border-radius: var(--cinder-radius-full);
  }

  .chat-jump-badge[data-large] {
    font-size: var(--_cinder-chat-text-4xs, var(--cinder-text-2xs));
    padding: 0 var(--cinder-space-0-5);
  }

  /* New Message Indicator (centered)
   * Uses min-height for WCAG 2.2 AA touch target compliance */
  .chat-new-indicator {
    display: inline-flex;
    align-items: center;
    gap: var(--cinder-space-1);
    min-height: var(--cinder-touch-target-min);
    padding: var(--cinder-space-1-5) var(--cinder-space-3);
    background: var(--cinder-accent-solid);
    color: var(--cinder-accent-contrast);
    font-size: var(--_cinder-chat-text-xs, var(--cinder-text-xs));
    font-weight: var(--cinder-font-medium);
    border: none;
    border-radius: var(--cinder-radius-full);
    box-shadow: var(--cinder-shadow-lg);
    cursor: pointer;
    animation: slide-up var(--cinder-duration-base) var(--cinder-ease-decelerate);
  }

  .chat-new-indicator:hover {
    filter: brightness(0.95);
  }

  .chat-new-indicator:focus-visible {
    outline: var(--cinder-ring-width) solid transparent;
    /* The indicator is a solid accent fill: gap, then ring (COR-1498). */
    box-shadow: var(--_cinder-focus-ring-filled-shadow), var(--cinder-shadow-lg);
  }

  @media (forced-colors: active) {
    .chat-jump-button:focus-visible,
    .chat-new-indicator:focus-visible {
      outline: var(--cinder-ring-width) solid ButtonText;
      outline-offset: 3px;
    }
  }

  @keyframes slide-up {
    from {
      opacity: 0;
      transform: translateY(25%);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .chat-jump-button {
      animation: none;
    }

    .chat-new-indicator {
      animation: none;
    }
  }
</style>

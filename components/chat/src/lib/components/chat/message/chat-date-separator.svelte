<script lang="ts" module>
  import type { HTMLAttributes } from 'svelte/elements';
  import type { ChatLabels } from '../chat-labels.ts';

  export type ChatDateSeparatorProps = Omit<HTMLAttributes<HTMLDivElement>, 'class'> & {
    /** The date to display */
    date: Date | string;
    /** Custom date formatter for testing/localization */
    dateFormatter?: (date: Date) => string;
    /** Additional CSS class */
    class?: string;
    labels?: Partial<ChatLabels> | undefined;
  };
</script>

<script lang="ts">
  import { classNames } from '../../../utilities/class-names.ts';
  import { resolveChatLabels } from '../chat-labels.ts';

  let {
    date,
    dateFormatter,
    labels: labelOverrides,
    class: className,
    ...rest
  }: ChatDateSeparatorProps = $props();
  const labels = $derived(resolveChatLabels(labelOverrides));

  // Normalize date to Date object
  const dateObj = $derived(typeof date === 'string' ? new Date(date) : date);

  // Check if the date is valid
  const isValidDate = $derived(!isNaN(dateObj.getTime()));

  // Format the date for display
  const formattedDate = $derived.by(() => {
    if (!isValidDate) {
      return labels.invalidDate;
    }

    if (dateFormatter) {
      return dateFormatter(dateObj);
    }

    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    // Use date arithmetic instead of ms subtraction to handle DST transitions correctly
    const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    const dateOnly = new Date(dateObj.getFullYear(), dateObj.getMonth(), dateObj.getDate());

    if (dateOnly.getTime() === today.getTime()) {
      return labels.today;
    }

    if (dateOnly.getTime() === yesterday.getTime()) {
      return labels.yesterday;
    }

    // Use Intl for other dates
    return new Intl.DateTimeFormat(undefined, {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
    }).format(dateObj);
  });

  // ISO date for machine readability (fallback to empty string for invalid dates)
  const isoDate = $derived(isValidDate ? dateObj.toISOString().split('T')[0] : '');
</script>

<div
  class={classNames('chat-date-separator', className)}
  role="separator"
  aria-label={labels.messagesFrom(formattedDate)}
  {...rest}
>
  <span class="chat-date-separator-line" aria-hidden="true"></span>
  {#if isValidDate}
    <time class="chat-date-separator-text" datetime={isoDate}>
      {formattedDate}
    </time>
  {:else}
    <span class="chat-date-separator-text">
      {formattedDate}
    </span>
  {/if}
  <span class="chat-date-separator-line" aria-hidden="true"></span>
</div>

<style>
  .chat-date-separator {
    display: flex;
    align-items: center;
    gap: var(--cinder-space-3);
    padding: var(--cinder-space-4) 0;

    /* Performance: Skip rendering for off-screen separators in long conversations */
    content-visibility: auto;
    contain-intrinsic-size: auto 48px;
  }

  /* Virtual rows already bind mounted content to the visible window, so
   * separators must contribute their real height to row measurement. */
  :global(.chat-virtual-row) .chat-date-separator {
    content-visibility: visible;
  }

  .chat-date-separator-line {
    flex: 1;
    height: 1px;
    background: var(--cinder-border-muted);
  }

  /* The day reads as a sentence-case word ("Today"), muted, with no capitals or letter spacing. */
  .chat-date-separator-text {
    font-size: var(--_cinder-chat-text-xs, var(--cinder-text-xs));
    font-weight: var(--cinder-font-medium);
    color: var(--cinder-text-muted);
    white-space: nowrap;
  }
</style>

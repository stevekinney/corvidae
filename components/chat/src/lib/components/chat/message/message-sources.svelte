<script lang="ts" module>
  import type { CitationSource } from '@lostgradient/cinder';
  import type { ChatLabels } from '../chat-labels.ts';

  export type MessageSourcesProps = {
    /** The sources behind the assistant message, in the order the host supplied them. Never empty. */
    sources: readonly CitationSource[];
    /**
     * Whether the sources are open in place under the control. Wide layouts show them there; on a
     * phone the same list opens as Cinder's bottom sheet and this is not used.
     */
    expanded?: boolean | undefined;
    /** Called when the person opens or closes the sources in place. */
    ontoggle?: (() => void) | undefined;
    /** Called after the phone sheet has fully closed. */
    onCitationCloseComplete?: (() => void) | undefined;
    labels?: Partial<ChatLabels> | undefined;
  };
</script>

<script lang="ts">
  import { ChevronDown, Citation } from '@lostgradient/cinder';
  import { resolveChatLabels } from '../chat-labels.ts';

  let {
    sources,
    expanded = false,
    ontoggle,
    onCitationCloseComplete,
    labels: labelOverrides,
  }: MessageSourcesProps = $props();
  const labels = $derived(resolveChatLabels(labelOverrides));
  const countText = $derived(labels.sourcesCount(sources.length));
</script>

<!--
  The one Sources control of a message: its count and the word, in the small muted text of the
  time beside it, with a chevron. Cinder's Citation owns the list, its URL policy and its focus:
  under the control on a wide layout, in the bottom sheet on a phone, Escape or a click outside
  closing the sheet and returning focus to this control. Nothing here fetches a source.
-->
<Citation
  {sources}
  label={labels.sources}
  markerLabel={countText}
  labels={{ noLink: labels.internalDocument, unsafeLink: labels.unsafeLink }}
  inPlace
  {expanded}
  onExpandedChange={() => ontoggle?.()}
  closeOnSourceRemoval
  onCloseComplete={onCitationCloseComplete}
  class="chat-message-sources-citation"
  data-chat-sources-trigger
>
  <span class="chat-message-sources-text" dir="auto">{countText}</span>
  <ChevronDown class="chat-message-sources-chevron" aria-hidden="true" />
</Citation>

<style>
  /* The control is part of the message line, not a block of its own: its root takes no box, so the
     button is a flex item of the line (at its trailing end) and the opened list, which follows it,
     is a full-width item that wraps to the line below. */
  :global(.chat-message-sources-citation) {
    display: contents;
  }

  :global(.chat-message-sources-citation .cinder-citation__marker) {
    min-block-size: 1.5rem;
    margin-inline-start: auto;
    color: var(--cinder-text-muted);
    font-size: inherit;
    font-weight: var(--cinder-font-normal);
    line-height: inherit;
  }

  :global(.chat-message-sources-citation .cinder-citation__marker:hover) {
    color: var(--cinder-text-default);
    text-decoration: underline;
  }

  .chat-message-sources-text {
    font-variant-numeric: tabular-nums;
  }

  /* The chevron is the size of the 12px text beside it, so it is never taller than its line. */
  :global(.chat-message-sources-citation .chat-message-sources-chevron) {
    inline-size: 0.75rem;
    block-size: 0.75rem;
    flex: none;
    transition: transform var(--cinder-duration-fast) var(--cinder-ease-standard);
  }

  :global(
    .chat-message-sources-citation
      .cinder-citation__marker[aria-expanded='true']
      .chat-message-sources-chevron
  ) {
    transform: rotate(180deg);
  }

  /* The opened list is a row of its own under the time and the actions, as wide as the message. */
  :global(.chat-message-sources-citation .cinder-citation__panel) {
    flex: 1 0 100%;
    min-inline-size: 0;
    color: var(--cinder-text-default);
    font-size: var(--_cinder-chat-text-sm, var(--cinder-text-sm));
  }

  @media (prefers-reduced-motion: reduce) {
    :global(.chat-message-sources-citation .chat-message-sources-chevron) {
      transition: none;
    }
  }
</style>

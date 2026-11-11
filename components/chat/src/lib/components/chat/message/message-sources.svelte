<script lang="ts" module>
  import type { CitationSource } from '@lostgradient/cinder';

  export type MessageSourcesProps = {
    /** The sources behind the assistant message, in the order the host supplied them. Never empty. */
    sources: readonly CitationSource[];
  };
</script>

<script lang="ts">
  import { Citation } from '@lostgradient/cinder';

  let { sources }: MessageSourcesProps = $props();
</script>

<!--
  The Sources control under an assistant message. Cinder's Citation owns the panel, its URL policy
  (only a safe web address becomes a link) and its focus: Escape or a click outside closes it and
  returns focus to this control. Nothing here fetches a source.
-->
<Citation {sources} label="Sources" class="chat-message-sources-citation"
  >Sources <span class="chat-message-sources-count">{sources.length}</span></Citation
>

<style>
  :global(.chat-message-sources-citation .cinder-citation__marker) {
    display: inline-flex;
    align-items: center;
    gap: var(--cinder-space-1);
    min-height: var(--cinder-touch-target-min);
    padding: var(--cinder-space-0-5) var(--cinder-space-1);
    font-size: var(--_cinder-chat-text-xs, var(--cinder-text-xs));
    font-weight: var(--cinder-font-medium);
  }

  .chat-message-sources-count {
    font-variant-numeric: tabular-nums;
    color: var(--cinder-text-muted);
  }
</style>

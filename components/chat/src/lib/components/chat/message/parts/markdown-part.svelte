<script lang="ts" module>
  import type { MarkdownMessagePart } from '../../utilities/types.ts';
  import type { MarkdownNodeOverride } from '../chat-message-parts.ts';

  export type MarkdownPartProps = {
    /** The markdown render part to display. */
    part: MarkdownMessagePart;
    markdownNode?: MarkdownNodeOverride | undefined;
    /** The owning message id when this text can be quoted; marks the rendered content. */
    quoteSource?: string | undefined;
  };
</script>

<script lang="ts">
  import MessageContent from '../message-content.svelte';

  let { part, markdownNode, quoteSource }: MarkdownPartProps = $props();
</script>

<!--
  The body text of a message, rendered through the markdown pipeline. `content`
  is already the effective text (streaming override resolved in by
  `deriveMessageParts`), so this part forwards it straight to MessageContent —
  no `overrideContent` plumbing leaks into the part layer. Streaming and
  expanded are presentation hints carried on the part.
-->
<MessageContent
  content={part.content}
  streaming={part.streaming}
  expanded={part.expanded}
  {markdownNode}
  data-quote-source={quoteSource}
/>

<script lang="ts" module>
  import type { MarkdownMessagePart } from '../../utilities/types.ts';
  import type { MarkdownNodeOverride } from '@lostgradient/cinder';
  import type { ChatCitationClaim } from '../../chat.types.ts';
  import type { ChatLabels } from '../../chat-labels.ts';

  export type MarkdownPartProps = {
    /** The markdown render part to display. */
    part: MarkdownMessagePart;
    markdownNode?: MarkdownNodeOverride | undefined;
    claimSources?: readonly ChatCitationClaim[] | undefined;
    labels?: Partial<ChatLabels> | undefined;
  };
</script>

<script lang="ts">
  import { Citation } from '@lostgradient/cinder';
  import { resolveChatLabels } from '../../chat-labels.ts';
  import MessageContent from '../message-content.svelte';

  let { part, markdownNode, claimSources, labels }: MarkdownPartProps = $props();
  const copy = $derived(resolveChatLabels(labels));
</script>

<!--
  The body text of a message, rendered through the markdown pipeline. `content`
  is already the effective text (streaming override resolved in by
  `deriveMessageParts`), so this part forwards it straight to MessageContent —
  no `overrideContent` plumbing leaks into the part layer. Streaming and
  expanded are presentation hints carried on the part.
-->
{#if claimSources === undefined}
  <MessageContent
    content={part.content}
    streaming={part.streaming}
    expanded={part.expanded}
    {markdownNode}
  />
{:else}
  {#each claimSources as claim (claim.id)}
    <div class="chat-markdown-claim" data-chat-cited-claim={claim.id}>
      <MessageContent content={claim.markdown} class="chat-markdown-claim-content" {markdownNode} />
      {#if claim.sources.length > 0}
        {@const markerSource = claim.sources[0]!}
        <Citation
          sources={claim.sources}
          label={copy.sources}
          markerLabel={markerSource.label}
          labels={{ noLink: copy.internalDocument, unsafeLink: copy.unsafeLink }}
          closeOnSourceRemoval
        >
          <span class="chat-claim-marker" title={markerSource.label}>
            {markerSource.label}
          </span>
        </Citation>
      {/if}
    </div>
  {/each}
{/if}

<style>
  .chat-markdown-claim + .chat-markdown-claim {
    margin-block-start: var(--cinder-space-2);
  }

  .chat-markdown-claim :global(.chat-markdown-claim-content),
  .chat-markdown-claim :global(.chat-markdown-claim-content > .cinder-markdown) {
    display: contents;
  }

  .chat-markdown-claim :global(.chat-markdown-claim-content > .cinder-markdown > p:last-child) {
    display: inline;
  }

  .chat-claim-marker::before {
    content: '[';
  }

  .chat-claim-marker::after {
    content: ']';
  }

  .chat-claim-marker {
    display: inline-block;
    max-inline-size: 12ch;
    overflow: hidden;
    text-overflow: ellipsis;
    vertical-align: bottom;
    white-space: nowrap;
  }

  /* Citation keeps its compact painted line and owns a 44px coarse-pointer target. Reserve the
   * lower overhang before the message actions, so the target never falls through to Details. */
  @media (any-pointer: coarse) {
    .chat-markdown-claim:has(.chat-claim-marker) {
      padding-block-end: calc((var(--cinder-touch-target-min) - 1lh) / 2);
    }
  }
</style>

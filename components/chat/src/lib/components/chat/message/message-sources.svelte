<script lang="ts" module>
  import type { CitationSource } from '@lostgradient/cinder';

  export type MessageSourcesProps = {
    /** The sources behind the assistant message, in the order the host supplied them. Never empty. */
    sources: readonly CitationSource[];
    /**
     * `'compact'` opens the sources in Cinder's Citation panel; `'list'` is a disclosure that shows
     * them inline under the message. Default `'compact'`.
     */
    presentation?: 'compact' | 'list' | undefined;
    /** With `presentation="list"`, whether the list is open. */
    expanded?: boolean | undefined;
    /** With `presentation="list"`, called when the person opens or closes the list. */
    ontoggle?: (() => void) | undefined;
    /** With `presentation="list"`, the id of the list, which its control names in `aria-controls`. */
    listId: string;
  };
</script>

<script lang="ts">
  import { ChevronRight, Citation, resolveCitationLink } from '@lostgradient/cinder';

  let {
    sources,
    presentation = 'compact',
    expanded = false,
    ontoggle,
    listId,
  }: MessageSourcesProps = $props();
</script>

<!--
  The Sources control under an assistant message. Compact: Cinder's Citation owns the panel, its URL
  policy (only a safe web address becomes a link) and its focus: Escape or a click outside closes
  it and returns focus to this control. List: a disclosure that shows every source inline, through
  the same URL policy. Nothing here fetches a source.
-->
{#if presentation === 'list'}
  <button
    type="button"
    class="chat-message-sources-toggle"
    aria-expanded={expanded}
    aria-controls={listId}
    aria-label={`Sources (${sources.length})`}
    onclick={() => ontoggle?.()}
  >
    <ChevronRight class="chat-message-sources-chevron" aria-hidden="true" />
    Sources <span class="chat-message-sources-count">{sources.length}</span>
  </button>
  {#if expanded}
    <ol id={listId} class="chat-message-sources-list" aria-label="Sources">
      {#each sources as source, index (index)}
        {@const link = resolveCitationLink(source.url)}
        <li class="chat-message-sources-item">
          <strong class="chat-message-sources-title" dir="auto">{source.label}</strong>
          {#if source.detail}
            <p class="chat-message-sources-detail" dir="auto">{source.detail}</p>
          {/if}
          {#if link.kind === 'link'}
            <a class="chat-message-sources-link" href={link.href}
              >{link.host === undefined ? 'Open source' : `Open ${link.host}`}<span
                aria-hidden="true"
              >
                ↗</span
              ></a
            >
          {:else if link.kind === 'none'}
            <span class="chat-message-sources-note">Internal document, no public link</span>
          {:else}
            <span class="chat-message-sources-note" data-link="rejected"
              >Link hidden: the address isn't a safe web link</span
            >
          {/if}
        </li>
      {/each}
    </ol>
  {/if}
{:else}
  <Citation {sources} label="Sources" class="chat-message-sources-citation"
    >Sources <span class="chat-message-sources-count">{sources.length}</span></Citation
  >
{/if}

<style>
  :global(.chat-message-sources-citation .cinder-citation__marker),
  .chat-message-sources-toggle {
    display: inline-flex;
    align-items: center;
    gap: var(--cinder-space-1);
    min-height: var(--cinder-touch-target-min);
    padding: var(--cinder-space-0-5) var(--cinder-space-1);
    font-size: var(--_cinder-chat-text-xs, var(--cinder-text-xs));
    font-weight: var(--cinder-font-medium);
  }

  .chat-message-sources-toggle {
    color: var(--cinder-accent-text);
    background: transparent;
    border: none;
    cursor: pointer;
    font-family: inherit;
  }

  .chat-message-sources-toggle:hover {
    text-decoration: underline;
  }

  .chat-message-sources-toggle:focus-visible {
    outline: var(--cinder-ring-width) solid transparent;
    box-shadow: var(--_cinder-focus-ring-shadow);
  }

  .chat-message-sources-toggle :global(.chat-message-sources-chevron) {
    inline-size: 12px;
    block-size: 12px;
    flex: none;
    transition: transform 120ms ease;
  }

  .chat-message-sources-toggle[aria-expanded='true'] :global(.chat-message-sources-chevron) {
    transform: rotate(90deg);
  }

  .chat-message-sources-count {
    font-variant-numeric: tabular-nums;
    color: var(--cinder-text-muted);
  }

  /* Flat rows: each source is its title, its quoted excerpt and its link, with no box around it.
     Long strings wrap inside the message rather than scrolling it sideways. */
  .chat-message-sources-list {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-3);
    margin: 0;
    padding-block: var(--cinder-space-1);
    padding-inline: var(--cinder-space-2) 0;
    list-style: none;
    min-width: 0;
    max-width: 100%;
    overflow-wrap: anywhere;
    text-align: start;
    font-size: var(--_cinder-chat-text-sm, var(--cinder-text-sm));
    line-height: var(--cinder-leading-normal);
  }

  .chat-message-sources-item {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-1);
    min-width: 0;
  }

  .chat-message-sources-title {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow: hidden;
    font-weight: var(--cinder-font-semibold);
    color: var(--cinder-text-default);
  }

  .chat-message-sources-detail {
    margin: 0;
    color: var(--cinder-text-muted);
  }

  .chat-message-sources-detail::before {
    content: open-quote;
  }

  .chat-message-sources-detail::after {
    content: close-quote;
  }

  .chat-message-sources-link {
    align-self: flex-start;
    color: var(--cinder-accent-text);
  }

  .chat-message-sources-note {
    color: var(--cinder-text-muted);
  }

  @media (pointer: coarse) {
    .chat-message-sources-link {
      display: inline-flex;
      align-items: center;
      min-height: var(--cinder-touch-target-min);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .chat-message-sources-toggle :global(.chat-message-sources-chevron) {
      transition: none;
    }
  }
</style>

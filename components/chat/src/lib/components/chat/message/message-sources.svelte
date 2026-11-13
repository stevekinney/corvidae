<script lang="ts" module>
  import type { CitationSource } from '@lostgradient/cinder';
  import type { ChatLabels } from '../chat-labels.ts';

  export type MessageSourcesProps = {
    /** The sources behind the assistant message, in the order the host supplied them. Never empty. */
    sources: readonly CitationSource[];
    /**
     * `'compact'` opens the sources in Cinder's Citation panel; `'list'` is a disclosure that shows
     * them inline under the message; `'inline'` is one chip per source, reading its host or its
     * label, that opens that source in the same panel. Default `'compact'`.
     */
    presentation?: 'compact' | 'list' | 'inline' | undefined;
    /** With `presentation="list"`, whether the list is open. */
    expanded?: boolean | undefined;
    /** With `presentation="list"`, called when the person opens or closes the list. */
    ontoggle?: (() => void) | undefined;
    /** With `presentation="list"`, the id of the list, which its control names in `aria-controls`. */
    listId: string;
    /**
     * Says a sentence to a screen reader through the host's announcer, outside the transcript's
     * log, so it is said once. Without it the sentence goes to a live region of its own.
     */
    announce?: ((message: string) => void) | undefined;
    /** Called after a compact Citation panel or sheet has fully closed. */
    onCitationCloseComplete?: (() => void) | undefined;
    labels?: Partial<ChatLabels> | undefined;
  };
</script>

<script lang="ts">
  import { tick } from 'svelte';
  import { ChevronRight, Citation, resolveCitationLink } from '@lostgradient/cinder';
  import { resolveChatLabels } from '../chat-labels.ts';
  import { sourceChipLabel } from './source-chip-label.ts';

  let {
    sources,
    presentation = 'compact',
    expanded = false,
    ontoggle,
    listId,
    announce,
    onCitationCloseComplete,
    labels: labelOverrides,
  }: MessageSourcesProps = $props();
  const labels = $derived(resolveChatLabels(labelOverrides));

  // Each inline chip is keyed by the source it stands for (its address and label, and which copy
  // of a duplicate it is), so a withdrawn source takes its own chip and open panel with it rather
  // than handing them to the source after it (C#11).
  const chipKeys = $derived.by(() => {
    const seen = new Map<string, number>();
    return sources.map((source) => {
      const identity = `${source.url ?? ''}\u0000${source.label}`;
      const copy = seen.get(identity) ?? 0;
      seen.set(identity, copy + 1);
      return `${identity}\u0000${copy}`;
    });
  });
  const chipEntries = $derived(
    sources.map((source, index) => ({ source, key: chipKeys[index] ?? String(index) })),
  );
  let chipGroup = $state<HTMLElement | null>(null);
  const WITHDRAWN = 'A source was withdrawn.';
  let withdrawal = $state('');
  let shownKeys: readonly string[] = [];

  async function moveFocusAfterWithdrawal(group: HTMLElement, position: number): Promise<void> {
    await tick();
    const remaining = group.querySelectorAll<HTMLElement>('.cinder-citation__marker');
    remaining[Math.min(position, remaining.length - 1)]?.focus();
  }

  // A source withdrawn while its chip has focus or its panel is open: the panel goes with it, focus
  // moves to the chip that takes its place (or the last one), and the change is said once.
  $effect.pre(() => {
    const keys = chipKeys;
    const previous = shownKeys;
    shownKeys = keys;
    const group = chipGroup;
    if (group === null || presentation !== 'inline') return;
    const markers = [...group.querySelectorAll<HTMLElement>('.cinder-citation__marker')];
    const active = group.ownerDocument.activeElement;
    const held = previous.findIndex((key, index) => {
      if (keys.includes(key)) return false;
      const marker = markers[index];
      return marker === active || marker?.getAttribute('aria-expanded') === 'true';
    });
    if (held === -1) return;
    const before = previous.slice(0, held).filter((key) => keys.includes(key)).length;
    if (announce === undefined) withdrawal = WITHDRAWN;
    else announce(WITHDRAWN);
    void moveFocusAfterWithdrawal(group, before);
  });
  let coarsePointer = $state(false);
  $effect(() => {
    const query =
      typeof window === 'undefined' ? undefined : window.matchMedia('(any-pointer: coarse)');
    if (query === undefined) return;
    const update = (): void => {
      coarsePointer = query.matches;
    };
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  });
  const compactInline = $derived(presentation === 'inline' && coarsePointer);
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
    aria-label={labels.sourcesCount(sources.length)}
    onclick={() => ontoggle?.()}
  >
    <ChevronRight class="chat-message-sources-chevron" aria-hidden="true" />
    {labels.sources} <span class="chat-message-sources-count">{sources.length}</span>
  </button>
  {#if expanded}
    <ol id={listId} class="chat-message-sources-list" aria-label={labels.sources}>
      {#each sources as source, index (index)}
        {@const link = resolveCitationLink(source.url)}
        <li class="chat-message-sources-item">
          <strong class="chat-message-sources-title" dir="auto">{source.label}</strong>
          {#if source.detail}
            <p class="chat-message-sources-detail" dir="auto">{source.detail}</p>
          {/if}
          {#if link.kind === 'link'}
            <a class="chat-message-sources-link" href={link.href}
              >{labels.openSource(link.host)}{' '}<span aria-hidden="true">↗</span></a
            >
          {:else if link.kind === 'none'}
            <span class="chat-message-sources-note">{labels.internalDocument}</span>
          {:else}
            <span class="chat-message-sources-note" data-link="rejected">{labels.unsafeLink}</span>
          {/if}
        </li>
      {/each}
    </ol>
  {/if}
{:else if presentation === 'inline' && !compactInline}
  <!-- One chip per source, in the order given and with duplicates kept, as everywhere else. Each
       chip is Citation's own marker, so its panel, URL policy and focus return are unchanged. -->
  <span
    class="chat-message-source-chips"
    role="group"
    aria-label={labels.sources}
    bind:this={chipGroup}
  >
    {#each chipEntries as entry, index (entry.key)}
      {@const source = entry.source}
      {@const chip = sourceChipLabel(source, sources)}
      <Citation
        sources={[source]}
        label={chip}
        class="chat-message-source-chip"
        data-chat-sources-trigger
        data-chat-source-index={index}
        ><span class="chat-message-source-chip-text" dir="auto">{chip}</span></Citation
      >
    {/each}
  </span>
  {#if announce === undefined}
    <span class="cinder-sr-only" aria-live="polite" aria-atomic="true">{withdrawal}</span>
  {/if}
{:else}
  <Citation
    {sources}
    label={labels.sources}
    closeOnSourceRemoval
    onCloseComplete={onCitationCloseComplete}
    class="chat-message-sources-citation"
    data-chat-sources-trigger
    >{labels.sources} <span class="chat-message-sources-count">{sources.length}</span></Citation
  >
{/if}

<style>
  :global(.chat-message-sources-citation .cinder-citation__marker),
  .chat-message-sources-toggle {
    display: inline-flex;
    align-items: center;
    gap: var(--cinder-space-1);
    min-height: 1.5rem;
    padding-block: 0;
    /* The label starts on the prose edge; the hit area extends outward from a pseudo-element. */
    padding-inline: 0;
    font-size: var(--_cinder-chat-text-sm, var(--cinder-text-sm));
    font-weight: var(--cinder-font-medium);
  }

  .chat-message-sources-toggle {
    /* The chevron's 16px box sits inside the 24px control, so its ink is 4px in from the box's
       edge; the box overhangs the prose edge by that inset so the ink meets it. */
    margin-inline-start: calc((1rem - 1.5rem) / 2);
    padding-inline: 0 var(--cinder-space-3);
    color: var(--cinder-text-default);
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
    inline-size: 1rem;
    block-size: 1rem;
    flex: none;
    transition: transform var(--cinder-duration-fast) var(--cinder-ease-standard);
  }

  .chat-message-sources-toggle[aria-expanded='true'] :global(.chat-message-sources-chevron) {
    transform: rotate(90deg);
  }

  /* In a right-to-left message the closed chevron points toward the text, to the left. */
  :global(.chat-message-wrapper[data-message-direction='rtl'])
    .chat-message-sources-toggle[aria-expanded='false']
    :global(.chat-message-sources-chevron) {
    transform: scaleX(-1);
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
    display: inline-flex;
    align-items: center;
    min-block-size: 1.5rem;
    align-self: flex-start;
    color: var(--cinder-accent-text);
  }

  .chat-message-sources-note {
    color: var(--cinder-text-muted);
  }

  @media (any-pointer: coarse) {
    :global(.chat-message-sources-citation .cinder-citation__marker),
    .chat-message-sources-toggle {
      position: relative;
    }

    /* The 44px hit region is invisible and takes no layout, so a message with Sources keeps the
       same distance from its text to the action row as one without. */
    :global(.chat-message-sources-citation .cinder-citation__marker)::after,
    .chat-message-sources-toggle::after {
      content: '';
      position: absolute;
      /* The line below the Sources block has a stacking position of its own (so its actions'
         overhang clears the next message); this extension sits above it, so a tap under the
         toggle reaches the toggle and not the time. Only the invisible area rises: no face. */
      z-index: 2;
      inset-block: calc((100% - var(--cinder-touch-target-min)) / 2);
      inset-inline: calc(var(--cinder-space-3) * -1);
    }
  }

  /* Inline chips: each source is a small rounded marker that sits in the line like a word. The
     chips wrap with the line and a long host is cut with an ellipsis rather than widening the
     message. A chip is a hairline outline with no fill. */
  .chat-message-source-chips {
    display: block;
    min-inline-size: 0;
    max-inline-size: 100%;
    line-height: 1.8;
    text-align: start;
  }

  .chat-message-source-chips :global(.chat-message-source-chip) {
    display: inline;
    margin-inline-end: var(--cinder-space-1);
  }

  .chat-message-source-chips :global(.chat-message-source-chip .cinder-citation__marker) {
    display: inline-block;
    vertical-align: baseline;
    max-inline-size: min(100%, 16rem);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--cinder-accent-text);
    font-size: var(--_cinder-chat-text-xs, var(--cinder-text-xs));
    font-weight: var(--cinder-font-medium);
    line-height: inherit;
  }

  .chat-message-source-chips :global(.chat-message-source-chip .cinder-citation__marker:hover) {
    text-decoration: underline;
  }

  .chat-message-source-chips
    :global(.chat-message-source-chip .cinder-citation__marker:focus-visible) {
    outline: var(--cinder-ring-width) solid transparent;
    box-shadow: var(--_cinder-focus-ring-shadow);
  }

  @media (any-pointer: coarse) {
    .chat-message-source-chips :global(.chat-message-source-chip .cinder-citation__marker) {
      min-block-size: var(--cinder-touch-target-min);
      padding-block: calc((var(--cinder-touch-target-min) - 1lh) / 2);
    }
  }

  .chat-message-sources-link {
    position: relative;
  }

  .chat-message-sources-link::after {
    content: '';
    position: absolute;
    inset-block: min(0px, calc((100% - var(--cinder-touch-target-min)) / 2));
    inset-inline: 0;
  }

  @media (prefers-reduced-motion: reduce) {
    .chat-message-sources-toggle :global(.chat-message-sources-chevron) {
      transition: none;
    }
  }
</style>

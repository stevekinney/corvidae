<script lang="ts" module>
  export type { CitationLabels, CitationProps, CitationSource } from './citation.types.ts';
</script>

<script lang="ts">
  import ExternalLink from '@lucide/svelte/icons/external-link';
  import { tick } from 'svelte';

  import {
    PHONE_VIEWPORT_BREAKPOINT,
    useViewportBelow,
  } from '../../_internal/viewport-below.svelte.ts';
  import { classNames } from '../../utilities/class-names.ts';
  import { default as Popover } from '../popover/index.ts';

  import { resolveCitationLink } from './citation-link.ts';
  import type { CitationProps, CitationSource } from './citation.types.ts';

  let {
    sources = [],
    label = 'Sources',
    labels,
    markerLabel,
    current,
    inPlace = false,
    expanded = $bindable(false),
    onExpandedChange,
    closeOnSourceRemoval = false,
    onCloseComplete,
    children,
    class: customClassName,
    ...rest
  }: CitationProps = $props();
  const instanceId = $props.id();
  const panelId = `cinder-citation-${instanceId}`;
  let open = $state(false);
  let markerElement = $state<HTMLButtonElement | null>(null);
  let panelElement = $state<HTMLElement | null>(null);
  let preserveMarkerForClose = $state(false);
  let previousSourceKeys: string[] | undefined;
  const phone = useViewportBelow(() => PHONE_VIEWPORT_BREAKPOINT);
  // On a phone the sources open in the sheet whatever `inPlace` says; wider, `inPlace` keeps them
  // under the marker instead of in a floating popover.
  const placedHere = $derived(inPlace && !phone.current);
  const markerDisabled = $derived(sources.length === 0 && !preserveMarkerForClose);
  const noLinkText = $derived(labels?.noLink ?? 'Internal document, no public link');
  const unsafeLinkText = $derived(
    labels?.unsafeLink ?? "Link hidden: the address isn't a safe web link",
  );
  const currentIndex = $derived(
    current !== undefined && Number.isInteger(current) && current >= 0 && current < sources.length
      ? current
      : undefined,
  );
  const isOpen = $derived(placedHere ? expanded && sources.length > 0 : open);

  function sourceKey(entry: CitationSource): string {
    return `${entry.url ?? ''}\u0000${entry.label}\u0000${entry.detail ?? ''}`;
  }

  // A row keeps its place in the DOM when an earlier source is withdrawn, so a reader's focus stays
  // on the row it was on: its key is the source's own fields and which copy of a duplicate it is.
  const rowKeys = $derived.by(() => {
    const seen = new Map<string, number>();
    return sources.map((entry) => {
      const identity = sourceKey(entry);
      const copy = seen.get(identity) ?? 0;
      seen.set(identity, copy + 1);
      return `${identity}\u0000${copy}`;
    });
  });

  function toggle(): void {
    if (sources.length === 0) return;
    if (placedHere) {
      expanded = !expanded;
      onExpandedChange?.(expanded);
    } else {
      open = !open;
    }
  }

  $effect(() => {
    const keys = sources.map(sourceKey);
    if (
      closeOnSourceRemoval &&
      previousSourceKeys !== undefined &&
      previousSourceKeys.some((key) => !keys.includes(key))
    ) {
      open = false;
    }
    previousSourceKeys = keys;
    if (sources.length === 0) {
      if (open) {
        preserveMarkerForClose = true;
        open = false;
      }
    } else if (preserveMarkerForClose) {
      preserveMarkerForClose = false;
    }
  });

  // The list opens at the cited source: its row is scrolled into view, so a long list never hides
  // the one the reader followed a marker for.
  $effect(() => {
    const panel = panelElement;
    const index = currentIndex;
    if (panel === null || index === undefined) return;
    void (async () => {
      await tick();
      const row = panel.querySelectorAll<HTMLElement>('.cinder-citation__item')[index];
      if (typeof row?.scrollIntoView === 'function') row.scrollIntoView({ block: 'nearest' });
    })();
  });

  function trackPanel(element: HTMLElement): () => void {
    panelElement = element;
    return () => {
      if (panelElement === element) panelElement = null;
    };
  }
</script>

{#snippet sourceRow(entry: CitationSource)}
  {@const link = resolveCitationLink(entry.url)}
  <strong class="cinder-citation__title" dir="auto">{entry.label}</strong>
  {#if link.kind === 'link'}
    <span class="cinder-citation__domain" dir="auto">{link.host ?? link.href}</span>
  {:else if link.kind === 'none'}
    <span class="cinder-citation__note">{noLinkText}</span>
  {:else}
    <span class="cinder-citation__note" data-cinder-link="rejected">{unsafeLinkText}</span>
  {/if}
  {#if entry.detail}
    <span class="cinder-citation__detail" dir="auto">{entry.detail}</span>
  {/if}
{/snippet}

{#snippet sourceList()}
  <ol class="cinder-citation__list">
    {#each sources as entry, index (rowKeys[index] ?? index)}
      {@const link = resolveCitationLink(entry.url)}
      {@const cited = index === currentIndex}
      <li class="cinder-citation__item" data-cinder-current={cited ? '' : undefined}>
        {#if link.kind === 'link'}
          <a
            class="cinder-citation__row"
            href={link.href}
            aria-current={cited ? 'true' : undefined}
          >
            <span class="cinder-citation__row-text">{@render sourceRow(entry)}</span>
            <ExternalLink class="cinder-citation__glyph" aria-hidden="true" />
          </a>
        {:else}
          <div class="cinder-citation__row" aria-current={cited ? 'true' : undefined}>
            <span class="cinder-citation__row-text">{@render sourceRow(entry)}</span>
          </div>
        {/if}
      </li>
    {/each}
  </ol>
{/snippet}

{#snippet marker()}
  <button
    bind:this={markerElement}
    type="button"
    class="cinder-citation__marker"
    disabled={markerDisabled}
    onclick={toggle}
    aria-expanded={placedHere ? isOpen : undefined}
    aria-controls={placedHere ? panelId : undefined}
    aria-label={sources.length > 0
      ? (markerLabel ?? `${label} (${sources.length})`)
      : `${label} (${labels?.noSources ?? 'no sources'})`}
    >{#if children}{@render children()}{:else}[{sources.length}]{/if}</button
  >
{/snippet}

<span
  class={classNames('cinder-citation', placedHere && 'cinder-citation--in-place', customClassName)}
  {...rest}
  >{#if placedHere}{@render marker()}{#if isOpen}<section
        id={panelId}
        class="cinder-citation__panel"
        aria-label={label}
        {@attach trackPanel}
      >
        {@render sourceList()}
      </section>{/if}{:else}<Popover
      bind:open
      {label}
      triggerRef={markerElement}
      onExitComplete={() => {
        preserveMarkerForClose = false;
        onCloseComplete?.();
      }}
    >
      {#snippet trigger()}{@render marker()}{/snippet}
      <section class="cinder-citation__panel" aria-label={label} {@attach trackPanel}>
        {@render sourceList()}
      </section>
    </Popover>{/if}</span
>

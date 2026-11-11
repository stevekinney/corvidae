<script lang="ts" module>
  /**
   * @cinder
   * @category data-display
   * @status beta
   * @purpose Inline citation marker opening a paginated preview of source references.
   * @tag citation
   * @useWhen Attaching sources to an inline claim or generated answer.
   * @avoidWhen Building a full bibliography page.
   * @related popover
   * @rationale Nearest alternative: Popover — Citation adds source pagination and an inline marker.
   */
  export type { CitationLabels, CitationProps, CitationSource } from './citation.types.ts';

  /** Up to this many sources are listed together; more are paged one at a time. */
  const LIST_LIMIT = 5;
</script>

<script lang="ts">
  import ChevronLeft from '@lucide/svelte/icons/chevron-left';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';

  import { classNames } from '../../utilities/class-names.ts';
  import { default as Popover } from '../popover/index.ts';

  import { resolveCitationLink } from './citation-link.ts';
  import type { CitationProps, CitationSource } from './citation.types.ts';

  let {
    sources = [],
    label = 'Sources',
    labels,
    children,
    class: customClassName,
    ...rest
  }: CitationProps = $props();
  let page = $state(0);
  let open = $state(false);
  let markerElement = $state<HTMLButtonElement | null>(null);
  let preserveMarkerForClose = $state(false);
  const markerDisabled = $derived(sources.length === 0 && !preserveMarkerForClose);
  const source = $derived(sources[page]);
  // Five or fewer sources read as one list; more are paged so the panel stays short.
  const listed = $derived(sources.length <= LIST_LIMIT);
  const noLinkText = $derived(labels?.noLink ?? 'Internal document, no public link');
  const unsafeLinkText = $derived(
    labels?.unsafeLink ?? "Link hidden: the address isn't a safe web link",
  );

  function openText(host: string | undefined): string {
    return labels?.open?.(host) ?? (host === undefined ? 'Open source' : `Open ${host}`);
  }

  $effect(() => {
    if (sources.length === 0) {
      page = 0;
      if (open) {
        preserveMarkerForClose = true;
        open = false;
      }
    } else if (page >= sources.length) {
      page = sources.length - 1;
      preserveMarkerForClose = false;
    } else if (preserveMarkerForClose) {
      preserveMarkerForClose = false;
    }
  });
</script>

{#snippet sourceRows(entry: CitationSource)}
  {@const link = resolveCitationLink(entry.url)}
  <strong class="cinder-citation__title" dir="auto">{entry.label}</strong>{#if entry.detail}<p
      class="cinder-citation__detail"
      dir="auto"
    >
      {entry.detail}
    </p>{/if}{#if link.kind === 'link'}<a class="cinder-citation__link" href={link.href}
      >{openText(link.host)}{' '}<span class="cinder-citation__link-arrow" aria-hidden="true"
        >↗</span
      ></a
    >{:else if link.kind === 'none'}<span class="cinder-citation__note">{noLinkText}</span
    >{:else}<span class="cinder-citation__note" data-cinder-link="rejected">{unsafeLinkText}</span
    >{/if}
{/snippet}

<span class={classNames('cinder-citation', customClassName)} {...rest}
  ><Popover
    bind:open
    {label}
    triggerRef={markerElement}
    onExitComplete={() => {
      preserveMarkerForClose = false;
    }}
  >
    {#snippet trigger()}<button
        bind:this={markerElement}
        type="button"
        class="cinder-citation__marker"
        disabled={markerDisabled}
        onclick={() => {
          if (sources.length > 0) open = !open;
        }}
        aria-label={sources.length > 0
          ? `${label} (${sources.length})`
          : `${label} (${labels?.noSources ?? 'no sources'})`}
        >{#if children}{@render children()}{:else}[{sources.length}]{/if}</button
      >{/snippet}
    <section class="cinder-citation__panel" aria-label={label}>
      {#if listed && sources.length > 1}<ol class="cinder-citation__list">
          {#each sources as entry, index (index)}<li class="cinder-citation__item">
              {@render sourceRows(entry)}
            </li>{/each}
        </ol>{:else if source}{@render sourceRows(source)}{/if}
      {#if !listed}<div class="cinder-citation__pagination">
          <button
            type="button"
            onclick={() => (page = Math.max(0, page - 1))}
            disabled={page === 0}
            aria-label={labels?.previousSource ?? 'Previous source'}
            title={labels?.previous ?? 'Previous'}><ChevronLeft aria-hidden="true" /></button
          ><span aria-live="polite"
            >{labels?.position?.(page + 1, sources.length) ??
              `${page + 1} of ${sources.length}`}</span
          ><button
            type="button"
            onclick={() => (page = Math.min(sources.length - 1, page + 1))}
            disabled={page === sources.length - 1}
            aria-label={labels?.nextSource ?? 'Next source'}
            title={labels?.next ?? 'Next'}><ChevronRight aria-hidden="true" /></button
          >
        </div>{/if}
    </section>
  </Popover></span
>

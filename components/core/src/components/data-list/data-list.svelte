<script lang="ts" module>
  /**
   * @cinder
   * @category data-display
   * @status stable
   * @purpose Semantic list container for like rows: empty state, density, day groups, a shared status column, and announced live insertion.
   * @tag list
   * @tag iterator
   * @useWhen Rendering a vertical list of like records where each row shares the same layout.
   * @useWhen Pairing with StackedListItem rows for leading/title/description/meta/trailing content.
   * @useWhen Showing a dedicated empty state when the collection has no items.
   * @useWhen Grouping rows under day headers, or announcing rows that arrive while the list is on screen.
   * @avoidWhen Presenting key-value metadata for a single entity — use description-list instead.
   * @avoidWhen Rendering tabular data with rows and columns — use table instead.
   * @related stacked-list-item, description-list, table
   */
  export type { DataListGroup, DataListProps } from './data-list.types.ts';
</script>

<script lang="ts" generics="T">
  import { tick } from 'svelte';
  import { setDataListContext } from '../../_internal/data-list-context.ts';
  import { captureScrollAnchor } from '../../_internal/scroll-anchor.ts';
  import { classNames } from '../../utilities/class-names.ts';
  import type { DataListGroup, DataListProps } from './data-list.types.ts';

  let {
    items,
    key,
    density,
    statusColumn,
    groupBy,
    insertionAnnouncement,
    class: className,
    children,
    empty,
    ...rest
  }: DataListProps<T> = $props();

  // Publish the list-level density so StackedListItem rows can inherit it. The
  // getter keeps the read reactive; `density` stays `undefined` when the
  // consumer set none, in which case each row falls back to its own default.
  setDataListContext({
    get density() {
      return density;
    },
    get statusColumn() {
      return statusColumn;
    },
  });

  const generatedId = $props.id();

  type Segment = { id: string; group: DataListGroup | undefined; entries: T[] };

  // Consecutive items with the same group key share one header. A key that comes back after
  // another group starts a new segment, so the ids carry an occurrence count and stay unique.
  const segments = $derived.by((): Segment[] => {
    if (groupBy === undefined) return [{ id: 'all', group: undefined, entries: items }];
    const result: Segment[] = [];
    const occurrences = new Map<string, number>();
    for (const entry of items) {
      const group = groupBy(entry);
      const last = result.at(-1);
      if (last?.group !== undefined && last.group.key === group.key) {
        last.entries.push(entry);
        continue;
      }
      const base = String(group.key);
      const occurrence = (occurrences.get(base) ?? 0) + 1;
      occurrences.set(base, occurrence);
      result.push({ id: `${base}#${occurrence}`, group, entries: [entry] });
    }
    return result;
  });

  let listElement: HTMLUListElement | undefined = $state();

  // Live insertion: announce rows that were not in the previous render, and hold still whatever
  // the reader is looking at. Neither state is reactive on purpose; they only carry the previous
  // render across effect runs.
  let previousKeys: Set<string | number> | undefined;
  let announcementSequence = 0;
  let announcementText = $state('');
  let announcementId = $state(0);
  let restoreScroll: (() => void) | undefined;

  $effect.pre(() => {
    if (insertionAnnouncement === undefined || listElement === undefined) return;
    void items.length;
    void items;
    restoreScroll = captureScrollAnchor(listElement);
  });

  $effect(() => {
    const currentKeys = new Set(items.map((entry) => key(entry)));
    const previous = previousKeys;
    previousKeys = currentKeys;

    const restore = restoreScroll;
    restoreScroll = undefined;

    let added = 0;
    if (previous !== undefined && insertionAnnouncement !== undefined) {
      for (const entryKey of currentKeys) if (!previous.has(entryKey)) added += 1;
    }
    if (added === 0) {
      restore?.();
      return;
    }
    announcementSequence += 1;
    announcementText = insertionAnnouncement?.(added) ?? '';
    announcementId = announcementSequence;
    // The announcement draws a status strip above the first group the first time it appears, so
    // hold the reader's place once that strip is in the page, not before.
    void tick().then(() => restore?.());
  });
</script>

<!--
  role="list" is explicit: a `<ul>` with `list-style: none` loses its list
  semantics in Safari/VoiceOver, so the role is restated. Each child rendered by
  `children(entry)` must be an `<li>` (StackedListItem is the recommended row);
  the empty state is itself wrapped in an `<li>` so the list stays valid HTML.
  With `groupBy`, each group is an `<li>` holding a header and a nested list named
  by that header. The live region, when there is one, is an `<li role="presentation">`
  that takes no space until it announces and is then the status strip, so the list still holds
  only list items.
-->
<ul {...rest} bind:this={listElement} class={classNames('cinder-data-list', className)} role="list">
  {#if insertionAnnouncement !== undefined}
    <li
      class="cinder-data-list-live"
      role="presentation"
      data-announced={announcementText === '' ? undefined : ''}
    >
      <span role="status" aria-live="polite" aria-atomic="true">
        {#key announcementId}{announcementText}{/key}
      </span>
    </li>
  {/if}
  {#if items.length > 0}
    {#each segments as segment (segment.id)}
      {#if segment.group}
        {@const headerId = `${generatedId}-${segment.id}`}
        <li class="cinder-data-list-group">
          <div class="cinder-data-list-group__header" id={headerId}>
            <span class="cinder-data-list-group__label">{segment.group.label}</span>
            {#if segment.group.detail}
              <span class="cinder-data-list-group__detail">{segment.group.detail}</span>
            {/if}
          </div>
          <ul class="cinder-data-list-group__items" role="list" aria-labelledby={headerId}>
            {#each segment.entries as entry (key(entry))}
              {@render children(entry)}
            {/each}
          </ul>
        </li>
      {:else}
        {#each segment.entries as entry (key(entry))}
          {@render children(entry)}
        {/each}
      {/if}
    {/each}
  {:else if empty}
    <li class="cinder-data-list-empty">
      {@render empty()}
    </li>
  {/if}
</ul>

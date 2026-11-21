<script lang="ts" module>
  /**
   * Internal recursive level for JsonDiffViewer: the entries of one object or array. Not part of
   * the public API; consumers import JsonDiffViewer directly.
   */
  export type JsonDiffViewerLevelProps = {
    level: JsonDiffLevel;
  };
</script>

<script lang="ts">
  import Self from './_json-diff-viewer-level.svelte';
  import { formatNumber } from '../../utilities/format-number.ts';
  import {
    JSON_DIFF_PAGE_SIZE,
    type JsonDiffEntry,
    type JsonDiffKind,
    type JsonDiffLevel,
  } from './json-diff-viewer.diff.ts';

  let { level }: JsonDiffViewerLevelProps = $props();

  // How far each list has been revealed. A level never shows more than a page until asked.
  let changesShown = $state(JSON_DIFF_PAGE_SIZE);
  let unchangedShown = $state(JSON_DIFF_PAGE_SIZE);
  let unchangedOpen = $state(false);

  const visibleChanges = $derived(level.changes.slice(0, changesShown));
  const hiddenChanges = $derived(level.changes.length - visibleChanges.length);
  const visibleUnchanged = $derived(level.unchanged.slice(0, unchangedShown));
  const hiddenUnchanged = $derived(level.unchanged.length - visibleUnchanged.length);

  // A symbol and a name for each kind, so the colour is never the only signal.
  const MARKERS: Record<JsonDiffKind, string> = {
    added: '+',
    removed: '-',
    changed: '~',
    unchanged: '=',
  };
  const KIND_LABELS: Record<JsonDiffKind, string> = {
    added: 'Added',
    removed: 'Removed',
    changed: 'Changed',
    unchanged: 'Unchanged',
  };

  function valueText(entry: JsonDiffEntry): string {
    if (entry.kind === 'added') return entry.after ?? '';
    if (entry.kind === 'changed') return `${entry.before ?? ''} → ${entry.after ?? ''}`;
    return entry.before ?? '';
  }

  function unchangedLabel(count: number): string {
    return `${formatNumber(count)} unchanged ${count === 1 ? 'entry' : 'entries'}`;
  }

  // The nested levels the render budget closed that the reader has opened, by entry id.
  let opened: ReadonlySet<string> = $state(new Set());

  function toggleOpened(id: string): void {
    const next = new Set(opened);
    if (!next.delete(id)) next.add(id);
    opened = next;
  }

  function nestedControlLabel(entry: JsonDiffEntry): string {
    const count = entry.children?.changes.length ?? 0;
    return `${opened.has(entry.id) ? 'Hide' : 'Show'} ${formatNumber(count)} ${count === 1 ? 'change' : 'changes'}`;
  }

  const unchangedControlLabel = $derived(
    `${unchangedOpen ? 'Hide' : 'Show'} ${unchangedLabel(level.unchanged.length)}`,
  );

  function moreLabel(hidden: number, noun: string): string {
    const next = Math.min(hidden, JSON_DIFF_PAGE_SIZE);
    return `Show ${formatNumber(next)} more ${noun} (${formatNumber(hidden)} not shown)`;
  }
</script>

<ul class="cinder-json-diff-viewer__list">
  {#each visibleChanges as entry (entry.id)}
    {@render row(entry)}
  {/each}
  {#if hiddenChanges > 0}
    <li class="cinder-json-diff-viewer__control">
      <button
        type="button"
        class="cinder-json-diff-viewer__button"
        onclick={() => (changesShown += JSON_DIFF_PAGE_SIZE)}
      >
        {moreLabel(hiddenChanges, 'changes')}
      </button>
    </li>
  {/if}
  {#if level.unchanged.length > 0}
    <li class="cinder-json-diff-viewer__control">
      <button
        type="button"
        class="cinder-json-diff-viewer__button"
        aria-expanded={unchangedOpen}
        onclick={() => (unchangedOpen = !unchangedOpen)}
      >
        {unchangedControlLabel}
      </button>
    </li>
    {#if unchangedOpen}
      {#each visibleUnchanged as entry (entry.id)}
        {@render row(entry)}
      {/each}
      {#if hiddenUnchanged > 0}
        <li class="cinder-json-diff-viewer__control">
          <button
            type="button"
            class="cinder-json-diff-viewer__button"
            onclick={() => (unchangedShown += JSON_DIFF_PAGE_SIZE)}
          >
            {moreLabel(hiddenUnchanged, 'unchanged entries')}
          </button>
        </li>
      {/if}
    {/if}
  {/if}
</ul>

{#snippet row(entry: JsonDiffEntry)}
  <li class="cinder-json-diff-viewer__row" data-cinder-diff-kind={entry.kind}>
    <span class="cinder-json-diff-viewer__marker" role="img" aria-label={KIND_LABELS[entry.kind]}
      >{MARKERS[entry.kind]}</span
    >
    <span class="cinder-json-diff-viewer__key">{entry.key}</span>
    {#if entry.children && entry.collapsed}
      <!-- A nested level the render budget closed: it opens on request, so a huge comparison never builds it unasked. -->
      <button
        type="button"
        class="cinder-json-diff-viewer__button"
        aria-expanded={opened.has(entry.id)}
        onclick={() => toggleOpened(entry.id)}
      >
        {nestedControlLabel(entry)}
      </button>
      {#if opened.has(entry.id)}
        <Self level={entry.children} />
      {/if}
    {:else if entry.children}
      <Self level={entry.children} />
    {:else}
      <span class="cinder-json-diff-viewer__value">{valueText(entry)}</span>
    {/if}
  </li>
{/snippet}

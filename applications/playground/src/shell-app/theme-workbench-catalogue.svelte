<script lang="ts">
  /*
   * The six-field token catalogue (friendly name, value, path, CSS property, type, context)
   * with search and the Changed, Alias and Recipe filters. The value is the draft's value for
   * the active context, with the shipped value beside a changed token. At 1200px and wider
   * it is a table in a bounded scroll region; from 768px it is a list of stacked rows; below
   * that each row is one token with its name and value first and the path, property, type
   * and context behind a disclosure. The mobile layout never reuses the desktop table.
   * Selecting a row is the only thing that changes the selected token.
   */
  import { Chip, Input } from '@lostgradient/cinder';
  import Check from 'lucide-svelte/icons/check';

  import {
    filterRows,
    filterRowsBy,
    rowsForView,
    type CatalogueRow,
  } from './theme-builder-catalogue.ts';
  import type { ThemeBuilderController } from './theme-builder-controller.svelte.ts';
  import type { WorkbenchLayout } from './theme-workbench-layout.ts';
  import type { ThemeWorkbenchState } from './theme-workbench-state.svelte.ts';

  type Props = {
    workbench: ThemeWorkbenchState;
    layout: WorkbenchLayout;
    controller?: ThemeBuilderController | undefined;
  };
  let { workbench, layout, controller }: Props = $props();

  const changed = $derived(controller?.changedPaths ?? new Set<string>());
  const rows = $derived(
    filterRowsBy(
      filterRows(rowsForView(workbench.groupId, workbench.filters), workbench.filter),
      workbench.filters,
      changed,
    ),
  );
  const FILTERS = [
    { id: 'changed', label: 'Changed' },
    { id: 'alias', label: 'Aliases' },
    { id: 'recipe', label: 'Recipes' },
    { id: 'color', label: 'Colors' },
  ] as const;

  function draftOf(row: CatalogueRow): string {
    return controller?.draftValues.get(row.cssProperty) ?? 'Not evaluated yet';
  }

  function shippedOf(row: CatalogueRow): string | undefined {
    return controller?.shippedValues.get(row.cssProperty);
  }
  const tabStopPath = $derived(
    rows.some((row) => row.path === workbench.selectedTokenPath)
      ? workbench.selectedTokenPath
      : (rows[0]?.path ?? null),
  );
  const countText = $derived(
    workbench.filters.color
      ? `${rows.length} color ${rows.length === 1 ? 'token' : 'tokens'}`
      : `${rows.length} ${rows.length === 1 ? 'token' : 'tokens'} in ${workbench.groupId}`,
  );

  /*
   * Roving focus: the rows' buttons are one tab stop, and the arrow keys, Home, and End move
   * between them. Attached as a listener rather than an inline handler because the container
   * is a plain scroll region; the interactive elements are the buttons inside it.
   */
  function rovingFocus(container: HTMLElement): () => void {
    const onKeydown = (event: KeyboardEvent): void => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      const buttons = [...container.querySelectorAll<HTMLButtonElement>('[data-token-row-button]')];
      const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
      if (current === -1) return;
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      const next =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? buttons.length - 1
            : Math.min(buttons.length - 1, Math.max(0, current + step));
      buttons[next]?.focus();
    };
    container.addEventListener('keydown', onKeydown);
    return () => container.removeEventListener('keydown', onKeydown);
  }

  function isSelected(row: CatalogueRow): boolean {
    return row.path === workbench.selectedTokenPath;
  }
</script>

{#snippet valueText(row: CatalogueRow)}
  <span class="sr-only">Draft value: </span><span data-testid="row-value">{draftOf(row)}</span>
  {#if changed.has(row.path) && shippedOf(row) !== undefined && shippedOf(row) !== draftOf(row)}
    <span class="muted"> (shipped <span class="sr-only">value: </span>{shippedOf(row)})</span>
  {/if}
{/snippet}

{#snippet rowButton(row: CatalogueRow)}
  <button
    type="button"
    class="row-button"
    data-token-row-button
    data-token-path={row.path}
    tabindex={row.path === tabStopPath ? 0 : -1}
    aria-current={isSelected(row) ? 'true' : undefined}
    onclick={() => workbench.selectToken(row.path)}
  >
    {#if isSelected(row)}
      <Check size={14} strokeWidth={2} aria-hidden="true" />
      <span class="sr-only">Selected: </span>
    {/if}
    {row.name}
  </button>
{/snippet}

<section class="catalogue" aria-labelledby="catalogue-heading">
  <h2 id="catalogue-heading">Token catalogue</h2>
  <Input
    id="theme-builder-token-filter"
    type="search"
    label="Search tokens"
    placeholder="Filter by name, path, or property"
    value={workbench.filter}
    oninput={(event) => workbench.setFilter(event.currentTarget.value)}
  />
  <div class="filters" role="group" aria-label="Catalogue filters">
    {#each FILTERS as filter (filter.id)}
      <Chip
        mode="toggle"
        label={filter.label}
        pressed={workbench.filters[filter.id]}
        onPressedChange={(pressed) =>
          workbench.setFilters({ ...workbench.filters, [filter.id]: pressed })}
      />
    {/each}
  </div>
  <p class="count" aria-live="polite" data-testid="catalogue-count">{countText}</p>

  {#if rows.length === 0}
    <p class="empty">
      {workbench.groupId === 'source'
        ? 'Source-only tokens appear here once the token runtime is available.'
        : 'No tokens match this filter.'}
    </p>
  {:else if layout === 'desktop'}
    <div
      class="scroll"
      role="region"
      aria-label="Token catalogue table"
      data-scroll-region="catalogue"
      {@attach rovingFocus}
    >
      <table>
        <caption class="sr-only">Tokens in {workbench.groupId}</caption>
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Value</th>
            <th scope="col">Path</th>
            <th scope="col">CSS property</th>
            <th scope="col">Type</th>
            <th scope="col">Context</th>
          </tr>
        </thead>
        <tbody>
          {#each rows as row (row.path)}
            <tr data-selected={isSelected(row) ? 'true' : undefined}>
              <th scope="row">{@render rowButton(row)}</th>
              <td>{@render valueText(row)}</td>
              <td><code>{row.path}</code></td>
              <td><code>{row.cssProperty}</code></td>
              <td>{row.type}</td>
              <td>{row.context}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {:else}
    <ul
      class="stack scroll"
      aria-label="Tokens in {workbench.groupId}"
      data-scroll-region="catalogue"
      {@attach rovingFocus}
    >
      {#each rows as row (row.path)}
        <li class="stack__row" data-selected={isSelected(row) ? 'true' : undefined}>
          {@render rowButton(row)}
          <p class="stack__value">{@render valueText(row)}</p>
          {#snippet fields()}
            <dl>
              <div>
                <dt>Path</dt>
                <dd><code>{row.path}</code></dd>
              </div>
              <div>
                <dt>CSS property</dt>
                <dd><code>{row.cssProperty}</code></dd>
              </div>
              <div>
                <dt>Type</dt>
                <dd>{row.type}</dd>
              </div>
              <div>
                <dt>Context</dt>
                <dd>{row.context}</dd>
              </div>
            </dl>
          {/snippet}
          {#if layout === 'mobile'}
            <details>
              <summary>Details</summary>
              {@render fields()}
            </details>
          {:else}
            {@render fields()}
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .catalogue {
    display: grid;
    gap: 12px;
    min-width: 0;
  }
  h2 {
    margin: 0;
    font-size: var(--cinder-text-md);
    font-weight: var(--cinder-font-semibold);
  }
  .filters {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .stack__value {
    margin: 0 0 0 6px;
    font-size: var(--cinder-text-sm);
    font-family: var(--cinder-font-mono);
  }
  .count,
  .empty {
    margin: 0;
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-sm);
  }
  .scroll {
    max-height: 22rem;
    overflow: auto;
    border: 1px solid var(--cinder-border-muted);
    border-radius: var(--cinder-radius-md);
  }
  .scroll:focus-visible {
    outline: var(--cinder-ring-width) solid transparent;
    box-shadow: var(--_cinder-focus-ring-shadow);
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--cinder-text-sm);
  }
  th,
  td {
    padding: 6px 10px;
    border-block-end: 1px solid var(--cinder-border-muted);
    text-align: start;
    vertical-align: top;
    font-weight: inherit;
  }
  thead th {
    position: sticky;
    inset-block-start: 0;
    background: var(--cinder-surface-inset);
    font-weight: var(--cinder-font-semibold);
  }
  /* A selected row carries a start border and a weight as well as a fill. */
  tr[data-selected='true'] > *:first-child {
    box-shadow: inset 3px 0 0 var(--cinder-accent-solid);
  }
  tr[data-selected='true'] {
    background: var(--cinder-surface-inset);
  }
  code {
    font-family: var(--cinder-font-mono);
    font-size: var(--cinder-text-xs);
    overflow-wrap: anywhere;
  }
  .muted {
    color: var(--cinder-text-muted);
  }
  .stack {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .stack__row {
    padding: 8px 12px;
    border-block-end: 1px solid var(--cinder-border-muted);
    overflow-wrap: anywhere;
  }
  .stack__row[data-selected='true'] {
    background: var(--cinder-surface-inset);
    box-shadow: inset 3px 0 0 var(--cinder-accent-solid);
  }
  dl {
    display: grid;
    gap: 4px;
    margin: 8px 0 0;
    font-size: var(--cinder-text-sm);
  }
  dl > div {
    display: grid;
    grid-template-columns: minmax(6rem, 8rem) minmax(0, 1fr);
    gap: 8px;
  }
  dt {
    color: var(--cinder-text-muted);
  }
  dd {
    margin: 0;
  }
  summary {
    cursor: pointer;
    min-height: 1.5rem;
  }
  .row-button {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    min-height: 2rem;
    padding: 2px 6px;
    border: 0;
    border-radius: var(--cinder-radius-sm);
    background: transparent;
    color: var(--cinder-text-default);
    font: inherit;
    font-weight: var(--cinder-font-medium);
    text-align: start;
    cursor: pointer;
  }
  .row-button[aria-current='true'] {
    font-weight: var(--cinder-font-bold);
  }
  .row-button:focus-visible {
    outline: var(--cinder-ring-width) solid transparent;
    box-shadow: var(--_cinder-focus-ring-shadow);
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    padding: 0;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  @media (max-width: 479.98px) {
    dl > div {
      grid-template-columns: minmax(0, 1fr);
      gap: 0;
    }
  }
  @media (forced-colors: active) {
    .scroll:focus-visible {
      outline: var(--cinder-ring-width) solid ButtonText;
      outline-offset: 3px;
    }
    .row-button:focus-visible {
      outline: var(--cinder-ring-width) solid ButtonText;
      outline-offset: 3px;
    }
  }
</style>

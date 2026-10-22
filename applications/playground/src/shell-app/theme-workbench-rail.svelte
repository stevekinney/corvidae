<script lang="ts">
  /*
   * The category rail: a navigation landmark whose items choose which part of the
   * catalogue is showing. Counts come from the registry through the catalogue module.
   */
  import { CATALOGUE_GROUPS, rowsInGroup } from './theme-builder-catalogue.ts';
  import type { ThemeWorkbenchState } from './theme-workbench-state.svelte.ts';

  type Props = { workbench: ThemeWorkbenchState };
  let { workbench }: Props = $props();
</script>

<nav class="rail" aria-label="Token categories">
  <ul>
    {#each CATALOGUE_GROUPS as group (group.id)}
      <li>
        <button
          type="button"
          class="rail__item"
          aria-current={workbench.groupId === group.id ? 'true' : undefined}
          onclick={() => workbench.selectGroup(group.id)}
        >
          <span>{group.label}</span>
          <span class="rail__count">{rowsInGroup(group.id).length}</span>
        </button>
      </li>
    {/each}
  </ul>
</nav>

<style>
  .rail {
    min-width: 0;
  }
  ul {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .rail__item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    width: 100%;
    min-height: 2.5rem;
    padding: 6px 12px;
    border: 1px solid transparent;
    border-radius: var(--cinder-radius-md);
    background: transparent;
    color: var(--cinder-text-default);
    font: inherit;
    text-align: start;
    cursor: pointer;
  }
  @media (hover: hover) {
    .rail__item:hover {
      background: var(--cinder-surface-hover);
    }
  }
  .rail__item:focus-visible {
    outline: var(--cinder-ring-width) solid transparent;
    box-shadow: var(--_cinder-focus-ring-shadow);
  }
  /* Selection is shown by a border and weight, not by color alone. */
  .rail__item[aria-current='true'] {
    border-color: var(--cinder-border-control);
    background: var(--cinder-surface-inset);
    font-weight: var(--cinder-font-semibold);
  }
  .rail__count {
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-xs);
  }
  @media (max-width: 767.98px) {
    ul {
      flex-direction: row;
      flex-wrap: wrap;
    }
    .rail__item {
      width: auto;
      flex: 1 1 auto;
    }
  }
  @media (forced-colors: active) {
    .rail__item:focus-visible {
      outline: var(--cinder-ring-width) solid ButtonText;
      outline-offset: 3px;
    }
  }
</style>

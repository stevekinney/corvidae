<script lang="ts" module>
  export const title = 'Grouped tools with a filter';
  export const description =
    'A filter field and a count at the top of the list, rows grouped by source under their own headers, and the first tool open. While the tools load, five placeholder rows and a detail block appear after 300 ms.';
</script>

<script lang="ts">
  import { ListDetail, SearchField, SelectableRow, Toggle } from '@lostgradient/cinder';

  type Tool = { id: string; name: string; source: string; summary: string };

  const tools: Tool[] = [
    {
      id: 'discover-agents',
      name: 'Discover agents',
      source: 'Built in',
      summary: 'Finds agents by name or description.',
    },
    {
      id: 'schedule-wakeup',
      name: 'Schedule wakeup',
      source: 'Built in',
      summary: 'Lets an agent continue later.',
    },
    {
      id: 'list-issues',
      name: 'List issues',
      source: 'GitHub',
      summary: 'Lists issues in a repository.',
    },
    {
      id: 'create-issue',
      name: 'Create issue',
      source: 'GitHub',
      summary: 'Opens an issue in a repository.',
    },
  ];

  let filter = $state('');
  let loading = $state(false);
  const visible = $derived(
    tools.filter((tool) => tool.name.toLowerCase().includes(filter.trim().toLowerCase())),
  );
</script>

<Toggle id="tools-loading" bind:checked={loading} label="Loading" />

<div class="tools">
  <ListDetail
    items={visible}
    key={(tool) => tool.id}
    label="Tools"
    selectedKey="discover-agents"
    selectionParameter={null}
    {loading}
    loadingLabel="Loading tools"
    groupBy={(tool) => ({ key: tool.source, label: tool.source })}
  >
    {#snippet header()}
      <div class="filter-row">
        <SearchField aria-label="Filter tools" placeholder="Filter tools" bind:value={filter} />
        <span class="count">{visible.length} tools</span>
      </div>
    {/snippet}
    {#snippet list(tool, row)}
      <SelectableRow selected={row.selected} selectedState="current" onclick={row.open}>
        {#snippet title()}{tool.name}{/snippet}
      </SelectableRow>
    {/snippet}
    {#snippet listEmpty()}No tools match the filter.{/snippet}
    {#snippet detail(tool)}
      <h3>{tool.name}</h3>
      <p>{tool.summary}</p>
    {/snippet}
  </ListDetail>
</div>

<style>
  .tools {
    block-size: 22rem;
    border: 1px solid var(--cinder-border-muted);
    border-radius: var(--cinder-radius-md);
    overflow: hidden;
  }

  .filter-row {
    display: flex;
    align-items: center;
    gap: var(--cinder-space-3);
  }

  .count {
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-sm);
    white-space: nowrap;
  }
</style>

<script lang="ts">
  import { SelectableRow } from '../selectable-row/index.ts';
  import ListDetail from './list-detail.svelte';
  import type { ListDetailProps } from './list-detail.types.ts';

  /* The documented tools example: a grouped list in a framed box, its first row selected, so the
   * selected row sits directly under a group heading and against both pane edges. */
  type Tool = { id: string; name: string; source: string; summary: string };

  type FixtureProps = Partial<
    Omit<ListDetailProps<Tool>, 'items' | 'key' | 'list' | 'detail' | 'groupBy'>
  >;

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
    { id: 'list-issues', name: 'List issues', source: 'GitHub', summary: 'Lists issues.' },
    { id: 'create-issue', name: 'Create issue', source: 'GitHub', summary: 'Opens an issue.' },
    { id: 'read-page', name: 'Read page', source: 'GitHub', summary: 'Reads a wiki page.' },
  ];

  let { selectedKey = $bindable(null), ...rest }: FixtureProps = $props();
</script>

<div class="list-detail-groups-fixture-frame">
  <ListDetail
    items={tools}
    key={(tool) => tool.id}
    label="Tools"
    groupBy={(tool) => ({ key: tool.source, label: tool.source })}
    bind:selectedKey
    {...rest}
  >
    {#snippet header()}
      <input type="search" aria-label="Filter tools" />
    {/snippet}
    {#snippet list(tool, row)}
      <SelectableRow selected={row.selected} selectedState="current" onclick={row.open}>
        {#snippet title()}{tool.name}{/snippet}
      </SelectableRow>
    {/snippet}
    {#snippet detail(tool)}
      <h3>{tool.name}</h3>
      <p>{tool.summary}</p>
    {/snippet}
  </ListDetail>
</div>

<style>
  .list-detail-groups-fixture-frame {
    block-size: 22rem;
    border: 1px solid var(--cinder-border-muted);
    border-radius: var(--cinder-radius-md);
    overflow: hidden;
  }
</style>

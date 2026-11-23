<script lang="ts">
  import { DataTable, type DataTableColumn } from '@lostgradient/cinder';
  import Virtualized from './data-table/virtualized.svelte';

  const showFit = new URLSearchParams(globalThis.location.search).has('fit');
  const columns: DataTableColumn<(typeof rows)[number]>[] = [
    { key: 'name', label: 'Name', sortable: true },
    { key: 'project', label: 'Project' },
    { key: 'owner', label: 'Owner' },
    { key: 'region', label: 'Region' },
    { key: 'status', label: 'Status' },
  ];
  const rows = [
    {
      id: 'first',
      name: 'North America delivery workflow',
      project: 'Daily warehouse inventory snapshot',
      owner: 'Revenue operations engineering',
      region: 'United States west coast region',
      status: 'Waiting for the next scheduled run',
    },
  ];
</script>

<div id="example-mount-virtualized"><Virtualized /></div>

{#if showFit}
  <div data-testid="fit-table">
    <DataTable {columns} {rows} fit />
  </div>
  <div data-testid="scrolling-table">
    <DataTable {columns} {rows} />
  </div>
  <div data-testid="selectable-fit">
    <DataTable {columns} {rows} fit selectable="multiple" />
  </div>
{/if}

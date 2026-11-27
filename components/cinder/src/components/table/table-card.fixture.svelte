<script lang="ts" module>
  import type { TableSort } from './table.types.ts';

  /** Test-only fixture: a table of models that stacks into cards when it is `fit`. */
  export type TableCardFixtureProps = {
    fit?: boolean;
    stackBelow?: string | false;
    /** A control column: a switch that keeps its size (`'fit'`), or one that fills its cell (`true`). */
    controls?: 'fit' | true | undefined;
    sortable?: boolean;
    /** Table's own `sortable`; defaults to `sortable`, and is set apart to test its warning. */
    tableSortable?: boolean;
    /** The sort applied from the start. */
    initialSort?: TableSort;
  };
</script>

<script lang="ts">
  import { untrack } from 'svelte';

  import TableBody from '../table-body/table-body.svelte';
  import TableCell from '../table-cell/table-cell.svelte';
  import TableHeaderCell from '../table-header-cell/table-header-cell.svelte';
  import TableHeader from '../table-header/table-header.svelte';
  import TableRow from '../table-row/table-row.svelte';
  import Table from './table.svelte';

  let {
    fit = true,
    stackBelow,
    controls,
    sortable = false,
    tableSortable = sortable,
    initialSort,
  }: TableCardFixtureProps = $props();

  let sort = $state<TableSort | undefined>(untrack(() => initialSort));
  const models = [
    {
      name: 'Claude Opus',
      identifier: 'claude-opus',
      allowed: 'Allowed',
      abilities: 'Tools',
      last: '2m',
    },
    {
      name: 'Claude Haiku',
      identifier: 'claude-haiku',
      allowed: 'Not allowed',
      abilities: '',
      last: '9d',
    },
  ];
</script>

<Table
  caption="Models"
  {fit}
  sortable={tableSortable}
  bind:sort
  {...stackBelow !== undefined ? { stackBelow } : {}}
>
  <TableHeader>
    <TableRow>
      {#if sortable}
        <TableHeaderCell label="Model" column="model" sortable>Model</TableHeaderCell>
      {:else}
        <TableHeaderCell label="Model">Model</TableHeaderCell>
      {/if}
      <TableHeaderCell label="Allowed">Allowed</TableHeaderCell>
      <TableHeaderCell label="Abilities">Abilities</TableHeaderCell>
      <TableHeaderCell label="Last run">Last run</TableHeaderCell>
      {#if controls}<TableHeaderCell label="On">On</TableHeaderCell>{/if}
    </TableRow>
  </TableHeader>
  <TableBody>
    {#each models as model (model.identifier)}
      <TableRow>
        <TableCell as="th">
          {model.name}
          {#snippet detail()}{model.identifier}{/snippet}
        </TableCell>
        <TableCell stack="status">{model.allowed}</TableCell>
        <TableCell>{model.abilities}</TableCell>
        <TableCell stack="end">{model.last}</TableCell>
        {#if controls}<TableCell {controls}><input type="checkbox" aria-label="On" /></TableCell
          >{/if}
      </TableRow>
    {/each}
  </TableBody>
</Table>

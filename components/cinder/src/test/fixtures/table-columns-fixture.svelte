<script lang="ts" module>
  /** Test-only fixture: a table with a truncating column and a column of controls. */
  export type TableColumnsFixtureProps = {
    /** Text for each row's truncating cell. */
    values: string[];
    /** Whether the truncating cells carry an explicit `title`. */
    explicitTitles?: boolean;
  };
</script>

<script lang="ts">
  import Table from '../../components/table/table.svelte';
  import TableBody from '../../components/table-body/table-body.svelte';
  import TableCell from '../../components/table-cell/table-cell.svelte';
  import TableHeader from '../../components/table-header/table-header.svelte';
  import TableHeaderCell from '../../components/table-header-cell/table-header-cell.svelte';
  import TableRow from '../../components/table-row/table-row.svelte';

  let { values, explicitTitles = false }: TableColumnsFixtureProps = $props();
</script>

<Table caption="Stored values">
  <TableHeader>
    <TableRow>
      <TableHeaderCell>Key</TableHeaderCell>
      <TableHeaderCell>Setting</TableHeaderCell>
    </TableRow>
  </TableHeader>
  <TableBody>
    {#each values as value, index (index)}
      <TableRow>
        <TableCell truncate title={explicitTitles ? `Key ${index + 1}` : undefined}
          >{value}</TableCell
        >
        <TableCell controls>
          <input aria-label={`Setting ${index + 1}`} value={'x'.repeat((index + 1) * 12)} />
        </TableCell>
      </TableRow>
    {/each}
  </TableBody>
</Table>

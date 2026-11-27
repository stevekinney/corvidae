<script lang="ts" module>
  /** Test-only fixture: a `fit` table of connection checks whose columns set `sizing`. */
  export type TableSizingFixtureProps = {
    /** Leave every `sizing` off, for the equal-column default. */
    unsized?: boolean;
    /** Add a cell that spans every column, which belongs to none. */
    spanning?: boolean;
    /** Add a row whose first cell spans two columns, so the cell after it is in the third. */
    leadingSpan?: boolean;
    /** Draw the table without `fit`, where sizing changes nothing. */
    fit?: boolean;
  };
</script>

<script lang="ts">
  import TableBody from '../table-body/table-body.svelte';
  import TableCell from '../table-cell/table-cell.svelte';
  import TableHeaderCell from '../table-header-cell/table-header-cell.svelte';
  import TableHeader from '../table-header/table-header.svelte';
  import TableRow from '../table-row/table-row.svelte';
  import Table from './table.svelte';

  let {
    unsized = false,
    spanning = false,
    leadingSpan = false,
    fit = true,
  }: TableSizingFixtureProps = $props();

  const checks = [
    { check: 'Frontend', result: 'Passed', found: 'The frontend answered on port 7233.' },
    { check: 'Namespace', result: 'Not reached', found: 'The namespace list call timed out.' },
  ];
</script>

<Table caption="Connection checks" {fit} stackBelow={false}>
  <TableHeader>
    <TableRow>
      <TableHeaderCell {...unsized ? {} : { sizing: 'content' as const }}>Check</TableHeaderCell>
      <TableHeaderCell {...unsized ? {} : { sizing: 'content' as const }}>Result</TableHeaderCell>
      <TableHeaderCell {...unsized ? {} : { sizing: 'fill' as const }}
        >What it found</TableHeaderCell
      >
    </TableRow>
  </TableHeader>
  <TableBody>
    {#each checks as check (check.check)}
      <TableRow>
        <TableCell as="th">{check.check}</TableCell>
        <TableCell>{check.result}</TableCell>
        <TableCell>{check.found}</TableCell>
      </TableRow>
    {/each}
    {#if leadingSpan}
      <TableRow data-testid="leading-span">
        <TableCell colspan={2}>All checks</TableCell>
        <TableCell>Every check ran against the same connection.</TableCell>
      </TableRow>
    {/if}
    {#if spanning}
      <TableRow>
        <TableCell colspan={3}>No more checks.</TableCell>
      </TableRow>
    {/if}
  </TableBody>
</Table>

<script lang="ts">
  import Table from '../../components/table/table.svelte';
  import TableBody from '../../components/table-body/table-body.svelte';
  import TableCell from '../../components/table-cell/table-cell.svelte';
  import TableHeader from '../../components/table-header/table-header.svelte';
  import TableHeaderCell from '../../components/table-header-cell/table-header-cell.svelte';
  import TableRow from '../../components/table-row/table-row.svelte';
</script>

<!-- A name cell with a detail, beside a cell that holds a control. -->
<Table>
  <TableHeader>
    <TableRow>
      <TableHeaderCell>Tool</TableHeaderCell>
      <TableHeaderCell>Asks</TableHeaderCell>
    </TableRow>
  </TableHeader>
  <TableBody>
    <TableRow>
      <TableCell>
        Lookup order
        {#snippet detail()}<code>lookup-order</code>{/snippet}
      </TableCell>
      <TableCell controls><input aria-label="Asks" /></TableCell>
    </TableRow>
    <TableRow>
      <TableCell>Issue refund</TableCell>
      <TableCell controls><input aria-label="Asks" /></TableCell>
    </TableRow>
  </TableBody>
</Table>

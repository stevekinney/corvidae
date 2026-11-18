<script lang="ts">
  import TableBody from '../table-body/table-body.svelte';
  import TableCell from '../table-cell/table-cell.svelte';
  import TableRow from '../table-row/table-row.svelte';
  import Table from './table.svelte';

  let { value }: { value: string } = $props();
</script>

<Table caption="Stored values" fit>
  <TableBody>
    <TableRow>
      <TableCell truncate>
        <a href="#key">{value}</a>
      </TableCell>
    </TableRow>
  </TableBody>
</Table>

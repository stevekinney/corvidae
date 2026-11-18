<script lang="ts">
  import TableBody from '../table-body/table-body.svelte';
  import TableCell from '../table-cell/table-cell.svelte';
  import TableRow from '../table-row/table-row.svelte';
  import Table from './table.svelte';

  let { clamp = true }: { clamp?: boolean } = $props();
</script>

<Table caption="Runs" fit>
  <TableBody>
    <TableRow>
      <TableCell as="th" {clamp}>Run 4471</TableCell>
      <TableCell>Done</TableCell>
    </TableRow>
  </TableBody>
</Table>

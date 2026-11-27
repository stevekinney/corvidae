<script lang="ts" module>
  /**
   * Test-only fixture for COR-2771: a table rendered on the server and on the client, in each shape
   * that decides its stacked form. It reads no browser global, so the server can render it.
   */
  export type TableServerFixtureProps = {
    /**
     * - `fit`: a `fit` table, Namespace and State (the Temporal UI's Namespaces table).
     * - `fit-switch`: `fit` with a switch that keeps its size (`controls="fit"`).
     * - `fit-select`: `fit` with a select that fills its cell (`controls`).
     * - `controls`: no `fit`, with a switch that keeps its size.
     * - `plain`: neither `fit` nor a control.
     */
    shape?: 'fit' | 'fit-switch' | 'fit-select' | 'controls' | 'plain';
    stackBelow?: string | false;
  };
</script>

<script lang="ts">
  import TableBody from '../table-body/table-body.svelte';
  import TableCell from '../table-cell/table-cell.svelte';
  import TableHeaderCell from '../table-header-cell/table-header-cell.svelte';
  import TableHeader from '../table-header/table-header.svelte';
  import TableRow from '../table-row/table-row.svelte';
  import Table from './table.svelte';

  let { shape = 'fit', stackBelow }: TableServerFixtureProps = $props();

  const fit = $derived(shape.startsWith('fit'));
  const control = $derived(
    shape === 'fit-switch' || shape === 'controls' ? 'fit' : shape === 'fit-select',
  );
</script>

<Table caption="Namespaces" {fit} {...stackBelow === undefined ? {} : { stackBelow }}>
  <TableHeader>
    <TableRow>
      <TableHeaderCell label="Namespace">Namespace</TableHeaderCell>
      <TableHeaderCell label="State">State</TableHeaderCell>
      <TableHeaderCell label="Retention">Retention</TableHeaderCell>
      {#if control}<TableHeaderCell label="On">On</TableHeaderCell>{/if}
    </TableRow>
  </TableHeader>
  <TableBody>
    <!-- A row whose title is its row header. -->
    <TableRow>
      <TableCell as="th">default</TableCell>
      <TableCell>Registered</TableCell>
      <TableCell></TableCell>
      {#if control}<TableCell controls={control === 'fit' ? 'fit' : true}
          ><input type="checkbox" aria-label="On" /></TableCell
        >{/if}
    </TableRow>
    <!-- A row whose title is its first cell with content. -->
    <TableRow>
      <TableCell></TableCell>
      <TableCell>orders</TableCell>
      <TableCell>30 days</TableCell>
      {#if control}<TableCell controls={control === 'fit' ? 'fit' : true}
          ><input type="checkbox" aria-label="On" /></TableCell
        >{/if}
    </TableRow>
    <!-- A row whose row header follows a cell with content: the header is the title. -->
    <TableRow>
      <TableCell>Deprecated</TableCell>
      <TableCell as="th">billing</TableCell>
      <TableCell>90 days</TableCell>
      {#if control}<TableCell controls={control === 'fit' ? 'fit' : true}
          ><input type="checkbox" aria-label="On" /></TableCell
        >{/if}
    </TableRow>
  </TableBody>
</Table>

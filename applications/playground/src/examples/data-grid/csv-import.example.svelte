<script lang="ts" module>
  export const title = 'Parsed CSV import';
  export const description =
    'Parses static CSV text with parseDelimitedText and passes the derived columns/rows straight into DataGrid.';
</script>

<script lang="ts">
  import { DataGrid, parseDelimitedText, type DataGridColumnDef } from '@lostgradient/cinder';

  type ImportedOrder = {
    id: string;
    customer: string;
    status: string;
    rowIdentity: string;
  };

  const csv = `id,customer,status
ORD-1001,Ada Lovelace,Packed
ORD-1002,Grace Hopper,Shipped
ORD-1003,Alan Turing,Queued
`;

  const parsed = parseDelimitedText(csv, { delimiter: ',' });
  const rows: ImportedOrder[] = (parsed.rows as Omit<ImportedOrder, 'rowIdentity'>[]).map(
    (order, index) => ({ ...order, rowIdentity: String(index) }),
  );
  const columns = parsed.columns as DataGridColumnDef<ImportedOrder>[];
</script>

<DataGrid
  {rows}
  {columns}
  getRowId={(row: ImportedOrder) => row.rowIdentity}
  aria-label="Imported orders"
/>

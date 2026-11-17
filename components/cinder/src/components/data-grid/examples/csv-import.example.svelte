<script lang="ts" module>
  export const title = 'Parsed CSV import';
  export const description =
    'Parses static CSV text with parseDelimitedText and passes the derived columns/rows straight into DataGrid.';
</script>

<script lang="ts">
  import { DataGrid, parseDelimitedText } from '@lostgradient/cinder';

  const csv = `id,customer,status
ORD-1001,Ada Lovelace,Packed
ORD-1002,Grace Hopper,Shipped
ORD-1003,Alan Turing,Queued
`;

  const parsed = parseDelimitedText(csv, { delimiter: ',' });
  const rows = parsed.rows.map((row, index) => ({ ...row, __rowIndex: String(index) }));
</script>

<DataGrid
  {rows}
  columns={parsed.columns}
  getRowId={(row) => row['__rowIndex'] ?? ''}
  aria-label="Imported orders"
/>

<script lang="ts" module>
  export const title = 'Editable order grid';
  export const description =
    'Marks two columns editable and applies committed cell edits back onto local state through onCellEdit.';
</script>

<script lang="ts">
  import { DataGrid, type DataGridColumnDef } from '@lostgradient/cinder';

  type Order = {
    id: string;
    customer: string;
    total: number;
  };

  let orders = $state<Order[]>([
    { id: 'ORD-1001', customer: 'Ada Lovelace', total: 124 },
    { id: 'ORD-1002', customer: 'Grace Hopper', total: 256 },
    { id: 'ORD-1003', customer: 'Alan Turing', total: 88 },
  ]);

  const columns: DataGridColumnDef<Order>[] = [
    { key: 'customer', header: 'Customer', width: 220, editable: true },
    { key: 'total', header: 'Total', width: 120, editable: true },
  ];

  function handleCellEdit(row: Order, columnKey: string, value: unknown): void {
    orders = orders.map((order) =>
      order.id === row.id ? { ...order, [columnKey]: value } : order,
    );
  }
</script>

<DataGrid
  rows={orders}
  {columns}
  getRowId={(order) => order.id}
  onCellEdit={handleCellEdit}
  aria-label="Editable orders"
/>

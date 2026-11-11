<script lang="ts" module>
  export const title = 'Resizable and reorderable columns';
  export const description =
    'Opts into pointer- and keyboard-driven column resizing and reordering with bound columnSizing and columnOrder.';
</script>

<script lang="ts">
  import { DataGrid, type DataGridColumnDef } from '@lostgradient/cinder';

  type Order = {
    id: string;
    customer: string;
    status: string;
    total: number;
  };

  const orders: Order[] = [
    { id: 'ORD-1001', customer: 'Ada Lovelace', status: 'Packed', total: 124 },
    { id: 'ORD-1002', customer: 'Grace Hopper', status: 'Shipped', total: 256 },
    { id: 'ORD-1003', customer: 'Alan Turing', status: 'Queued', total: 88 },
  ];

  const columns: DataGridColumnDef<Order>[] = [
    { key: 'id', header: 'Order', width: 120, pin: 'left', sortable: true },
    { key: 'customer', header: 'Customer', width: 220, sortable: true },
    { key: 'status', header: 'Status', width: 140 },
    { key: 'total', header: 'Total', width: 120, getValue: (order) => `$${order.total}` },
  ];

  let columnSizing = $state<Record<string, number>>({});
  let columnOrder = $state<readonly string[]>([]);
</script>

<DataGrid
  rows={orders}
  {columns}
  getRowId={(order) => order.id}
  resizableColumns
  reorderableColumns
  bind:columnSizing
  bind:columnOrder
  aria-label="Resizable and reorderable orders"
/>

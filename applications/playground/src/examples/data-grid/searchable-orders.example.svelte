<script lang="ts" module>
  export const title = 'Searchable order grid';
  export const description =
    'Opts into the toolbar search: a SearchField plus next/previous controls that highlight and step through matching cells.';
</script>

<script lang="ts">
  import { DataGrid, type DataGridColumnDef } from '@lostgradient/cinder';

  type Order = {
    id: string;
    customer: string;
    status: string;
  };

  const orders: Order[] = [
    { id: 'ORD-1001', customer: 'Ada Lovelace', status: 'Packed' },
    { id: 'ORD-1002', customer: 'Grace Hopper', status: 'Shipped' },
    { id: 'ORD-1003', customer: 'Alan Turing', status: 'Queued' },
  ];

  const columns: DataGridColumnDef<Order>[] = [
    { key: 'id', header: 'Order', width: 120, pin: 'left' },
    { key: 'customer', header: 'Customer', width: 220 },
    { key: 'status', header: 'Status', width: 140 },
  ];
</script>

<DataGrid rows={orders} {columns} getRowId={(order) => order.id} search aria-label="Orders" />

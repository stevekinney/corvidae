<script lang="ts" module>
  export const title = 'Zoom and toolbar counts';
  export const description =
    'Opts into zoomControls: a toolbar row/column count plus zoom in/out controls bound to zoom.';
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

  let zoom = $state(100);
</script>

<DataGrid
  rows={orders}
  {columns}
  getRowId={(order) => order.id}
  zoomControls
  bind:zoom
  aria-label="Orders"
/>

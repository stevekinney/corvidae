<script lang="ts" module>
  export const title = 'Shapes of data';
  export const description =
    'A few short pairs read as one line, a nested object as a collapsible tree, an array of scalars as a bulleted list, and an array of uniform objects as a table with Load more.';
</script>

<script lang="ts">
  import { PayloadInspector } from '@lostgradient/cinder';

  const few = { orderId: 4471, amount: '$42.00' };
  const tree = {
    notify: { email: 'ops@example.com', slack: '#refunds' },
    retries: 3,
    attachments: [{ name: 'photo.png' }, { name: 'receipt.pdf' }],
  };
  const lists = {
    recipients: ['dana@example.com', 'ops@example.com', 'billing@example.com'],
    items: Array.from({ length: 40 }, (_, index) => ({
      sku: `SKU-${1000 + index * 7}`,
      qty: (index % 3) + 1,
      price: 900 + index * 35,
    })),
  };
</script>

<div style="display: flex; flex-direction: column; gap: 1rem;">
  <PayloadInspector value={few} label="A few short pairs" />
  <PayloadInspector value={tree} label="A nested object" />
  <PayloadInspector value={lists} label="Lists and tables" />
</div>

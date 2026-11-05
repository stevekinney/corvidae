<script lang="ts" module>
  export const title = 'An array of mixed objects';
  export const description =
    'When array items do not share keys no table is drawn: each item is its own block of fields, headed "Item 1 of 3" and so on. Only a uniform array becomes a table.';
</script>

<script lang="ts">
  import { PayloadInspector } from '@lostgradient/cinder';
  const payload = {
    history: [
      { type: 'refund', orderId: 4471, amount: '$42.00' },
      { type: 'note', text: 'Customer called about the photo', author: 'Dana Whitfield' },
      { type: 'email', to: 'dana@example.com' },
    ],
  };
</script>

<PayloadInspector value={payload} label="Input" />

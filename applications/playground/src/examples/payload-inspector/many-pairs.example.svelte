<script lang="ts" module>
  export const title = 'Many short pairs';
  export const description =
    'Eight short pairs wrap into a key and value grid sized to its content, not stretched across the card. Dates read as dates and everything else as stored.';
</script>

<script lang="ts">
  import { PayloadInspector } from '@lostgradient/cinder';
  const order = {
    orderId: 4471,
    amount: '$42.00',
    reason: 'Arrived damaged',
    status: 'delivered',
    customer: 'Dana Whitfield',
    currency: 'USD',
    carrier: 'Parcelly',
    shippedOn: '2026-10-24',
  };
</script>

<PayloadInspector value={order} label="Input" />

<script lang="ts" module>
  export const title = 'The JSON view';
  export const description =
    'The JSON view is a flat code block with a faint fill, muted keys and no border inside the card. It always shows the stored payload with its raw keys.';
</script>

<script lang="ts">
  import { PayloadInspector } from '@lostgradient/cinder';
  const order = { orderId: 4471, amount: '$42.00', reason: 'Arrived damaged' };
</script>

<PayloadInspector value={order} label="Input" view="json" />

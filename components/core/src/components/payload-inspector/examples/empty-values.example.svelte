<script lang="ts" module>
  export const title = 'Empty, none and yes or no';
  export const description =
    'An empty string reads "Empty" and null reads "None", both in muted italics. Booleans read "Yes" and "No". The JSON view keeps "", null, false and true.';
</script>

<script lang="ts">
  import { PayloadInspector } from '@lostgradient/cinder';
  const order = { orderId: 4471, giftNote: '', coupon: null, giftWrap: false, insured: true };
</script>

<PayloadInspector value={order} label="Input" />

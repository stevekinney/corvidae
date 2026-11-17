<script lang="ts" module>
  export const title = 'A long key and a long unbroken value';
  export const description =
    'A key too long for its column cuts to one line with an ellipsis, and a tooltip carries the whole key with its length. A value with no spaces breaks anywhere and never overflows the card.';
</script>

<script lang="ts">
  import { PayloadInspector } from '@lostgradient/cinder';
  const longKey = `order_notes_exception_${'handling_'.repeat(300)}`.slice(0, 2000);
  const payload = {
    orderId: 4471,
    [longKey]: 'Escalate to a manager',
    trackingCode: 'TRK'.concat('A1B2C3D4E5F6'.repeat(12)),
  };
</script>

<PayloadInspector value={payload} label="Input" />

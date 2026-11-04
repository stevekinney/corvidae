<script lang="ts" module>
  export const title = 'Still streaming in';
  export const description =
    'While a payload streams, fields appear as they complete and the last shows a spinner with "Receiving\u2026". The count reads "so far", Copy waits for the end, and the JSON view shows the partial text.';
</script>

<script lang="ts">
  import { PayloadInspector } from '@lostgradient/cinder';
</script>

<PayloadInspector
  value={'{"orderId": 4471, "amount": "$42.00", "reason": "Arriv'}
  label="Input"
  streaming
/>

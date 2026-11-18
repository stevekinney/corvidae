<script lang="ts" module>
  export const title = 'A single value';
  export const description =
    'A payload that is not an object shows the value alone: no key and no grid, the count reads "1 value", and the JSON view quotes it.';
</script>

<script lang="ts">
  import { PayloadInspector } from '@lostgradient/cinder';
</script>

<PayloadInspector value="order-4471" label="Input" />

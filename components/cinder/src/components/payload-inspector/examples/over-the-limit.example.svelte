<script lang="ts" module>
  export const title = 'Over the size limit';
  export const description =
    'Over the maxBytes limit the card renders nothing and shows no switch: the header holds only the size and Copy, and the body says why with a Download JSON button.';
</script>

<script lang="ts">
  import { PayloadInspector } from '@lostgradient/cinder';
  // About 4.2 MB of text, over the 1 MB the card shows.
  const payload = { log: 'x'.repeat(4_404_019) };
</script>

<PayloadInspector value={payload} label="Result" maxBytes={1_048_576} />

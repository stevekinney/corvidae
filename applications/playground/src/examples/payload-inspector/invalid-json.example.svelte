<script lang="ts" module>
  export const title = 'Invalid JSON';
  export const description =
    'When the stored value cannot be parsed, Fields is unavailable and the switch is disabled, the header reads "Text" in place of a count, and a warning sits above the raw text. Copy still works and reads "Copy text".';
</script>

<script lang="ts">
  import { PayloadInspector } from '@lostgradient/cinder';
</script>

<PayloadInspector value={'{ not valid json at all'} label="Input" />

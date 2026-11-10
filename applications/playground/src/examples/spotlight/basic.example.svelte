<script lang="ts" module>
  export const title = 'One focal value with a caveat';
  export const description =
    'The value is display-size neutral text, never the accent. The caveat sits at label size directly under it and says how fresh the value is.';
</script>

<script lang="ts">
  import { Spotlight } from '@lostgradient/cinder';
</script>

<Spotlight value="Ends in 45 min">
  {#snippet caveat()}Updated 12 min ago{/snippet}
</Spotlight>

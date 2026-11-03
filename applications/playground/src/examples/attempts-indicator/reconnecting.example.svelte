<script lang="ts" module>
  export const title = 'Accent bar that fills its container';
  export const description =
    'With tone accent and layout block the bar is a progress cue in its own right, as in the reconnecting dialog\'s "Attempt 3 of 8". Name it with label so the count is spoken.';
</script>

<script lang="ts">
  import { AttemptsIndicator } from '@lostgradient/cinder';
</script>

<div style="max-width: 24rem;">
  <p style="margin: 0 0 0.75rem;">Trying again in 4 s. Attempt 3 of 8.</p>
  <AttemptsIndicator made={3} allowed={8} tone="accent" layout="block" label="Attempt 3 of 8" />
</div>

<script lang="ts" module>
  export const title = 'Number plus unit';
  export const description =
    'A duration stored in milliseconds, typed as a number in the unit that fits it (here 90 seconds). A setting that always counts in one unit fixes it as text inside the frame: "15 seconds".';
</script>

<script lang="ts">
  import { DurationField } from '@lostgradient/cinder';

  let timeout = $state<number | null>(90_000);
  let renew = $state<number | null>(15_000);
</script>

<div style="display: grid; gap: 1rem; max-inline-size: 22rem;">
  <DurationField id="timeout" label="Timeout" bind:value={timeout} />
  <DurationField
    id="renew"
    label="Renew interval"
    unit="s"
    unitSelectable={false}
    bind:value={renew}
  />
  <p style="margin: 0; color: var(--cinder-text-muted);">
    Stored as {timeout} ms and {renew} ms.
  </p>
</div>

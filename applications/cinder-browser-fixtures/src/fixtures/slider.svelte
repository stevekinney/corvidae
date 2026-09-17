<script lang="ts">
  import { Slider } from '@repo/cinder';
  let value = $state(40);
</script>

<div style="display: flex; flex-direction: column; gap: 1rem; max-width: 24rem;">
  <Slider
    label="Volume"
    {value}
    onValueChange={(next) => {
      value = next;
    }}
  />
  <p>Value: {value}</p>
</div>

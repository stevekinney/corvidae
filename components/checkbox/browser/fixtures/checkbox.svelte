<script lang="ts">
  import { default as Checkbox } from '@lostgradient/checkbox/components/checkbox/index.ts';

  let acceptTerms = $state(false);
  let subscribed = $state(true);
</script>

<div style="display: flex; flex-direction: column; gap: 0.75rem;">
  <Checkbox id="terms" label="I accept the terms of service" bind:checked={acceptTerms} />
  <Checkbox id="newsletter" label="Subscribe to the newsletter" bind:checked={subscribed} />
</div>

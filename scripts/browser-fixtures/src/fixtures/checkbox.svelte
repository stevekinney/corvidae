<script lang="ts">
  import { Checkbox } from '@lostgradient/cinder';

  let acceptTerms = $state(false);
  let subscribed = $state(true);
</script>

<div class="example-layout gap-3">
  <Checkbox id="terms" label="I accept the terms of service" bind:checked={acceptTerms} />
  <Checkbox id="newsletter" label="Subscribe to the newsletter" bind:checked={subscribed} />
</div>

<style>
  .example-layout {
    display: flex;
    flex-direction: column;
  }
</style>

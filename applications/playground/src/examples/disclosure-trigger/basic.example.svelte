<script lang="ts" module>
  export const title = 'Details that open under their trigger';
  export const description =
    'The trigger names the region it shows with controls, and the host toggles open.';
</script>

<script lang="ts">
  import { DisclosureTrigger } from '@lostgradient/cinder';

  let open = $state(false);
</script>

<DisclosureTrigger {open} controls="refund-details" onclick={() => (open = !open)}>
  Details
</DisclosureTrigger>
{#if open}
  <div id="refund-details">Refunded $42.00 to the card ending 4471.</div>
{/if}

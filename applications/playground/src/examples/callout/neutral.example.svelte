<script lang="ts" module>
  export const title = 'Neutral note with an action';
  export const description =
    'A plain note that explains a state, with an icon and one link under the message.';
</script>

<script lang="ts">
  import { Callout, Link } from '@lostgradient/cinder';
  import Info from '@lucide/svelte/icons/info';
</script>

<Callout variant="neutral" semantic="note">
  {#snippet icon()}
    <Info size={16} />
  {/snippet}
  Gave up after 5 attempts. The check was never met.
  {#snippet action()}
    <Link href="#attempt-5">Open attempt 5</Link>
  {/snippet}
</Callout>

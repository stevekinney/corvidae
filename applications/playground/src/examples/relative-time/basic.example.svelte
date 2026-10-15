<script lang="ts" module>
  export const title = 'RelativeTime';
  export const description =
    'Displays a localized label for a timestamp relative to the current time.';
</script>

<script lang="ts">
  import { RelativeTime } from '@lostgradient/cinder';
  import { onMount } from 'svelte';

  // Read the clock in the browser, so the label is relative to the reader's now and the
  // server-rendered page never records the time it was built.
  let yesterday = $state<Date>();
  onMount(() => {
    yesterday = new Date(Date.now() - 86_400_000);
  });
</script>

{#if yesterday !== undefined}
  <RelativeTime date={yesterday} tick={false} />
{/if}

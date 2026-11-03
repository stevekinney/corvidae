<script lang="ts" module>
  export const title = 'Absolute time with a relative tooltip';
  export const description =
    'format="absolute" always reads the clock ("Today, 10:44 AM", "Yesterday, 4:12 PM"), never relative, and the relative reading moves into the tooltip. Use it for an "Updated" column that has to name the moment.';
</script>

<script lang="ts">
  import { RelativeTime } from '@lostgradient/cinder';
  import { onMount } from 'svelte';

  // Read the clock in the browser, so the labels are relative to the reader's now.
  let moments = $state<{ label: string; date: Date }[]>([]);
  onMount(() => {
    const now = Date.now();
    moments = [
      { label: 'Updated', date: new Date(now - 2 * 60_000) },
      { label: 'Previous update', date: new Date(now - 26 * 3_600_000) },
      { label: 'First seen', date: new Date(now - 5 * 86_400_000) },
    ];
  });
</script>

<dl
  style="display: grid; grid-template-columns: max-content 1fr; gap: var(--cinder-space-1) var(--cinder-space-6); margin: 0; font-size: var(--cinder-text-sm);"
>
  {#each moments as moment (moment.label)}
    <dt style="color: var(--cinder-text-muted);">{moment.label}</dt>
    <dd style="margin: 0;"><RelativeTime date={moment.date} format="absolute" tick={false} /></dd>
  {/each}
</dl>

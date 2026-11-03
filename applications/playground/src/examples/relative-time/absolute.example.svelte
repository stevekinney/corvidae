<script lang="ts" module>
  export const title = 'Absolute time with a relative tooltip';
  export const description =
    'format="absolute" always reads the clock ("Today, 10:44 AM", "Sun Nov 1, 4:12 PM"), never relative: it says Today and names every other day, and the relative reading moves into the tooltip. Pass dayWords={true} to say Yesterday too. Use it for an "Updated" column that has to name the moment.';
</script>

<script lang="ts">
  import { RelativeTime } from '@lostgradient/cinder';
  import { onMount } from 'svelte';

  // Read the clock in the browser, so the labels are relative to the reader's today: this morning,
  // yesterday afternoon and five days ago.
  let moments = $state<{ label: string; date: Date }[]>([]);
  onMount(() => {
    const at = (daysAgo: number, hours: number, minutes: number) => {
      const date = new Date();
      date.setDate(date.getDate() - daysAgo);
      date.setHours(hours, minutes, 0, 0);
      return date;
    };
    moments = [
      { label: 'Updated', date: at(0, 10, 44) },
      { label: 'Previous update', date: at(1, 16, 12) },
      { label: 'First seen', date: at(5, 9, 20) },
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

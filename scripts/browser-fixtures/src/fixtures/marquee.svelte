<script lang="ts">
  import { Marquee } from '@lostgradient/cinder';

  let label = $state('Announcements');
</script>

<div id="example-mount-label">
  <label>
    Marquee label
    <input aria-label="label" bind:value={label} />
  </label>

  {#if label}
    <Marquee {label}>
      <span>Scheduled maintenance</span>
      <span>New team members</span>
      <span>Product updates</span>
    </Marquee>
  {:else}
    <Marquee>
      <span>Scheduled maintenance</span>
      <span>New team members</span>
      <span>Product updates</span>
    </Marquee>
  {/if}
</div>

<button id="before-scrolling-marquee" type="button">Before scrolling announcements</button>
<div id="example-mount-overflow" style:inline-size="20rem">
  <Marquee label="Scrollable announcements">
    <span>Scheduled maintenance for all regions.</span>
    <span>New team members joining this month.</span>
    <span>Product updates and release announcements.</span>
  </Marquee>
</div>

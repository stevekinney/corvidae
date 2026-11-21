<script lang="ts">
  import { Meter } from '@lostgradient/cinder';

  // The warning state is opt-in so the assertion fixture's established baseline stays unchanged.
  const warningIndicator =
    new URLSearchParams(globalThis.location.search).get('warning-indicator') === '1';
</script>

<div class="fixture-stack">
  {#if warningIndicator}
    <Meter value={20} max={100} low={30} high={70} ariaLabel="Storage used" />
  {:else}
    <Meter value={32} max={100} ariaLabel="Storage used" />
  {/if}
  <Meter value={68} max={100} ariaLabel="Project completion" />
  <Meter verdict={{ level: 'unknown', label: 'Unlimited quota' }} ariaLabel="Unlimited quota" />
</div>

<script lang="ts">
  import { default as Meter } from '@lostgradient/meter/components/meter/index.ts';
</script>

<div class="fixture-stack">
  <Meter value={32} max={100} ariaLabel="Storage used" />
  <Meter value={68} max={100} ariaLabel="Project completion" />
  <Meter verdict={{ level: 'unknown', label: 'Unlimited quota' }} ariaLabel="Unlimited quota" />
</div>

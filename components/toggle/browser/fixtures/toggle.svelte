<script lang="ts">
  import { default as Button } from '@lostgradient/button/components/button/index.ts';
  import { default as Toggle } from '@lostgradient/toggle/components/toggle/index.ts';
  let enabled = $state(false);
  let disabled = $state(false);
</script>

<div class="fixture-stack">
  <p>Live preview</p>
  <Toggle id="live-toggle" bind:checked={enabled} label="Email notifications" {disabled} />
  <p>Notifications are {enabled ? 'enabled' : 'disabled'}.</p>
  <Button onclick={() => (disabled = !disabled)}
    >{disabled ? 'Enable toggle' : 'Disable toggle'}</Button
  >
</div>

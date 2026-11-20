<script lang="ts">
  import { Backdrop, Button, Spinner, Stack } from '@lostgradient/cinder';

  let open = $state(false);
  let invisible = $state(false);
</script>

<Stack direction="row" gap="var(--cinder-space-3)" wrap>
  <Button
    label="Show dimmed backdrop"
    onclick={() => {
      invisible = false;
      open = true;
    }}
  />
  <Button
    variant="secondary"
    label="Show invisible backdrop"
    onclick={() => {
      invisible = true;
      open = true;
    }}
  />
</Stack>

<Backdrop {open} {invisible} onclick={() => (open = false)}>
  <Stack align="center" class="backdrop-fixture-stack text-default">
    <Spinner size="lg" label="Loading" />
    <span class="label-layout">Loading… click anywhere to dismiss</span>
  </Stack>
</Backdrop>

<style>
  :global(.backdrop-fixture-stack) {
    pointer-events: none;
  }

  .label-layout {
    font-size: var(--cinder-text-lg);
    font-weight: 500;
  }
</style>

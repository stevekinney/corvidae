<script lang="ts">
  import { Chip } from './index.ts';

  let suggestedPressed = $state(false);
  let plainPressed = $state(false);
</script>

<div class="chip-suggested-fixture">
  <div data-testid="suggested"><Chip label="@phone" suggested /></div>
  <div data-testid="plain"><Chip label="@phone" /></div>
  <div data-testid="suggested-toggle">
    <Chip
      mode="toggle"
      pressed={suggestedPressed}
      label="@phone"
      suggested
      onPressedChange={(pressed) => (suggestedPressed = pressed)}
    />
  </div>
  <div data-testid="plain-toggle">
    <Chip
      mode="toggle"
      pressed={plainPressed}
      label="@phone"
      onPressedChange={(pressed) => (plainPressed = pressed)}
    />
  </div>
</div>

<style>
  .chip-suggested-fixture {
    display: flex;
    flex-wrap: wrap;
    gap: var(--cinder-space-3);
    align-items: center;
  }
</style>

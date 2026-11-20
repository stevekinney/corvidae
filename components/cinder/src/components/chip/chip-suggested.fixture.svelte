<script lang="ts">
  import { Chip } from './index.ts';
</script>

<div class="chip-suggested-fixture">
  <div data-testid="suggested"><Chip label="@phone" suggested /></div>
  <div data-testid="plain"><Chip label="@phone" /></div>
  <div data-testid="suggested-toggle">
    <Chip mode="toggle" pressed={false} label="@phone" suggested />
  </div>
  <div data-testid="plain-toggle"><Chip mode="toggle" pressed={false} label="@phone" /></div>
</div>

<style>
  .chip-suggested-fixture {
    display: flex;
    flex-wrap: wrap;
    gap: var(--cinder-space-3);
    align-items: center;
  }
</style>

<script lang="ts">
  import { Toggle } from './index.ts';

  const longLabel =
    'Archive every receipt that arrives from the shop and file it under the quarter it was issued, so the accountant can find it without asking anyone';
</script>

<div class="toggle-alignment">
  <div class="toggle-alignment__column" data-testid="single-line">
    <Toggle id="alignment-single" label="Archive receipts" />
  </div>
  <div class="toggle-alignment__column" data-testid="long-label">
    <Toggle id="alignment-long" label={longLabel} />
  </div>
  <div class="toggle-alignment__column" data-testid="below">
    <Toggle
      id="alignment-below"
      label={longLabel}
      description="Runs every night."
      descriptionPlacement="below"
    />
  </div>
</div>

<style>
  .toggle-alignment {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
    padding: 1rem;
  }

  .toggle-alignment__column {
    inline-size: 16rem;
  }
</style>

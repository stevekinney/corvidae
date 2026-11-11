<script lang="ts">
  import { Checkbox } from './index.ts';

  const longLabel =
    'Archive every receipt that arrives from the shop and file it under the quarter it was issued, so the accountant can find it without asking anyone';
</script>

<div class="checkbox-alignment">
  <div class="checkbox-alignment__column" data-testid="single-line">
    <Checkbox id="alignment-single" label="Archive receipts" />
  </div>
  <div class="checkbox-alignment__column" data-testid="long-label">
    <Checkbox id="alignment-long" label={longLabel} />
  </div>
  <div class="checkbox-alignment__column" data-testid="task-long-label">
    <Checkbox id="alignment-task" variant="task" label={longLabel} />
  </div>
  <div class="checkbox-alignment__column" data-testid="described">
    <Checkbox id="alignment-described" label={longLabel} description="Runs every night." />
  </div>
  <div class="checkbox-alignment__column" data-testid="bare">
    <Checkbox id="alignment-bare" aria-label="Select this row" />
  </div>
</div>

<style>
  .checkbox-alignment {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
    padding: 1rem;
  }

  .checkbox-alignment__column {
    inline-size: 16rem;
  }
</style>

<script lang="ts">
  import { RadioGroup } from './index.ts';

  const longLabel =
    'Archive every receipt that arrives from the shop and file it under the quarter it was issued, so the accountant can find it without asking anyone';

  let choice = $state('short');
</script>

<div class="radio-alignment" data-testid="options">
  <RadioGroup name="alignment" label="Receipts" bind:value={choice}>
    <RadioGroup.Option id="alignment-short" value="short" label="Archive receipts" />
    <RadioGroup.Option id="alignment-long" value="long" label={longLabel} />
    <RadioGroup.Option
      id="alignment-described"
      value="described"
      label={longLabel}
      description="Runs every night."
    />
  </RadioGroup>
</div>

<style>
  .radio-alignment {
    inline-size: 16rem;
    padding: 1rem;
  }
</style>

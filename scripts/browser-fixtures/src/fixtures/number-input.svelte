<script lang="ts">
  import { NumberInput } from '@lostgradient/cinder';
</script>

<NumberInput id="number-input" label="Quantity" value={12} />

<!-- COR-2449 (AC8): a unit follows its number, at the field's own width and in a fixed-width box
     (the retention fields of Interborough sit in a 12rem box), and both numbers start on the edge
     the unit-less field's number starts on. -->
<div data-testid="number-input-units" class="number-input-units-layout gap-4 margin-block-start-4">
  <div data-testid="number-input-unit">
    <NumberInput id="number-input-unit" label="Timeout" value={15} adornment="seconds" />
  </div>
  <div data-testid="number-input-unit-fixed" class="number-input-unit-fixed-layout">
    <NumberInput id="number-input-unit-fixed" label="Keep for" value={90} adornment="days" />
  </div>
</div>

<style>
  .number-input-units-layout {
    display: grid;
    justify-items: start;
  }

  .number-input-unit-fixed-layout {
    inline-size: 12rem;
  }
</style>

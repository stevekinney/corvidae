<script lang="ts">
  import { DurationField } from './index.ts';
</script>

<div class="duration-field-alignment">
  <div class="duration-field-alignment__row" data-testid="wide">
    <DurationField id="wide-duration" label="Timeout" value={90_000} />
  </div>
  <div
    class="duration-field-alignment__row duration-field-alignment__row--squeezed"
    data-testid="squeezed"
  >
    <DurationField id="squeezed-duration" label="Timeout" value={90_000} />
  </div>
  <div class="duration-field-alignment__row" data-testid="fixed-unit">
    <DurationField
      id="fixed-duration"
      label="Timeout"
      value={90_000}
      unit="s"
      unitSelectable={false}
    />
  </div>
  <div class="duration-field-alignment__row" data-testid="large-number">
    <DurationField id="large-duration" label="Timeout" value={9_999_999_999_999} unit="ms" />
  </div>
</div>

<style>
  .duration-field-alignment {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-4);
    padding: var(--cinder-space-4);
  }

  .duration-field-alignment__row {
    inline-size: 32rem;
  }

  .duration-field-alignment__row--squeezed {
    inline-size: 12rem;
  }
</style>

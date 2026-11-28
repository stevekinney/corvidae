<script lang="ts">
  import { DurationField, type DurationUnit } from './index.ts';

  /** Units spelled out, as a workflow step's wait offers them: the widest unit select in use. */
  const WORD_UNITS: readonly DurationUnit[] = [
    { value: 'seconds', label: 'seconds', milliseconds: 1000 },
    { value: 'minutes', label: 'minutes', milliseconds: 60_000 },
    { value: 'hours', label: 'hours', milliseconds: 3_600_000 },
    { value: 'days', label: 'days', milliseconds: 86_400_000 },
  ];
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
  <!-- A workflow step's limit in its card on a 320px phone: a 254px row, an empty number with no
       placeholder, and units in words. The pair fits, so it stays on one line. -->
  <div
    class="duration-field-alignment__row duration-field-alignment__row--phone-card"
    data-testid="phone-card"
  >
    <DurationField
      id="phone-card-duration"
      label="Stop waiting after"
      size="sm"
      units={WORD_UNITS}
      unit="minutes"
      value={null}
    />
  </div>
  <!-- The same row with a number that may be unset: "Not set" is whole beside the unit. -->
  <div
    class="duration-field-alignment__row duration-field-alignment__row--phone-card"
    data-testid="phone-card-not-set"
  >
    <DurationField
      id="phone-card-not-set-duration"
      label="Timeout"
      value={null}
      placeholder="Not set"
    />
  </div>
  <div
    class="duration-field-alignment__row duration-field-alignment__row--squeezed"
    data-testid="squeezed-not-set"
  >
    <DurationField
      id="squeezed-not-set-duration"
      label="Timeout"
      value={null}
      placeholder="Not set"
    />
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
    inline-size: min(100%, calc(var(--cinder-content-width-narrow) * 0.8));
  }

  /* 160px: the number's cap, so no pair fits beside it. */
  .duration-field-alignment__row--squeezed {
    inline-size: min(100%, calc(var(--cinder-content-width-narrow) * 0.25));
  }

  /* 254px: a card's content width on a 320px phone. */
  .duration-field-alignment__row--phone-card {
    inline-size: min(100%, calc(var(--cinder-content-width-narrow) * 0.396875));
  }
</style>

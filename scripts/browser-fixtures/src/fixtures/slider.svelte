<script lang="ts">
  import { FormField, Select, Slider } from '@lostgradient/cinder';
  let value = $state(40);

  // COR-291: each row stacks a Slider directly below a Select — both take
  // the full row width, so a test can compare the Slider root's border box
  // to the Select's and expect the same left/right edges. This reproduces
  // the fretboard/octave-range bug report's "equal-width fields" layout,
  // where the Slider's thumb overhung past that shared edge at min/max.
  const adjacentOptions = [{ value: 'a', label: 'Option A' }] as const;

  // COR-327: headerVisible/displayValue fixtures. `compactSingle`/
  // `compactRange` are parent-owned ("controlled") state, mutated only by
  // the increment buttons below — exercising the same controlled pattern a
  // consuming app uses, and giving the browser test something to click to
  // prove `displayValue`'s output reacts to a value it didn't set itself.
  let compactSingle = $state(7);
  let compactRange = $state<[number, number]>([3, 19]);
  const singleDisplayValue = (nextValue: number) => `${nextValue} notes · C4–B4`;
  const rangeDisplayValue = ([low, high]: [number, number]) => `${low}–${high}`;
</script>

<div class="slider-fixture">
  <section id="example-mount-basic">
    <Slider
      label="Volume"
      {value}
      onValueChange={(next) => {
        value = next;
      }}
    />
    <p>Value: {value}</p>
  </section>

  <section id="example-mount-endpoint-min" class="slider-fixture__row">
    <Select id="endpoint-min-select" label="Adjacent control" options={adjacentOptions} value="a" />
    <Slider label="Minimum endpoint" min={0} max={100} value={0} />
  </section>

  <section id="example-mount-endpoint-max" class="slider-fixture__row">
    <Select id="endpoint-max-select" label="Adjacent control" options={adjacentOptions} value="a" />
    <Slider label="Maximum endpoint" min={0} max={100} value={100} />
  </section>

  <section id="example-mount-range-endpoints" class="slider-fixture__row">
    <Select
      id="range-endpoints-select"
      label="Adjacent control"
      options={adjacentOptions}
      value="a"
    />
    <Slider label="Octave range" mode="range" min={0} max={22} value={[0, 22]} />
  </section>

  <section id="example-mount-compact-single">
    <Slider
      label="Scale length"
      headerVisible={false}
      value={compactSingle}
      min={0}
      max={12}
      displayValue={singleDisplayValue}
      onValueChange={(next) => {
        compactSingle = next;
      }}
    />
    <button
      id="compact-single-increment"
      type="button"
      onclick={() => {
        compactSingle = Math.min(12, compactSingle + 1);
      }}
    >
      Increment
    </button>
  </section>

  <section id="example-mount-compact-range">
    <Slider
      label="Octave range (compact)"
      mode="range"
      headerVisible={false}
      value={compactRange}
      min={0}
      max={22}
      displayValue={rangeDisplayValue}
      onValueChange={(next) => {
        compactRange = next;
      }}
    />
    <button
      id="compact-range-increment"
      type="button"
      onclick={() => {
        compactRange = [compactRange[0], Math.min(22, compactRange[1] + 1)];
      }}
    >
      Increment high
    </button>
  </section>

  <section id="example-mount-compact-formfield">
    <FormField id="compact-formfield-scale" label="Scale length">
      <Slider
        label="Scale length"
        value={compactSingle}
        min={0}
        max={12}
        displayValue={singleDisplayValue}
        onValueChange={(next) => {
          compactSingle = next;
        }}
      />
    </FormField>
  </section>

  <section id="example-mount-compact-disabled">
    <Slider
      label="Scale length (disabled)"
      headerVisible={false}
      value={7}
      min={0}
      max={12}
      displayValue={singleDisplayValue}
      disabled
    />
  </section>
</div>

<style>
  .slider-fixture {
    display: grid;
    gap: 2rem;
    max-inline-size: 32rem;
  }

  .slider-fixture__row {
    display: grid;
    grid-template-columns: 1fr;
    gap: 1rem;
  }
</style>

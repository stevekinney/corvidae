<script lang="ts">
  import { Select, Slider } from '@lostgradient/cinder';
  let value = $state(40);

  // COR-291: each row stacks a Slider directly below a Select — both take
  // the full row width, so a test can compare the Slider root's border box
  // to the Select's and expect the same left/right edges. This reproduces
  // the fretboard/octave-range bug report's "equal-width fields" layout,
  // where the Slider's thumb overhung past that shared edge at min/max.
  const adjacentOptions = [{ value: 'a', label: 'Option A' }] as const;
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

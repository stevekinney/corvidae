<script lang="ts" module>
  export const title = 'Compact header with a formatted value';
  export const description =
    '`headerVisible={false}` hides the label span while the value keeps rendering; `displayValue` replaces the visible value text without touching the `aria-valuetext` announced to assistive technology.';
</script>

<script lang="ts">
  import { Slider } from '@lostgradient/cinder';
  let notes = $state(7);
  let octaves = $state<[number, number]>([0, 22]);
</script>

<div style="display: flex; flex-direction: column; gap: 1rem; max-width: 24rem;">
  <Slider
    label="Scale length"
    headerVisible={false}
    value={notes}
    min={0}
    max={12}
    displayValue={(value) => `${value} notes, C4–B4`}
    onValueChange={(next) => {
      notes = next;
    }}
  />
  <Slider
    label="Octave range"
    mode="range"
    headerVisible={false}
    value={octaves}
    min={0}
    max={22}
    displayValue={([low, high]) => `${low}–${high}`}
    onValueChange={(next) => {
      octaves = next;
    }}
  />
</div>

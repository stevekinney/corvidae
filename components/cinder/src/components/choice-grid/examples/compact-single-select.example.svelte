<script lang="ts" module>
  export const title = 'Compact single-select';
  export const description =
    '`size="sm"` shrinks each cell to Cinder\'s `button` `sm` scale (widening to a 44×44 touch target under a coarse pointer) and defaults `minColumnWidth` to `6rem`, so a dense set of short-label choices — like these twelve pitch classes — fits a narrow container without overflow.';
</script>

<script lang="ts">
  import { ChoiceGrid } from '@lostgradient/cinder';

  const notes = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  let selected = $state<string | null>(null);
</script>

<div style="max-width: 20rem;">
  <ChoiceGrid ariaLabel="Choose a root note" size="sm" bind:value={selected}>
    {#each notes as note (note)}
      <ChoiceGrid.Item value={note}>{note}</ChoiceGrid.Item>
    {/each}
  </ChoiceGrid>
</div>

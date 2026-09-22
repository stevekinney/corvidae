<script lang="ts">
  import { ChoiceGrid } from '@lostgradient/cinder';
  import type { ChoiceGridItemState } from '@lostgradient/cinder';

  let selected = $state<string | null>(null);

  // COR-330: compact `size="sm"` fixtures. `compactValue` is shared by the
  // single-select and states sections below so the "states don't change
  // dimensions" test can compare a selected/correct/incorrect cell against a
  // neutral one at the same size.
  let compactValue = $state<string | null>('c');
  let compactValues = $state<string[]>(['e2']);
  const notes = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const strings = ['E2', 'A2', 'D3', 'G3', 'B3', 'E4'];

  function stateFor(value: string): ChoiceGridItemState {
    if (value === 'correct-cell') return 'correct';
    if (value === 'incorrect-cell') return 'incorrect';
    return 'neutral';
  }
</script>

<div style="display: flex; flex-direction: column; gap: 2rem;">
  <ChoiceGrid ariaLabel="What is the capital of France?" bind:value={selected}>
    <ChoiceGrid.Item value="london">London</ChoiceGrid.Item>
    <ChoiceGrid.Item value="berlin">Berlin</ChoiceGrid.Item>
    <ChoiceGrid.Item value="paris">Paris</ChoiceGrid.Item>
    <ChoiceGrid.Item value="madrid">Madrid</ChoiceGrid.Item>
  </ChoiceGrid>

  <section id="example-mount-compact-single" style="max-width: 20rem;">
    <ChoiceGrid ariaLabel="Choose a root note" size="sm" bind:value={compactValue}>
      {#each notes as note (note)}
        <ChoiceGrid.Item value={note}>{note}</ChoiceGrid.Item>
      {/each}
    </ChoiceGrid>
  </section>

  <section id="example-mount-compact-multi" style="max-width: 20rem;">
    <ChoiceGrid multiple ariaLabel="Choose open strings" size="sm" bind:values={compactValues}>
      {#each strings as string (string)}
        <ChoiceGrid.Item value={string}>{string}</ChoiceGrid.Item>
      {/each}
    </ChoiceGrid>
  </section>

  <section id="example-mount-compact-states" style="max-width: 24rem;">
    <ChoiceGrid ariaLabel="Compact states" size="sm">
      <ChoiceGrid.Item value="neutral-cell">Neutral</ChoiceGrid.Item>
      <ChoiceGrid.Item value="correct-cell" state={stateFor('correct-cell')}
        >Correct</ChoiceGrid.Item
      >
      <ChoiceGrid.Item value="incorrect-cell" state={stateFor('incorrect-cell')}
        >Incorrect</ChoiceGrid.Item
      >
      <ChoiceGrid.Item value="disabled-cell" disabled>Disabled</ChoiceGrid.Item>
    </ChoiceGrid>
  </section>

  {#if selected}
    <p style="color: var(--cinder-text-muted); font-size: var(--cinder-text-sm);">
      Selected: {selected}
    </p>
  {/if}
</div>

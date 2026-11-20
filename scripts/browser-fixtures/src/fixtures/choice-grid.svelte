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

<div class="example-layout gap-8">
  <ChoiceGrid ariaLabel="What is the capital of France?" bind:value={selected}>
    <ChoiceGrid.Item value="london">London</ChoiceGrid.Item>
    <ChoiceGrid.Item value="berlin">Berlin</ChoiceGrid.Item>
    <ChoiceGrid.Item value="paris">Paris</ChoiceGrid.Item>
    <ChoiceGrid.Item value="madrid">Madrid</ChoiceGrid.Item>
  </ChoiceGrid>

  <section id="example-mount-compact-single" class="compact-single-layout">
    <ChoiceGrid ariaLabel="Choose a root note" size="sm" bind:value={compactValue}>
      {#each notes as note (note)}
        <ChoiceGrid.Item value={note}>{note}</ChoiceGrid.Item>
      {/each}
    </ChoiceGrid>
  </section>

  <section id="example-mount-compact-multi" class="compact-single-layout">
    <ChoiceGrid multiple ariaLabel="Choose open strings" size="sm" bind:values={compactValues}>
      {#each strings as string (string)}
        <ChoiceGrid.Item value={string}>{string}</ChoiceGrid.Item>
      {/each}
    </ChoiceGrid>
  </section>

  <section id="example-mount-compact-states" class="compact-states-layout">
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
    <p class="note-layout text-muted">
      Selected: {selected}
    </p>
  {/if}
</div>

<style>
  .example-layout {
    display: flex;
    flex-direction: column;
  }

  .compact-single-layout {
    max-width: 20rem;
  }

  .compact-states-layout {
    max-width: 24rem;
  }

  .note-layout {
    font-size: var(--cinder-text-sm);
  }
</style>

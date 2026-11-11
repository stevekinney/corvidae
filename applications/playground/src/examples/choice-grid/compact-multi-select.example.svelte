<script lang="ts" module>
  export const title = 'Compact multi-select';
  export const description =
    'The same `size="sm"` compaction applies to multi-select — cells stay the same size whether checked, hovered, focused, or disabled.';
</script>

<script lang="ts">
  import { ChoiceGrid } from '@lostgradient/cinder';

  const strings = ['E2', 'A2', 'D3', 'G3', 'B3', 'E4'];
  let selected = $state<string[]>([]);
</script>

<div style="max-width: 20rem;">
  <ChoiceGrid multiple ariaLabel="Choose open strings" size="sm" bind:values={selected}>
    {#each strings as string (string)}
      <ChoiceGrid.Item value={string}>{string}</ChoiceGrid.Item>
    {/each}
  </ChoiceGrid>
</div>

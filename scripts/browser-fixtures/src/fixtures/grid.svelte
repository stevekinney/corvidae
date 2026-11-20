<script lang="ts">
  import { Grid, GridItem } from '@lostgradient/cinder';

  const items = ['One', 'Two', 'Three', 'Four', 'Five', 'Six'];
</script>

<div class="grid-fixture gap-8">
  <div id="example-mount-narrow-collapse">
    <Grid columns={3} gap="1rem" narrowCollapseEnabled>
      {#each items as item}<div class="grid-cell">{item}</div>{/each}
    </Grid>
  </div>
  <div id="example-mount-bento-mosaic">
    <Grid columns={4} gap="1rem" narrowCollapseEnabled>
      <GridItem span={2} class="grid-cell">Alpha</GridItem>
      <GridItem class="grid-cell">Beta</GridItem>
      <GridItem class="grid-cell">Gamma</GridItem>
      <GridItem class="grid-cell">Delta</GridItem>
      <GridItem span={2} class="grid-cell">Epsilon</GridItem>
    </Grid>
  </div>
</div>

<style>
  .grid-fixture {
    display: grid;
    min-inline-size: 48rem;
  }
  .grid-cell {
    min-block-size: var(--cinder-space-16);
    padding: var(--cinder-space-4);
    background: var(--cinder-surface-raised, #eee);
  }
</style>

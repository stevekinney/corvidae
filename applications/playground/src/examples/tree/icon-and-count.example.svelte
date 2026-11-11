<script lang="ts" module>
  export const title = 'An icon or swatch and a count';
  export const description =
    'A row can carry a decorative swatch or icon and a right-aligned count. The name ellipsizes before it pushes the count out, and the counts align down the column.';
</script>

<script lang="ts">
  import { Tree } from '@lostgradient/cinder';

  let expandedIds = $state<string[]>(['labels']);
</script>

{#snippet swatch(color: string)}
  <span
    style="display: inline-block; inline-size: 0.75rem; block-size: 0.75rem; border-radius: 9999px; background: {color};"
  ></span>
{/snippet}

<div style="max-inline-size: 20rem;">
  <Tree aria-label="Labels" bind:expandedIds>
    <Tree.Item id="labels" label="Labels" branch count={42}>
      {#snippet icon()}{@render swatch('var(--cinder-accent-solid)')}{/snippet}
      <Tree.Item id="design" label="Design" count={12}>
        {#snippet icon()}{@render swatch('var(--cinder-status-info-solid)')}{/snippet}
      </Tree.Item>
      <Tree.Item
        id="long"
        label="A label with a very long name that has to ellipsize before the count"
        count={1280}
      >
        {#snippet icon()}{@render swatch('var(--cinder-status-success-solid)')}{/snippet}
      </Tree.Item>
      <Tree.Item id="bugs" label="Bugs" count={3}>
        {#snippet icon()}{@render swatch('var(--cinder-status-danger-solid)')}{/snippet}
      </Tree.Item>
    </Tree.Item>
  </Tree>
</div>

<script lang="ts">
  import { Tree } from '@repo/cinder';
  import IndeterminateParents from './tree/indeterminate-parents.svelte';
  import Virtualized from './tree/virtualized.svelte';

  let expandedIds = $state<string[]>(['fruit']);
</script>

<Tree aria-label="Pantry" bind:expandedIds>
  <Tree.Item id="fruit" label="Fruit" branch>
    <Tree.Item id="apple" label="Apple" />
    <Tree.Item id="banana" label="Banana" />
    <Tree.Item id="citrus" label="Citrus" branch>
      <Tree.Item id="lemon" label="Lemon" />
      <Tree.Item id="orange" label="Orange" />
    </Tree.Item>
  </Tree.Item>
  <Tree.Item id="grain" label="Grain" branch>
    <Tree.Item id="rice" label="Rice" />
    <Tree.Item id="wheat" label="Wheat" />
  </Tree.Item>
</Tree>

<div id="example-mount-indeterminate-parents"><IndeterminateParents /></div>
<div id="example-mount-virtualized"><Virtualized /></div>

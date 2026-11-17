<script lang="ts">
  import Tree from '../../components/tree/tree.svelte';
  import TreeItem from '../../components/tree-item/tree-item.svelte';
</script>

{#snippet swatch()}<i class="swatch"></i>{/snippet}

<Tree aria-label="Count fixture tree">
  <TreeItem id="red" label="Red" icon={swatch} count={12} />
  <TreeItem id="plain" label="Plain" />
</Tree>

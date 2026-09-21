<script lang="ts">
  import { Tree } from '@lostgradient/cinder';

  type TreeDataItem = { id: string; label: string };

  const items: TreeDataItem[] = Array.from({ length: 10_000 }, (_, index) => ({
    id: `virtual-file-${index}`,
    label: `Virtual file ${index}`,
  }));
</script>

<Tree
  aria-label="Virtualized files"
  {items}
  virtualized
  virtualizationEstimatedRowHeight={32}
  virtualizationHeight={320}
  style="border: 1px solid var(--cinder-border); border-radius: var(--cinder-radius-md);"
/>

<script lang="ts">
  import { default as Tree } from '@lostgradient/tree/components/tree/index.ts';

  let selectedIds = $state<string[]>(['february']);
  let expandedIds = $state<string[]>(['archive']);
</script>

<Tree
  aria-label="Archived reports"
  selectionMode="multiple"
  checkboxSelection
  selectionBehavior="cascade"
  bind:selectedIds
  bind:expandedIds
>
  <Tree.Item
    id="archive"
    label="archive"
    branch
    selectionScopeIds={['archive', 'january', 'february']}
  >
    <Tree.Item id="january" label="january.pdf" />
    <Tree.Item id="february" label="february.pdf" />
  </Tree.Item>
  <Tree.Item id="summary" label="summary.pdf" />
</Tree>

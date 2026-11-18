<script lang="ts">
  import { default as Button } from '@lostgradient/button/components/button/index.ts';
  import { default as EmptyState } from '@lostgradient/empty-state/components/empty-state/index.ts';
</script>

<EmptyState title="No results found" description="Try adjusting your filters or search query.">
  {#snippet action()}
    <Button variant="primary" label="Clear filters" />
  {/snippet}
</EmptyState>

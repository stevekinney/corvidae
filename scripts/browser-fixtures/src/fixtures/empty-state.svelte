<script lang="ts">
  import { Button, EmptyState } from '@corvidae/cinder';
</script>

<EmptyState title="No results found" description="Try adjusting your filters or search query.">
  {#snippet action()}
    <Button variant="primary" label="Clear filters" />
  {/snippet}
</EmptyState>

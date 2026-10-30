<script lang="ts" module>
  export const title = 'First use, filtered, and done';
  export const description =
    'Three reasons a view is empty: nothing yet, a filter hid everything, and all work finished.';
</script>

<script lang="ts">
  import { Button, EmptyState } from '@lostgradient/cinder';

  let cleared = $state(0);
</script>

<div style="display: grid; gap: 1.5rem;">
  <EmptyState
    kind="first-use"
    title="No runs yet"
    description="Start a workflow to see its runs here."
  >
    {#snippet action()}
      <Button variant="primary" label="Start a run" />
    {/snippet}
  </EmptyState>
  <EmptyState
    kind="filtered"
    title="No runs match"
    description="Nothing matches the current filters. Clear them to see every run."
    onClearFilters={() => (cleared += 1)}
  />
  <p>Filters cleared {cleared} times.</p>
  <EmptyState kind="done" title="All caught up" description="Every approval has been answered." />
</div>

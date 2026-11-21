<script lang="ts">
  /**
   * EmptyState with the same actions in a wide surface and a narrow column.
   */
  import { Button } from '../button/index.ts';
  import { EmptyState } from './index.ts';
</script>

{#snippet openHealth()}
  <Button variant="secondary" size="sm" label="Open Health" href="#health" />
{/snippet}

<div class="empty-state-row-action">
  {#each [{ name: 'wide' }, { name: 'narrow' }] as column (column.name)}
    <div class="column" data-column={column.name} data-testid={`column-${column.name}`}>
      <div data-testid="empty-row">
        <EmptyState
          kind="done"
          headingLevel={3}
          title="Nothing needs attention"
          description="Storage, schedules, providers and hooks are fine."
          action={openHealth}
        />
      </div>
    </div>
  {/each}
</div>

<style>
  .empty-state-row-action {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-6);
    padding: var(--cinder-space-4);
  }

  .column {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-3);
  }

  .column[data-column='narrow'] {
    max-inline-size: calc(var(--cinder-content-width-narrow) / 2);
  }
</style>

<script lang="ts">
  /**
   * An EmptyState row with its action beside an ErrorState row with its retry, at the full width
   * and in a 22rem column, so the two rows can be seen and measured placing their action alike: at
   * the end of the line when wide, and on a line of their own on the same trailing edge when narrow
   * (COR-2489, COR-2394).
   */
  import { Button } from '../button/index.ts';
  import { ErrorState } from '../error-state/index.ts';
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
          layout="row"
          headingLevel={3}
          title="Nothing needs attention"
          description="Storage, schedules, providers and hooks are fine."
          action={openHealth}
        />
      </div>
      <div data-testid="error-row">
        <ErrorState
          variant="row"
          title="Couldn’t load system problems."
          description="The rest of the page is live."
          onRetry={() => {}}
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

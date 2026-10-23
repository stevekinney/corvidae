<script lang="ts">
  /**
   * The run's search attributes (COR-1461): every key `weft.workflows.attributes.get` returns, and,
   * for a principal holding `attributes:write`, an editor on each key the run already has. Without
   * `attributes:read` the section does not render at all, and nothing is read.
   *
   * A run with no attribute record answers `NotFound`; the section renders `data-state="empty"` then
   * (`readAttributes`). A rejected `set` shows its fault in the page's fault banner and leaves what
   * the page displays as it was: the displayed values only ever come from a read.
   */
  import { Skeleton } from '@lostgradient/cinder';
  import { createQuery, useQueryClient } from '@tanstack/svelte-query';

  import { RUN_DETAIL_COPY } from '../../../../app/copy.ts';
  import { faultTreatment, type FaultTreatment } from '../../../../lib/faults.ts';
  import RunFaultBanner from '../run-fault-banner.svelte';
  import AttributeRow from './attribute-row.svelte';
  import {
    attributesQueryKey,
    readAttributes,
    setAttribute,
    type AttributesClient,
    type AttributeValue,
  } from './attributes-data.ts';

  interface AttributesPanelProps {
    readonly client: AttributesClient;
    readonly workflowId: string;
    /** Whether the principal holds `attributes:read`. Without it the section does not render. */
    readonly canRead: boolean;
    /** Whether the principal holds `attributes:write`. Without it no edit control renders. */
    readonly canWrite: boolean;
  }

  let { client, workflowId, canRead, canWrite }: AttributesPanelProps = $props();

  const copy = RUN_DETAIL_COPY.attributes;
  const queryClient = useQueryClient();

  const query = createQuery(() => ({
    queryKey: attributesQueryKey(workflowId),
    queryFn: () => readAttributes(client, workflowId),
    enabled: canRead,
  }));

  let saveFault = $state<FaultTreatment | null>(null);

  async function save(key: string, value: AttributeValue): Promise<boolean> {
    saveFault = null;
    try {
      await setAttribute(client, workflowId, key, value);
    } catch (error) {
      saveFault = faultTreatment(error);
      return false;
    }
    // What the page shows afterwards is what a fresh read returns, not what was typed.
    await queryClient.invalidateQueries({ queryKey: attributesQueryKey(workflowId) });
    return true;
  }

  const viewState = $derived(
    query.isError
      ? 'error'
      : query.isPending
        ? 'loading'
        : query.data?.kind === 'present'
          ? 'ready'
          : 'empty',
  );
  const headingId = $derived(`weft-attributes-${workflowId}-heading`);
</script>

{#if canRead}
  <section class="weft-attributes" aria-labelledby={headingId} data-state={viewState}>
    <h3 id={headingId} class="weft-attributes__heading">{copy.heading}</h3>

    {#if query.isError}
      <RunFaultBanner treatment={faultTreatment(query.error)} />
    {:else if query.isPending}
      <div aria-busy="true" aria-label={copy.loading}><Skeleton height="3rem" /></div>
    {:else if query.data?.kind === 'present'}
      {#if saveFault !== null}
        <RunFaultBanner treatment={saveFault} />
      {/if}
      <ul class="weft-attributes__list">
        {#each query.data.entries as entry (entry.key)}
          <AttributeRow {entry} {canWrite} onSave={save} />
        {/each}
      </ul>
    {:else}
      <p class="weft-attributes__empty">{copy.empty}</p>
    {/if}
  </section>
{/if}

<style>
  /* The same panel the Overview tab's other sections are. */
  .weft-attributes {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 0 var(--cinder-density-pad-inline) var(--cinder-density-pad-block);
    background: var(--cinder-surface-raised);
    border: 1px solid var(--cinder-border);
    border-radius: var(--cinder-radius-lg);
  }

  .weft-attributes__heading {
    margin: 0 -15px;
    padding: var(--cinder-density-pad-block) var(--cinder-density-pad-inline);
    border-bottom: 1px solid var(--cinder-border-muted);
    font-size: var(--cinder-text-sm);
    font-weight: 600;
  }

  .weft-attributes__list {
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }

  .weft-attributes__empty {
    margin: 0;
    font-size: var(--cinder-text-sm);
    color: var(--cinder-text-subtle);
  }
</style>

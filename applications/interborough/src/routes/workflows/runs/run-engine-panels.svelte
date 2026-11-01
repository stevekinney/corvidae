<script lang="ts">
  /**
   * What else the workflow engine holds about a run: its search attributes, the worker version it
   * is bound to, and its lineage (the schedule that launched it, the run it replaced, the run it
   * was forked from). The runs it started and the run that started it are in the Details rail.
   * Each reads with its own scope: search attributes need `attributes:read` (and
   * `attributes:write` to edit), and the rest need only the read of the run.
   */
  import type { WorkflowState } from '@lostgradient/weft';

  import { RUN_PAGE_COPY } from '../../../app/copy.ts';
  import { getPrincipalStore } from '../../../lib/scopes.svelte.ts';
  import AttributesPanel from '../detail/attributes/attributes-panel.svelte';
  import type { AttributesClient } from '../detail/attributes/attributes-data.ts';
  import LineagePanel from '../detail/lineage-panel.svelte';
  import WorkerBindingPanel from '../detail/worker-binding-panel.svelte';
  import type { RunEngine } from './run-engine.svelte.ts';

  interface RunEnginePanelsProps {
    engine: RunEngine;
    workflow: WorkflowState;
  }

  let { engine, workflow }: RunEnginePanelsProps = $props();

  const principal = getPrincipalStore();
  const canRead = $derived(principal.hasScope('attributes:read'));
  const canWrite = $derived(principal.hasScope('attributes:write'));

  // Present only on an engine that offers both operations.
  const attributesClient = $derived.by((): AttributesClient | undefined => {
    const get = engine.client.operations['weft.workflows.attributes.get'];
    const set = engine.client.operations['weft.workflows.attributes.set'];
    return get === undefined || set === undefined
      ? undefined
      : {
          operations: {
            'weft.workflows.attributes.get': get,
            'weft.workflows.attributes.set': set,
          },
        };
  });
</script>

<section
  class="ib-run__section ib-run__panels"
  aria-label={RUN_PAGE_COPY.attributesAndWorkerLabel}
  data-section="engine-panels"
>
  {#if attributesClient !== undefined}
    <AttributesPanel client={attributesClient} workflowId={workflow.id} {canRead} {canWrite} />
  {/if}
  <WorkerBindingPanel {workflow} />
</section>

<LineagePanel client={engine.client} {workflow} />

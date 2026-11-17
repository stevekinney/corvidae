<script lang="ts">
  /**
   * What else the workflow engine holds about a run, as the run page's tabs draw it (COR-2424, row
   * 54i): `versioning` is the worker version the run is bound to and its lineage (the run it
   * replaced, the run it was forked from), and `attributes` is its search attributes. The runs it
   * started and the run that started it are in the Details rail. Search attributes need
   * `attributes:read` (and `attributes:write` to edit); the rest need only the read of the run.
   */
  import type { WorkflowState } from '@lostgradient/weft';

  import { RUN_PAGE_COPY } from '../../../app/copy/runs.ts';
  import { getPrincipalStore } from '../../../lib/scopes.svelte.ts';
  import AttributesPanel from '../detail/attributes/attributes-panel.svelte';
  import LineagePanel from '../detail/lineage-panel.svelte';
  import WorkerBindingPanel from '../detail/worker-binding-panel.svelte';
  import { attributesClientOf } from './run-engine-attributes.ts';
  import type { RunEngine } from './run-engine.svelte.ts';

  interface RunEnginePanelsProps {
    engine: RunEngine;
    workflow: WorkflowState;
    /** Which of the engine's panels to draw. */
    part: 'versioning' | 'attributes';
  }

  let { engine, workflow, part }: RunEnginePanelsProps = $props();

  const principal = getPrincipalStore();
  const canRead = $derived(principal.hasScope('attributes:read'));
  const canWrite = $derived(principal.hasScope('attributes:write'));
  const attributesClient = $derived(attributesClientOf(engine.client));
</script>

{#if part === 'attributes'}
  {#if attributesClient !== undefined}
    <section
      class="ib-run__section ib-run__panels"
      aria-label={RUN_PAGE_COPY.attributesAndWorkerLabel}
      data-section="engine-panels"
    >
      <AttributesPanel client={attributesClient} workflowId={workflow.id} {canRead} {canWrite} />
    </section>
  {/if}
{:else}
  <section class="ib-run__section ib-run__panels" data-section="versioning">
    <WorkerBindingPanel {workflow} />
  </section>
  <LineagePanel client={engine.client} {workflow} />
{/if}

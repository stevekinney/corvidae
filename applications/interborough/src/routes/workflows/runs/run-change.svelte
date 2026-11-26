<script lang="ts">
  /**
   * Change or ask this run, in place: send it a signal, send it an update and wait for the result,
   * or ask it a question. Each is a form that opens under its own button, with no dialog and no
   * other page, and each is gated on its own scope (`signals:write`, `updates:write`,
   * `queries:read`): a caller without one sees the form disabled and told which scope it needs.
   * The signals and updates the run has already received are listed with their forms.
   */
  import { Collapsible, Section } from '@lostgradient/cinder';
  import type { WorkflowReadState as WorkflowState } from '../../../lib/client.ts';

  import { RUN_PAGE_COPY } from '../../../app/copy/runs.ts';
  import { getPrincipalStore, scopeGate } from '../../../lib/scopes.svelte.ts';
  import SignalsTab from '../detail/signals-tab.svelte';
  import UpdatesTab from '../detail/updates-tab.svelte';
  import RunQuery from './run-query.svelte';
  import type { RunEngine } from './run-engine.svelte.ts';

  interface RunChangeProps {
    engine: RunEngine;
    workflow: WorkflowState;
  }

  let { engine, workflow }: RunChangeProps = $props();

  const principal = getPrincipalStore();
  const signalGate = $derived(scopeGate(principal, ['signals:write']));
  const queryGate = $derived(scopeGate(principal, ['queries:read']));
  const canSendUpdates = $derived(principal.hasScope('updates:write'));

  let signalOpen = $state(false);
  let updateOpen = $state(false);
  let queryOpen = $state(false);
</script>

<Section
  title={RUN_PAGE_COPY.changeHeading}
  description={RUN_PAGE_COPY.changeIntro}
  data-section="change"
>
  <div class="ib-run__disclosures ib-run__change">
    <Collapsible bind:open={signalOpen} variant="flat" trigger={RUN_PAGE_COPY.signal.label}>
      <p class="ib-run__note">{RUN_PAGE_COPY.signal.hint}</p>
      <SignalsTab client={engine.client} {workflow} sendGate={signalGate} />
    </Collapsible>
    <Collapsible bind:open={updateOpen} variant="flat" trigger={RUN_PAGE_COPY.update.label}>
      <p class="ib-run__note">{RUN_PAGE_COPY.update.hint}</p>
      <UpdatesTab client={engine.client} {workflow} canSend={canSendUpdates} />
    </Collapsible>
    <Collapsible bind:open={queryOpen} variant="flat" trigger={RUN_PAGE_COPY.query.label}>
      <p class="ib-run__note">{RUN_PAGE_COPY.query.hint}</p>
      <RunQuery onRunQuery={(name, input) => engine.runQuery(name, input)} gate={queryGate} />
    </Collapsible>
  </div>
</Section>

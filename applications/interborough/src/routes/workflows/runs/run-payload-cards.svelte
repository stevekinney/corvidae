<script lang="ts">
  /**
   * A workflow run's input and its output as two payload cards side by side, both of the one
   * inspector and sharing one Fields or JSON choice: the engine's input and result, or the Bureau's
   * record of a workflow file's run (its trigger and result). Output says why there is none when the
   * run failed, ended without one, or is still going. Drawn under Input and output for a run of a
   * workflow, and under How it ran, as the raw payloads, for a run that answered a chat.
   */
  import type { WorkflowState } from '@lostgradient/weft';

  import { RUN_DETAIL_COPY } from '../../../app/copy.ts';
  import type { WorkflowFileRunDetail } from '../../../lib/workflow-files.ts';
  import RunPayload from './run-payload.svelte';

  interface RunPayloadCardsProps {
    /** The engine's run. */
    workflow?: WorkflowState | undefined;
    /** The Bureau's record of a workflow file's run, when the engine does not hold it. */
    record?: WorkflowFileRunDetail | undefined;
  }

  let { workflow, record }: RunPayloadCardsProps = $props();

  const copy = RUN_DETAIL_COPY.io;
  const endedWords = $derived(workflow?.status === 'cancelled' ? 'was cancelled' : 'timed out');
</script>

{#if workflow !== undefined || record !== undefined}
  <div class="ib-run__payloads">
    <RunPayload
      value={workflow !== undefined ? workflow.input : record?.trigger}
      label={copy.input}
    />
    {#if workflow !== undefined}
      {#if workflow.status === 'completed'}
        <RunPayload value={workflow.result} label={copy.output} />
      {:else}
        <section class="ib-run__payload-card" aria-label={copy.output}>
          <header class="ib-run__payload-header">
            <h3 class="ib-run__heading-3">{copy.output}</h3>
          </header>
          {#if workflow.status === 'failed'}
            <p class="ib-run__note">{copy.noOutputFailed}</p>
          {:else if workflow.status === 'cancelled' || workflow.status === 'timed-out'}
            <p class="ib-run__note">{copy.noOutputEnded(endedWords)}</p>
          {:else}
            <p class="ib-run__note">
              <span class="ib-run__spinner" aria-hidden="true"></span>
              {copy.appearsWhenFinished}
            </p>
          {/if}
        </section>
      {/if}
    {:else if record !== undefined}
      {#if record.result !== undefined && record.result !== null}
        <RunPayload value={record.result} label={copy.output} />
      {/if}
    {/if}
  </div>
{/if}

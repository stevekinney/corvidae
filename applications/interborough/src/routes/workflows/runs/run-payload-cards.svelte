<script lang="ts">
  /**
   * A workflow run's input and its output as two payload cards side by side, both of the one
   * inspector and sharing one Fields or JSON choice: the engine's input and result, or the Bureau's
   * record of a workflow file's run (its trigger and result). Output says why there is none when the
   * run failed, ended without one, or is still going. Drawn under Input and output for a run of a
   * workflow, and under How it ran, as the raw payloads, for a run that answered a chat.
   *
   * A workflow file that names what it produces (`outputName`, COR-2424) has its Output card read
   * "Output, `notes`", and a run that failed at a step says that name was never produced (rows 54p,
   * 55c). A file without one reads "Output".
   */
  import { Spinner } from '@lostgradient/cinder';
  import type { WorkflowState } from '@lostgradient/weft';

  import { RUN_DETAIL_COPY } from '../../../app/copy/runs.ts';
  import type { WorkflowFileRunDetail } from '../../../lib/workflow-files.ts';
  import RunPayload from './run-payload.svelte';

  interface RunPayloadCardsProps {
    /** The engine's run. */
    workflow?: WorkflowState | undefined;
    /** The Bureau's record of a workflow file's run, when the engine does not hold it. */
    record?: WorkflowFileRunDetail | undefined;
    /** The step a failed run failed at, counted from one, when its history says. */
    failedAt?: number | undefined;
  }

  let { workflow, record, failedAt = undefined }: RunPayloadCardsProps = $props();

  const copy = RUN_DETAIL_COPY.io;
  const endedWords = $derived(workflow?.status === 'cancelled' ? 'was cancelled' : 'timed out');
  // What the version the run ran calls its output, from the Bureau's record of the run.
  const outputName = $derived(
    record?.outputName === null || record?.outputName === undefined || record.outputName === ''
      ? undefined
      : record.outputName,
  );
  const failedWords = $derived(
    outputName !== undefined && failedAt !== undefined
      ? copy.noOutputFailedAt(failedAt, outputName)
      : copy.noOutputFailed,
  );
</script>

{#if workflow !== undefined || record !== undefined}
  <div class="ib-run__payloads">
    <RunPayload
      value={workflow !== undefined ? workflow.input : record?.trigger}
      label={copy.input}
      ownRunId={workflow?.id ?? record?.id}
    />
    {#if workflow !== undefined}
      {#if workflow.status === 'completed'}
        <RunPayload value={workflow.result} label={copy.output} labelCode={outputName} />
      {:else}
        <section
          class="ib-run__payload-card"
          aria-label={outputName === undefined ? copy.output : `${copy.output}, ${outputName}`}
        >
          <header class="ib-run__payload-title-row">
            <h3 class="ib-run__heading-3">
              {copy.output}{#if outputName !== undefined}, <code class="ib-identifier"
                  >{outputName}</code
                >{/if}
            </h3>
          </header>
          {#if workflow.status === 'failed'}
            <p class="ib-run__note">{failedWords}</p>
          {:else if workflow.status === 'cancelled' || workflow.status === 'timed-out'}
            <p class="ib-run__note">{copy.noOutputEnded(endedWords)}</p>
          {:else}
            <!-- Cinder's spinner, hidden from assistive technology: the sentence says it all. -->
            <p class="ib-run__note">
              <span aria-hidden="true"><Spinner size="sm" /></span>
              {copy.appearsWhenFinished}
            </p>
          {/if}
        </section>
      {/if}
    {:else if record !== undefined}
      {#if record.result !== undefined && record.result !== null}
        <RunPayload value={record.result} label={copy.output} labelCode={outputName} />
      {/if}
    {/if}
  </div>
{/if}

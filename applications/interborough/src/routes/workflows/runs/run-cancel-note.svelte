<script lang="ts">
  /**
   * Where a run's cancellation stands, in words: the task's own `cleanup` once it has one and the
   * receipt of the last cancel until then, a refusal that names the run's owner, and a failure. It
   * is the status line of the page, so the header draws it under the title and never among the
   * actions (`run-header.svelte`); `RunCancel` draws it itself where no header does.
   */
  import { Alert } from '@lostgradient/cinder';

  import { TASK_COPY } from '../../../app/copy.ts';
  import type { TaskCancelAnswer, TaskCancelReceipt, TaskView } from '../../../lib/bureau-tasks.ts';

  interface RunCancelNoteProps {
    task: TaskView;
    receipt?: TaskCancelReceipt | undefined;
    rejection?: TaskCancelAnswer['reason'];
    failure?: string | undefined;
  }

  let { task, receipt, rejection, failure }: RunCancelNoteProps = $props();

  const words = $derived(task.cleanup ?? receipt);
  // A refusal that names its owner says so, instead of claiming the run had finished.
  const refusal = $derived(
    task.cleanup === null && receipt === 'rejected' && rejection !== undefined
      ? rejection
      : undefined,
  );
</script>

{#if words !== undefined || failure !== undefined}
  <div class="ib-run__cancel-note">
    {#if words !== undefined}
      <p role="status" data-cleanup={words}>
        {refusal === 'owned-by-goal' || refusal === 'owned-by-workflow'
          ? TASK_COPY.cancelOwned[refusal]
          : TASK_COPY.cancel[words]}
      </p>
    {/if}
    {#if failure !== undefined}
      <Alert variant="danger"><p>{TASK_COPY.cancelFailed}: {failure}</p></Alert>
    {/if}
  </div>
{/if}

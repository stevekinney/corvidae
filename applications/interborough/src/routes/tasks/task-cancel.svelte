<script lang="ts">
  /**
   * Cancelling a task, and where the cancellation stands. A cancel is often an asking: the receipt
   * says the task has not stopped yet, and the task's own `cleanup` carries on from there, so the
   * words below are the task's `cleanup` once it has one and the receipt until then. The page reads
   * the task again while the cancellation is still being carried out (`task-detail.svelte`).
   */
  import { Alert, Button } from '@lostgradient/cinder';
  import { useQueryClient } from '@tanstack/svelte-query';

  import { TASK_COPY } from '../../app/copy.ts';
  import {
    cancelTask,
    isTerminalState,
    type TaskCancelReceipt,
    type TaskView,
  } from '../../lib/bureau-tasks.ts';
  import { faultTreatment } from '../../lib/faults.ts';
  import { queryKeys } from '../../lib/query.ts';

  interface TaskCancelProps {
    task: TaskView;
  }

  let { task }: TaskCancelProps = $props();

  const queryClient = useQueryClient();

  let receipt = $state<TaskCancelReceipt | undefined>(undefined);
  let cancelling = $state(false);
  let failure = $state<string | undefined>(undefined);

  const standing = $derived(task.cleanup ?? receipt);
  const canCancel = $derived(!isTerminalState(task.status) && task.cleanup === null);

  async function cancel(): Promise<void> {
    cancelling = true;
    failure = undefined;
    try {
      const answer = await cancelTask(task.id);
      receipt = answer.receipt;
      if (answer.task !== undefined) {
        queryClient.setQueryData(queryKeys.bureauTasks.detail(task.id), answer.task);
      } else {
        await queryClient.invalidateQueries({ queryKey: queryKeys.bureauTasks.detail(task.id) });
      }
      // A canceled task no longer waits for anyone, so the reviews that listed it are stale.
      void queryClient.invalidateQueries({ queryKey: ['bureau-reviews'] });
      void queryClient.invalidateQueries({ queryKey: ['bureau-tasks', 'list'] });
    } catch (error) {
      failure = faultTreatment(error).message;
    } finally {
      cancelling = false;
    }
  }
</script>

{#if canCancel || standing !== undefined || failure !== undefined}
  <section class="weft-task__section" aria-labelledby="weft-task-cancel-title">
    <h2 id="weft-task-cancel-title" class="weft-task__heading">{TASK_COPY.cancelHeading}</h2>
    {#if standing !== undefined}
      <p class="weft-task__cancel-status" role="status" data-cleanup={standing}>
        {TASK_COPY.cancel[standing]}
      </p>
    {/if}
    {#if failure !== undefined}
      <Alert variant="danger">
        <p class="weft-task-wait__failure-title">{TASK_COPY.cancelFailed}</p>
        <p class="weft-task-wait__failure">{failure}</p>
      </Alert>
    {/if}
    {#if canCancel}
      <Button
        variant="danger"
        label={TASK_COPY.cancelAction}
        loading={cancelling}
        disabled={cancelling}
        onclick={() => void cancel()}
      />
    {/if}
  </section>
{/if}

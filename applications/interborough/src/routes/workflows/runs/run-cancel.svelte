<script lang="ts">
  /**
   * Cancelling a run, after a confirmation, and where the cancellation stands. A cancel is often an
   * asking: the receipt says the run has not stopped yet, and the task's own `cleanup` carries on
   * from there, so the words under the header are the task's `cleanup` once it has one and the
   * receipt until then. The page reads the task again while the cancellation is still being carried
   * out (`run-detail.svelte`). The button is the header's own, so it sits beside Open chat.
   */
  import { Alert, Button, ConfirmDialog } from '@lostgradient/cinder';
  import { useQueryClient } from '@tanstack/svelte-query';

  import { TASK_COPY } from '../../../app/copy.ts';
  import {
    cancelTask,
    isOwnedElsewhere,
    isTerminalState,
    type TaskCancelAnswer,
    type TaskCancelReceipt,
    type TaskView,
  } from '../../../lib/bureau-tasks.ts';
  import { faultTreatment } from '../../../lib/faults.ts';
  import { queryKeys } from '../../../lib/query.ts';

  interface RunCancelProps {
    task: TaskView;
  }

  let { task }: RunCancelProps = $props();

  const queryClient = useQueryClient();

  let receipt = $state<TaskCancelReceipt | undefined>(undefined);
  let rejection = $state<TaskCancelAnswer['reason']>(undefined);
  let cancelling = $state(false);
  let confirming = $state(false);
  let failure = $state<string | undefined>(undefined);

  // An attempt of a goal and a step of a workflow stop with the goal or the workflow that owns
  // them, so there is nothing to ask of the run itself.
  const canCancel = $derived(
    !isTerminalState(task.status) && task.cleanup === null && !isOwnedElsewhere(task),
  );

  async function cancel(): Promise<void> {
    confirming = false;
    cancelling = true;
    failure = undefined;
    try {
      const answer = await cancelTask(task.id);
      receipt = answer.receipt;
      rejection = answer.reason;
      if (answer.task !== undefined) {
        queryClient.setQueryData(queryKeys.bureauTasks.detail(task.id), answer.task);
      } else {
        await queryClient.invalidateQueries({ queryKey: queryKeys.bureauTasks.detail(task.id) });
      }
      // A canceled run no longer waits for anyone, so the reviews that listed it are stale.
      void queryClient.invalidateQueries({ queryKey: ['bureau-reviews'] });
      void queryClient.invalidateQueries({ queryKey: ['bureau-tasks'] });
    } catch (error) {
      failure = faultTreatment(error).message;
    } finally {
      cancelling = false;
    }
  }
  const words = $derived(task.cleanup ?? receipt);
  // A refusal that names its owner says so, instead of claiming the run had finished.
  const refusal = $derived(
    task.cleanup === null && receipt === 'rejected' && rejection !== undefined
      ? rejection
      : undefined,
  );
</script>

{#if canCancel}
  <Button
    data-changes
    variant="secondary"
    label={TASK_COPY.cancelAction}
    loading={cancelling}
    disabled={cancelling}
    onclick={() => (confirming = true)}
  />
  <ConfirmDialog
    open={confirming}
    title={TASK_COPY.cancelConfirm.title}
    description={TASK_COPY.cancelConfirm.description}
    confirmLabel={TASK_COPY.cancelAction}
    cancelLabel={TASK_COPY.cancelConfirm.keep}
    destructive
    onConfirm={() => void cancel()}
    onCancel={() => (confirming = false)}
  />
{/if}
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

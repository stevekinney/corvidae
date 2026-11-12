<script lang="ts">
  /**
   * Cancelling a run, after a confirmation, and where the cancellation stands. A cancel is often an
   * asking: the receipt says the run has not stopped yet, and the task's own `cleanup` carries on
   * from there, so the words under the header are the task's `cleanup` once it has one and the
   * receipt until then. The page reads the task again while the cancellation is still being carried
   * out (`run-detail.svelte`). The button is the header's own, so it sits beside Open chat.
   */
  import { Button, ConfirmDialog } from '@lostgradient/cinder';
  import { useQueryClient } from '@tanstack/svelte-query';

  import { TASK_COPY } from '../../../app/copy/tasks.ts';
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
  import RunCancelNote from './run-cancel-note.svelte';

  interface RunCancelProps {
    task: TaskView;
    /**
     * Whether to say where the cancellation stands, under the button. The header says it once; a
     * second Cancel run elsewhere on the page leaves it there.
     */
    showStatus?: boolean;
    /**
     * Where the cancellation stands, for a page that says it elsewhere (the header says it under
     * the title, not among its actions): what the last cancel answered, why it was refused, and
     * why it failed. Bind them to a `RunCancelNote`.
     */
    receipt?: TaskCancelReceipt | undefined;
    rejection?: TaskCancelAnswer['reason'];
    failure?: string | undefined;
  }

  let {
    task,
    showStatus = true,
    receipt = $bindable(undefined),
    rejection = $bindable(undefined),
    failure = $bindable(undefined),
  }: RunCancelProps = $props();

  const queryClient = useQueryClient();

  let cancelling = $state(false);
  let confirming = $state(false);

  // An attempt of a goal is stopped by its goal, and a step of a workflow is not canceled on its own
  // (the Bureau refuses it), so there is nothing to ask of the run itself.
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
{#if showStatus}
  <RunCancelNote {task} {receipt} {rejection} {failure} />
{/if}

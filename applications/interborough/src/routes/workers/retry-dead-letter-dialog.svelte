<script lang="ts">
  /**
   * Plain confirmation for retrying a dead letter. A retry puts the task back in its queue under the
   * same id for a worker to claim again, so it asks for a yes, not for the id typed back: nothing is
   * deleted, and the failed attempt stays in the task's history. What the person needs to hear is
   * that the activity will run again and may repeat what it did the first time.
   */
  import { ConfirmDialog } from '@lostgradient/cinder';

  import type { DeadLetterTarget } from './dead-letter-guard.ts';
  import { exactTimestamp } from './task-attempt-evidence.ts';

  interface RetryDeadLetterDialogProps {
    readonly open: boolean;
    /** The dead letter this retries, as it was listed when the dialog opened. */
    readonly target: DeadLetterTarget;
    readonly submitting: boolean;
    readonly onConfirm: () => void;
    readonly onCancel: () => void;
  }

  let {
    open = $bindable(),
    target,
    submitting,
    onConfirm,
    onCancel,
  }: RetryDeadLetterDialogProps = $props();

  const description = $derived(
    [
      `Queues ${target.activityName ?? 'the task'} on queue ${target.queue} again under the same ID (task ${target.operationId}) as a new attempt.`,
      target.deadLetteredAt === undefined
        ? undefined
        : `It failed for good at ${exactTimestamp(target.deadLetteredAt)}.`,
      'A worker will run the activity again, so anything it did the first time may happen twice. The failed attempt stays in the task history, and the retained result is replaced.',
    ]
      .filter((sentence) => sentence !== undefined)
      .join(' '),
  );
</script>

<ConfirmDialog
  bind:open
  title="Retry dead letter"
  {description}
  confirmLabel={submitting ? 'Retrying…' : 'Retry task'}
  {onConfirm}
  {onCancel}
/>

<script lang="ts">
  /**
   * Tier-3 type-to-confirm dead-letter clear (plan §9.4 T5.3, §10.6 Tier 3:
   * "type-to-confirm (AlertDialog)"). `ConfirmDialog`'s own `typeToConfirm`
   * prop already gates the confirm button on a case-insensitive trimmed
   * match — this is the sanctioned Cinder pattern for a user-initiated
   * destructive confirmation (`confirm-dialog/README.md`: "This includes
   * high-impact destructive actions the user initiated, even ones that
   * affect other people"); `AlertDialog` is reserved for system-initiated
   * interruptions and has no `typeToConfirm`/body-input slot at all, so it
   * cannot host this flow (see `drain-dialog.svelte`'s doc comment for the
   * same distinction).
   */
  import { ConfirmDialog } from '@lostgradient/cinder';

  import type { DeadLetterTarget } from './dead-letter-guard.ts';
  import { exactTimestamp } from './task-attempt-evidence.ts';

  interface ClearDeadLetterDialogProps {
    readonly open: boolean;
    /** The dead letter this clears, as the diagnostics listed it when the dialog opened. */
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
  }: ClearDeadLetterDialogProps = $props();

  const description = $derived(
    [
      `Clears the retained dead-letter record for ${target.activityName ?? 'a task'} on queue ${target.queue} (task ${target.operationId}).`,
      target.deadLetteredAt === undefined
        ? undefined
        : `It failed for good at ${exactTimestamp(target.deadLetteredAt)}.`,
      'Clearing does not retry the task, and it cannot be undone.',
    ]
      .filter((sentence) => sentence !== undefined)
      .join(' '),
  );
</script>

<ConfirmDialog
  bind:open
  title="Clear dead letter"
  {description}
  confirmLabel={submitting ? 'Clearing…' : 'Clear dead letter'}
  destructive
  typeToConfirm={target.operationId}
  {onConfirm}
  {onCancel}
/>

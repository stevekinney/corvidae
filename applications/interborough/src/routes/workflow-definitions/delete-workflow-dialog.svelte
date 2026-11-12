<script lang="ts" module>
  /** A schedule that runs the workflow from outside its file. */
  export type DeleteDialogSchedule = {
    /** The schedule's identifier. */
    readonly id: string;
    /** The schedule's name as the page reads it. */
    readonly label: string;
    /** Whether the schedule is paused, which the description and the helper say. */
    readonly paused: boolean;
  };
</script>

<script lang="ts">
  /**
   * The question before a workflow is deleted (board PageWorkflow, "More menu, and Delete" and
   * "Delete, with the schedule checked"): a Cinder confirm dialog titled with the workflow's name.
   * The description names the schedule that runs the workflow, when one does, says its past runs
   * stay on Runs, and names the file and the directory it is removed from. A schedule the file
   * defines goes with the file, so the page passes only the schedules that run the workflow from
   * outside it; for those an unchecked checkbox offers to delete them too, and the confirm button
   * says so while it is checked ("Delete workflow and schedule"). The checkbox starts unchecked
   * each time the dialog opens.
   *
   * The page does the work: the dialog stays open while it is in flight (`busy`, under "Deleting…"),
   * and shows the page's failure in place, so pressing the button again is the retry.
   */
  import { Checkbox, ConfirmDialog } from '@lostgradient/cinder';

  import { WORKFLOW_COPY } from '../../app/copy/workflows.ts';

  interface Props {
    /** Whether the dialog is open. Bindable. */
    open: boolean;
    /** The workflow's name as its header reads it. */
    name: string;
    /** The workflow's file name, such as `triage-inbox.json`. */
    fileName: string;
    /** The directory the file is removed from. */
    directory: string;
    /** The schedules that run the workflow from outside its file. */
    schedules: readonly DeleteDialogSchedule[];
    /** Whether the delete is in flight. */
    busy: boolean;
    /** Why the delete failed, shown in the dialog; `undefined` hides it. */
    error: string | undefined;
    /** Deletes the workflow, and with it the schedules when `alsoSchedules` is true. */
    onConfirm: (alsoSchedules: boolean) => void;
    /** Called when the dialog is dismissed without deleting. */
    onCancel?: (() => void) | undefined;
  }

  let {
    open = $bindable(false),
    name,
    fileName,
    directory,
    schedules,
    busy,
    error,
    onConfirm,
    onCancel = undefined,
  }: Props = $props();

  const copy = WORKFLOW_COPY.deleteDialog;
  let alsoSchedules = $state(false);

  // Each opening starts unchecked: a choice made and then canceled is not carried to the next one.
  $effect(() => {
    if (open) alsoSchedules = false;
  });

  const only = $derived<DeleteDialogSchedule | undefined>(schedules[0]);
  /** The sentence that names what runs the workflow, or nothing when no schedule does. */
  const lead = $derived(
    schedules.length > 1
      ? copy.schedulesRun(schedules.length)
      : only === undefined
        ? ''
        : copy.scheduleRuns(only.label, only.paused),
  );
  const confirmLabel = $derived(
    !alsoSchedules || schedules.length === 0
      ? copy.confirm
      : schedules.length === 1
        ? copy.confirmWithSchedule
        : copy.confirmWithSchedules,
  );
</script>

{#snippet description()}
  {lead}{copy.pastRuns}{copy.file.before}<code>{fileName}</code>{copy.file.middle}<code
    >{directory}</code
  >{copy.file.after}
{/snippet}

<ConfirmDialog
  bind:open
  title={copy.title(name)}
  {description}
  {confirmLabel}
  destructive
  {busy}
  busyLabel={copy.busy}
  errorTitle={copy.failedTitle}
  {error}
  closeOnConfirm={false}
  onConfirm={() => onConfirm(alsoSchedules && schedules.length > 0)}
  {...onCancel === undefined ? {} : { onCancel }}
>
  {#snippet options()}
    {#if schedules.length > 0}
      <div data-testid="workflow-delete-schedules">
        <Checkbox
          bind:checked={alsoSchedules}
          disabled={busy}
          label={schedules.length === 1 && only !== undefined
            ? copy.alsoDeleteSchedule(only.label)
            : copy.alsoDeleteSchedules(schedules.length)}
          description={schedules.length === 1 && only !== undefined
            ? copy.alsoDeleteHelp(only.paused)
            : copy.alsoDeleteHelpMany}
        />
      </div>
    {/if}
  {/snippet}
</ConfirmDialog>

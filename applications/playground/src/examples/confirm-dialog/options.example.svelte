<script lang="ts" module>
  export const title = 'Options below the description';
  export const description =
    'The description is a sentence and may carry monospace (a file path) as a snippet. options sits below it for a choice that changes what the confirmation does: here an unchecked checkbox that says what each choice does. The glyph on the confirmation is a trash can.';
</script>

<script lang="ts">
  import Trash from '@lucide/svelte/icons/trash';
  import { Button, Checkbox, ConfirmDialog } from '@lostgradient/cinder';

  let open = $state(false);
  let triggerRef: HTMLElement | null = $state(null);
  let alsoDeleteSchedule = $state(false);
  let result = $state('');
</script>

<div style="display: flex; flex-direction: column; gap: 1rem; align-items: flex-start;">
  <Button
    label="Delete…"
    variant="secondary"
    onclick={(event) => {
      triggerRef = event.currentTarget as HTMLElement;
      alsoDeleteSchedule = false;
      open = true;
    }}
  />
  {#if result}
    <p style="margin: 0; color: var(--cinder-text-muted); font-size: var(--cinder-text-sm);">
      {result}
    </p>
  {/if}
</div>

<ConfirmDialog
  bind:open
  {triggerRef}
  title="Delete Triage inbox?"
  destructive
  confirmLabel="Delete workflow"
  onConfirm={() =>
    (result = alsoDeleteSchedule
      ? 'Deleted the workflow and its schedule.'
      : 'Deleted the workflow; the schedule stays paused.')}
>
  {#snippet description()}
    The Inbox triage schedule (paused) runs this workflow. Its past runs stay on Runs. The file
    <code>triage-inbox.json</code> is removed from <code>~/.interborough/workflows</code>.
  {/snippet}
  {#snippet options()}
    <Checkbox
      id="delete-workflow-schedule"
      label="Also delete the Inbox triage schedule"
      description="Checked, the schedule is deleted with it. Unchecked, the schedule stays paused and shows “Can’t find workflow”."
      bind:checked={alsoDeleteSchedule}
    />
  {/snippet}
  {#snippet confirmIcon()}<Trash size={14} />{/snippet}
</ConfirmDialog>

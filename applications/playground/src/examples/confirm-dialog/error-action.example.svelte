<script lang="ts" module>
  export const title = 'Error action: a different next step after a failure';
  export const description =
    'errorAction puts an action in the failure callout and takes the confirm button away while the failure shows, for a failure where pressing confirm again is the wrong next step. errorTone="warning" draws a refusal nothing was done about, here a preview that went stale, as a warning. The first press fails; Refresh preview clears the failure and arms Purge again with the new count.';
</script>

<script lang="ts">
  import { Button, ConfirmDialog } from '@lostgradient/cinder';

  let open = $state(false);
  let triggerRef: HTMLElement | null = $state(null);
  let stale = $state(false);
  let count = $state(47);
  let purged = $state(false);

  function confirm() {
    // The first press finds the count has moved on: nothing was purged.
    if (count === 47) {
      stale = true;
      return;
    }
    purged = true;
    open = false;
  }

  function refresh() {
    count = 52;
    stale = false;
  }
</script>

<div style="display: flex; flex-direction: column; gap: 1rem; align-items: flex-start;">
  <Button
    label="Purge finished workflows…"
    variant="secondary"
    onclick={(event) => {
      triggerRef = event.currentTarget as HTMLElement;
      count = 47;
      stale = false;
      purged = false;
      open = true;
    }}
  />
  {#if purged}
    <p style="margin: 0; color: var(--cinder-text-muted); font-size: var(--cinder-text-sm);">
      Purged {count} workflows.
    </p>
  {/if}
</div>

<ConfirmDialog
  bind:open
  {triggerRef}
  title="Purge finished workflows?"
  description="Permanently deletes {count} finished workflows matching this filter. This can’t be undone."
  destructive
  confirmLabel="Purge {count} workflows"
  closeOnConfirm={false}
  error={stale ? 'Nothing was purged. Check the new count before you purge.' : undefined}
  errorTitle={stale ? 'The matching workflows changed' : undefined}
  errorTone="warning"
  errorAction={{ label: 'Refresh preview', onAction: refresh }}
  onConfirm={confirm}
/>

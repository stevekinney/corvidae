<script lang="ts" module>
  export const title = 'Pending: a count the server has not answered';
  export const description =
    'pending shows a skeleton where the description and options go, announces the pendingLabel once as a status, and disables the confirm button. Cancel stays enabled and keeps the first focus, so a person can leave while the count is in flight. The typed field waits with the rest of the body, and what was typed for an older answer is cleared.';
</script>

<script lang="ts">
  import { Button, ConfirmDialog } from '@lostgradient/cinder';

  let open = $state(false);
  let triggerRef: HTMLElement | null = $state(null);
  let pending = $state(true);
  let matched = $state(0);
  let purged = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;

  function count() {
    pending = true;
    clearTimeout(timer);
    timer = setTimeout(() => {
      matched = 47;
      pending = false;
    }, 1500);
  }
</script>

<div style="display: flex; flex-direction: column; gap: 1rem; align-items: flex-start;">
  <Button
    label="Purge finished workflows…"
    variant="secondary"
    onclick={(event) => {
      triggerRef = event.currentTarget as HTMLElement;
      purged = false;
      count();
      open = true;
    }}
  />
  {#if purged}
    <p style="margin: 0; color: var(--cinder-text-muted); font-size: var(--cinder-text-sm);">
      Purged {matched} workflows.
    </p>
  {/if}
</div>

<ConfirmDialog
  bind:open
  {triggerRef}
  title="Purge finished workflows?"
  description="Permanently deletes {matched} finished workflows matching this filter. This can’t be undone."
  destructive
  {pending}
  pendingLabel="Counting the workflows a purge would delete"
  typeToConfirm="purge {matched} workflows"
  confirmLabel="Purge {matched} workflows"
  onConfirm={() => (purged = true)}
  onCancel={() => clearTimeout(timer)}
/>

<script lang="ts" module>
  export const title = 'In flight, then failed, then retried';
  export const description =
    'closeOnConfirm={false} keeps the dialog open while the work runs. busy shows the busy label on an inert button and blocks every way out; a failure shows a danger callout between the body and the actions, keeps the typed identifier, and leaves Delete agent armed, so pressing it again is the retry. The first press fails; the second succeeds.';
</script>

<script lang="ts">
  import { Button, ConfirmDialog } from '@lostgradient/cinder';

  let open = $state(false);
  let triggerRef: HTMLElement | null = $state(null);
  let busy = $state(false);
  let failed = $state(false);
  let presses = $state(0);
  let deleted = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;

  function confirm() {
    presses += 1;
    busy = true;
    failed = false;
    clearTimeout(timer);
    timer = setTimeout(() => {
      busy = false;
      if (presses === 1) {
        failed = true;
        return;
      }
      deleted = true;
      open = false;
    }, 1200);
  }
</script>

<div style="display: flex; flex-direction: column; gap: 1rem; align-items: flex-start;">
  <Button
    label="Delete Order checker"
    variant="secondary"
    onclick={(event) => {
      triggerRef = event.currentTarget as HTMLElement;
      presses = 0;
      deleted = false;
      failed = false;
      open = true;
    }}
  />
  {#if deleted}
    <p style="margin: 0; color: var(--cinder-text-muted); font-size: var(--cinder-text-sm);">
      Deleted Order checker.
    </p>
  {/if}
</div>

<ConfirmDialog
  bind:open
  {triggerRef}
  title="Delete Order checker?"
  description="Its 2 chats stay, read-only. Its versions and memories are deleted, and this can’t be undone. 1 workflow (Order refund) will stop finding it."
  destructive
  typeToConfirm="order-checker"
  typeToConfirmLabel="Type order-checker to confirm"
  confirmLabel="Delete agent"
  busyLabel="Deleting…"
  closeOnConfirm={false}
  {busy}
  error={failed ? 'Nothing was deleted.' : undefined}
  errorTitle={failed ? 'Couldn’t delete the agent.' : undefined}
  onConfirm={confirm}
  onCancel={() => clearTimeout(timer)}
/>

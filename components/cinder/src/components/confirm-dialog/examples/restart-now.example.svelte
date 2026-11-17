<script lang="ts" module>
  export const title = 'Restart now: a glyph on the confirmation';
  export const description =
    'A confirmation that is not destructive keeps the primary button, and confirmIcon draws a glyph before its label so the label and the glyph say what happens. The dialog names the effect on running work, and Cancel keeps the first focus.';
</script>

<script lang="ts">
  import RotateCw from '@lucide/svelte/icons/rotate-cw';
  import { Button, ConfirmDialog } from '@lostgradient/cinder';

  let open = $state(false);
  let triggerRef: HTMLElement | null = $state(null);
  let restarted = $state(false);
</script>

<div style="display: flex; flex-direction: column; gap: 1rem; align-items: flex-start;">
  <Button
    label="Restart now"
    variant="secondary"
    onclick={(event) => {
      triggerRef = event.currentTarget as HTMLElement;
      restarted = false;
      open = true;
    }}
  />
  {#if restarted}
    <p style="margin: 0; color: var(--cinder-text-muted); font-size: var(--cinder-text-sm);">
      Restart requested.
    </p>
  {/if}
</div>

<ConfirmDialog
  bind:open
  {triggerRef}
  title="Restart Interborough now?"
  description="Interborough stops and starts again to apply 1 change. Running work picks up where it stopped; reviews stay waiting."
  confirmLabel="Restart now"
  onConfirm={() => (restarted = true)}
>
  {#snippet confirmIcon()}<RotateCw size={14} />{/snippet}
</ConfirmDialog>

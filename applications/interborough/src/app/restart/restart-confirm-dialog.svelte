<script lang="ts">
  /**
   * The question before a restart. Restart now is never one click: this names the effect on running
   * work (it picks up where it stopped; reviews stay waiting, never "nothing is running") and the
   * number of changes the restart applies.
   */
  import { ConfirmDialog } from '@lostgradient/cinder';
  import RotateCw from '@lucide/svelte/icons/rotate-cw';

  import { RESTART_COPY } from '../copy/restart.ts';

  interface Props {
    /** Whether the question is showing. */
    open: boolean;
    /** How many changes the restart applies. */
    changes: number;
    /** Called when the person confirms. */
    onConfirm: () => void;
  }

  let { open = $bindable(), changes, onConfirm }: Props = $props();
</script>

<ConfirmDialog
  bind:open
  title={RESTART_COPY.confirm.title}
  description={RESTART_COPY.confirm.description(changes)}
  confirmLabel={RESTART_COPY.confirm.confirm}
  cancelLabel={RESTART_COPY.confirm.cancel}
  {onConfirm}
>
  {#snippet confirmIcon()}<RotateCw size={14} aria-hidden="true" />{/snippet}
</ConfirmDialog>

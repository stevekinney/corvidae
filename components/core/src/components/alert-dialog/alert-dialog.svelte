<script lang="ts" module>
  export type { AlertDialogProps } from './alert-dialog.types.ts';
</script>

<script lang="ts">
  import type { AlertDialogProps } from './alert-dialog.types.ts';
  import Button from '../button/button.svelte';
  import Modal from '../modal/modal.svelte';
  import { classNames } from '@lostgradient/foundation/utilities/class-names.ts';

  const descriptionId = $props.id();

  let {
    open = $bindable(false),
    title,
    description,
    acknowledgeLabel = 'OK',
    cancelLabel,
    destructive = false,
    onAcknowledge,
    onCancel,
    triggerRef = null,
    class: className,
  }: AlertDialogProps = $props();

  function handleAcknowledge() {
    open = false;
    onAcknowledge();
  }

  function handleCancel() {
    open = false;
    onCancel?.();
  }

  const acknowledgeAutofocus = $derived(!(destructive && cancelLabel));
  const cancelAutofocus = $derived(Boolean(destructive && cancelLabel));
</script>

<Modal
  bind:open
  {title}
  {triggerRef}
  role="alertdialog"
  dismissOnBackdropClick={false}
  dismissOnEscape={false}
  closeButtonVisible={false}
  describedById={descriptionId}
  class={classNames('cinder-alert-dialog', className)}
>
  <p id={descriptionId} class="cinder-alert-dialog__description">{description}</p>

  {#snippet footer()}
    {#if cancelLabel}
      <Button variant="secondary" autofocus={cancelAutofocus} onclick={handleCancel}>
        {cancelLabel}
      </Button>
    {/if}
    <Button
      variant={destructive ? 'danger' : 'primary'}
      autofocus={acknowledgeAutofocus}
      onclick={handleAcknowledge}
    >
      {acknowledgeLabel}
    </Button>
  {/snippet}
</Modal>

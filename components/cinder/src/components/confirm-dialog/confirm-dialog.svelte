<script lang="ts" module>
  /**
   * @cinder
   * @category overlay
   * @status stable
   * @purpose Modal-backed confirmation prompt with cancel and confirm actions, including a destructive variant for irreversible operations.
   * @tag overlay
   * @tag dialog
   * @useWhen Requiring an explicit yes/no acknowledgement before performing a destructive or irreversible action.
   * @useWhen Asking the user to confirm a discrete decision with two clear outcomes.
   * @avoidWhen Collecting structured input or multiple fields — compose a modal with form controls instead.
   * @avoidWhen Announcing a non-blocking result — use toast-region or banner.
   * @related modal, alert-dialog, drawer
   */
  export type { ConfirmDialogProps } from './confirm-dialog.types.ts';
</script>

<script lang="ts">
  import type { ConfirmDialogProps } from './confirm-dialog.types.ts';
  import Button from '../button/button.svelte';
  import Callout from '../callout/callout.svelte';
  import Input from '../input/input.svelte';
  import Modal from '../modal/modal.svelte';
  import { PHONE_VIEWPORT_BREAKPOINT } from '../../_internal/viewport-below.svelte.ts';
  import { classNames } from '../../utilities/class-names.ts';

  const descriptionId = $props.id();
  const typedConfirmationId = `${descriptionId}-typed-confirmation`;

  let {
    open = $bindable(false),
    title,
    description,
    options,
    cancelLabel = 'Cancel',
    confirmLabel,
    confirmIcon,
    destructive = false,
    busy = false,
    busyLabel,
    errorTitle,
    error,
    closeOnConfirm = true,
    typeToConfirm,
    typeToConfirmLabel,
    onConfirm,
    onCancel,
    triggerRef = null,
    sheetBelow = PHONE_VIEWPORT_BREAKPOINT,
    onExitComplete,
    class: className,
  }: ConfirmDialogProps = $props();
  const describedById = $derived(
    description !== undefined && description !== '' ? descriptionId : undefined,
  );
  const failure = $derived(error?.trim() || undefined);
  const normalizedTypeToConfirm = $derived(typeToConfirm?.trim() || undefined);
  const normalizedTypeToConfirmLabel = $derived(typeToConfirmLabel?.trim() || undefined);
  let typedConfirmation = $state('');
  let previousOpen = open;
  const typedConfirmationMatches = $derived(
    normalizedTypeToConfirm === undefined ||
      typedConfirmation.trim().toLowerCase() === normalizedTypeToConfirm.toLowerCase(),
  );

  $effect(() => {
    if (open === previousOpen) return;
    previousOpen = open;
    typedConfirmation = '';
  });

  function handleCancel() {
    if (busy) return;
    // Mirror Modal's dismiss() ordering: state first, then callback. No try/catch —
    // consumer errors must propagate so tests, error boundaries, and observability see them.
    open = false;
    onCancel?.();
  }

  function handleConfirm() {
    // Same ordering and error policy: close first, fire callback, let errors propagate. A dialog
    // whose work can fail stays open (closeOnConfirm={false}) and the page closes it on success.
    if (closeOnConfirm) open = false;
    onConfirm();
  }
</script>

<Modal
  bind:open
  {title}
  {triggerRef}
  {sheetBelow}
  class={classNames('cinder-confirm-dialog', className)}
  dismissOnEscape={!busy}
  dismissOnBackdropClick={!busy}
  closeButtonVisible={!busy}
  {...describedById ? { describedById } : {}}
  {...onCancel ? { onDismiss: onCancel } : {}}
  {...onExitComplete ? { onExitComplete } : {}}
>
  {#if describedById}
    <p id={descriptionId} class="cinder-confirm-dialog__description">
      {#if typeof description === 'function'}{@render description()}{:else}{description}{/if}
    </p>
  {/if}

  {#if options}
    <div class="cinder-confirm-dialog__options">{@render options()}</div>
  {/if}

  {#if normalizedTypeToConfirm !== undefined}
    <Input
      id={typedConfirmationId}
      class="cinder-confirm-dialog__typed-confirmation"
      bind:value={typedConfirmation}
      label={normalizedTypeToConfirmLabel ?? `Type "${normalizedTypeToConfirm}" to confirm`}
      autocomplete="off"
      readonly={busy}
    />
  {/if}

  <!-- Always mounted, so the region exists before the failure arrives and the failure is announced. -->
  <div class="cinder-confirm-dialog__failure" role="alert">
    {#if failure}
      <Callout variant="danger" semantic="note" class="cinder-confirm-dialog__error">
        {#if errorTitle}<strong>{errorTitle}</strong>{' '}{/if}{failure}
      </Callout>
    {/if}
  </div>

  {#snippet footer()}
    <Button
      variant="secondary"
      class="cinder-confirm-dialog__cancel"
      autofocus
      aria-disabled={busy ? 'true' : undefined}
      onclick={handleCancel}>{cancelLabel}</Button
    >
    <Button
      variant={destructive ? 'danger' : 'primary'}
      disabled={!typedConfirmationMatches}
      loading={busy}
      {...busy ? { loadingStatus: busyLabel ?? confirmLabel } : {}}
      {...confirmIcon ? { leadingIcon: confirmIcon } : {}}
      onclick={handleConfirm}
    >
      {busy && busyLabel ? busyLabel : confirmLabel}
    </Button>
  {/snippet}
</Modal>

<script lang="ts" module>
  export type { ConfirmDialogProps } from './confirm-dialog.types.ts';
</script>

<script lang="ts">
  import type { ConfirmDialogProps } from './confirm-dialog.types.ts';
  import Button from '../button/button.svelte';
  import Callout from '../callout/callout.svelte';
  import Input from '../input/input.svelte';
  import Modal from '../modal/modal.svelte';
  import Skeleton from '../skeleton/skeleton.svelte';
  import { DIALOG_SHEET_BREAKPOINT } from '../../_internal/viewport-below.svelte.ts';
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
    errorTone = 'danger',
    errorAction,
    pending = false,
    pendingLabel,
    confirmEnabled = true,
    confirmVisible = true,
    closeOnConfirm = true,
    typeToConfirm,
    typeToConfirmLabel,
    onConfirm,
    onCancel,
    triggerRef = null,
    sheetBelow = DIALOG_SHEET_BREAKPOINT,
    onExitComplete,
    class: className,
  }: ConfirmDialogProps = $props();
  // A pending dialog shows a skeleton where the description goes, so nothing describes it yet.
  const describedById = $derived(
    !pending && description !== undefined && description !== '' ? descriptionId : undefined,
  );
  const failure = $derived(error?.trim() || undefined);
  // The failure's own action stands in for the confirm button: pressing confirm again is the
  // wrong next step whenever the page offered another.
  const confirmShown = $derived(confirmVisible && !(failure && errorAction));
  const normalizedTypeToConfirm = $derived(typeToConfirm?.trim() || undefined);
  const normalizedTypeToConfirmLabel = $derived(typeToConfirmLabel?.trim() || undefined);
  let typedConfirmation = $state('');
  let previousOpen = open;
  let previousPending = pending;
  const typedConfirmationMatches = $derived(
    normalizedTypeToConfirm === undefined ||
      typedConfirmation.trim().toLowerCase() === normalizedTypeToConfirm.toLowerCase(),
  );

  $effect(() => {
    if (open === previousOpen) return;
    previousOpen = open;
    typedConfirmation = '';
  });

  // What was typed confirmed the answer that is being replaced, so a new answer starts blank.
  $effect(() => {
    if (pending === previousPending) return;
    previousPending = pending;
    if (pending) typedConfirmation = '';
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

{#snippet failureAction()}
  {#if errorAction}
    <Button variant="secondary" size="sm" onclick={errorAction.onAction}>
      {errorAction.label}
    </Button>
  {/if}
{/snippet}

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
  {#if pending}
    <!-- Both regions keep the room the answer will take, so the dialog does not jump when it comes. -->
    <div class="cinder-confirm-dialog__description cinder-confirm-dialog__pending">
      <Skeleton lines={2} label={pendingLabel ?? 'Loading'} />
    </div>
    <div class="cinder-confirm-dialog__options cinder-confirm-dialog__pending">
      <Skeleton height="3rem" radius="var(--cinder-radius-sm)" />
    </div>
  {:else}
    {#if describedById}
      <p id={descriptionId} class="cinder-confirm-dialog__description">
        {#if typeof description === 'function'}{@render description()}{:else}{description}{/if}
      </p>
    {/if}

    {#if options}
      <div class="cinder-confirm-dialog__options">{@render options()}</div>
    {/if}
  {/if}

  {#if normalizedTypeToConfirm !== undefined && !pending}
    <Input
      id={typedConfirmationId}
      class="cinder-confirm-dialog__typed-confirmation"
      bind:value={typedConfirmation}
      label={normalizedTypeToConfirmLabel ?? `Type "${normalizedTypeToConfirm}" to confirm`}
      autocomplete="off"
      readonly={busy}
    />
  {/if}

  {#snippet footer()}
    <div class="cinder-confirm-dialog__footer">
      <!--
        Always mounted, so the region exists before the failure arrives and the failure is
        announced. It sits in the footer, above the actions and outside the scrolling body: on a
        short phone the body scrolls, and a failure inside it would be a faded strip under the
        footer with the next step out of view.
      -->
      <div class="cinder-confirm-dialog__failure" role="alert">
        {#if failure}
          <Callout
            variant={errorTone}
            semantic="note"
            class="cinder-confirm-dialog__error"
            {...errorAction ? { action: failureAction } : {}}
          >
            {#if errorTitle}<strong>{errorTitle}</strong>{' '}{/if}{failure}
          </Callout>
        {/if}
      </div>
      <div class="cinder-confirm-dialog__actions">
        <Button
          variant="secondary"
          class="cinder-confirm-dialog__cancel"
          autofocus
          aria-disabled={busy ? 'true' : undefined}
          onclick={handleCancel}>{cancelLabel}</Button
        >
        {#if confirmShown}
          <Button
            variant={destructive ? 'danger' : 'primary'}
            disabled={!typedConfirmationMatches || !confirmEnabled || pending}
            loading={busy}
            {...busy ? { loadingStatus: busyLabel ?? confirmLabel } : {}}
            {...confirmIcon ? { leadingIcon: confirmIcon } : {}}
            onclick={handleConfirm}
          >
            {busy && busyLabel ? busyLabel : confirmLabel}
          </Button>
        {/if}
      </div>
    </div>
  {/snippet}
</Modal>

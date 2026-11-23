<script lang="ts" module>
  export type { ConfirmDialogProps } from './confirm-dialog.types.ts';
</script>

<script lang="ts">
  import { untrack } from 'svelte';

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
  // The first value is read once, on purpose: the effect below compares it with every later one.
  let previousPending = untrack(() => pending);
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

  let actionsElement = $state<HTMLElement | undefined>();
  let failureElement: HTMLElement | undefined;
  let confirmWasShown = untrack(() => confirmShown);
  let confirmHadFocus = false;

  // When the confirm button goes away (a failure that carries its own action, or nothing left to
  // confirm) while it holds focus, focus would fall to <body> and a keyboard or screen-reader user
  // loses their place exactly when the failure is announced. Read before the DOM changes whether
  // it held focus, and after, move it to the failure's action, or to Cancel when there is none.
  $effect.pre(() => {
    const shown = confirmShown;
    if (!shown && confirmWasShown) {
      const active = document.activeElement;
      confirmHadFocus =
        actionsElement !== undefined &&
        active instanceof HTMLElement &&
        actionsElement.contains(active) &&
        !active.classList.contains('cinder-confirm-dialog__cancel');
    }
    confirmWasShown = shown;
  });

  $effect(() => {
    if (confirmShown || !confirmHadFocus) return;
    confirmHadFocus = false;
    const target =
      failureElement?.querySelector<HTMLElement>('button') ??
      actionsElement?.querySelector<HTMLElement>('.cinder-confirm-dialog__cancel');
    target?.focus();
  });

  // A sheet's Cancel stays compact only while it and the confirmation actually fit one row. CSS
  // can wrap the row, but cannot tell the wrapped state to make both buttons equal width. Measure
  // the labels' natural widths on every content or container reflow, then switch to an intentional
  // vertical group only while the row needs it. This follows the component-width policy instead of
  // guessing from a viewport breakpoint, so a translated or otherwise long confirmation gets the
  // same treatment.
  let actionsStacked = $state(false);

  /** The width an inline row needs, without a stretched confirmation feeding its own threshold. */
  function naturalActionNeed(actions: HTMLElement, buttons: readonly HTMLButtonElement[]): number {
    const previous = buttons.map((button) => ({
      button,
      flex: button.style.flex,
      inlineSize: button.style.inlineSize,
    }));
    for (const { button } of previous) {
      button.style.flex = '0 0 auto';
      button.style.inlineSize = 'max-content';
    }
    const gap =
      Number.parseFloat(
        actions.ownerDocument.defaultView?.getComputedStyle(actions).columnGap ?? '',
      ) || 0;
    const need =
      buttons.reduce((total, button) => total + button.getBoundingClientRect().width, 0) +
      gap * Math.max(0, buttons.length - 1);
    for (const { button, flex, inlineSize } of previous) {
      button.style.flex = flex;
      button.style.inlineSize = inlineSize;
    }
    return need;
  }

  function updateActionStack(): void {
    const actions = actionsElement;
    const sheet = actions?.closest<HTMLDialogElement>('dialog')?.dataset.cinderSheet;
    if (actions == null || sheet !== 'docked') {
      if (actionsStacked) actionsStacked = false;
      return;
    }
    const room = actions.clientWidth;
    if (room <= 0) return;
    const buttons = Array.from(actions.querySelectorAll<HTMLButtonElement>(':scope > button'));
    const nextStacked = buttons.length > 1 && room + 1 < naturalActionNeed(actions, buttons);
    if (actionsStacked !== nextStacked) actionsStacked = nextStacked;
  }

  $effect(() => {
    const node = actionsElement;
    if (node == null) return;
    const view = node.ownerDocument.defaultView;
    const observer = view?.ResizeObserver ? new view.ResizeObserver(updateActionStack) : undefined;
    observer?.observe(node);
    const mutations = view?.MutationObserver
      ? new view.MutationObserver(updateActionStack)
      : undefined;
    mutations?.observe(node, { childList: true, characterData: true, subtree: true });
    const fonts = node.ownerDocument.fonts;
    fonts?.addEventListener('loadingdone', updateActionStack);
    queueMicrotask(updateActionStack);
    return () => {
      observer?.disconnect();
      mutations?.disconnect();
      fonts?.removeEventListener('loadingdone', updateActionStack);
    };
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

  {#snippet footer()}
    <div class="cinder-confirm-dialog__footer">
      <!--
        Always mounted, so the region exists before the failure arrives and the failure is
        announced. It sits in the footer, above the actions and outside the scrolling body: on a
        short phone the body scrolls, and a failure inside it would be a faded strip under the
        footer with the next step out of view.
      -->
      <div class="cinder-confirm-dialog__failure" role="alert" bind:this={failureElement}>
        {#if failure}
          <Callout
            variant={errorTone}
            semantic="note"
            class="cinder-confirm-dialog__error"
            actionLayout="stacked-start"
            {...errorTitle ? { title: errorTitle } : {}}
            {...errorAction ? { action: failureAction } : {}}
          >
            {failure}
          </Callout>
        {/if}
      </div>
      <!--
        The typed confirmation sits with the buttons it gates, outside the scrolling body, so the
        field and the confirm button are always in view together: a long list above them scrolls
        under the footer, and the field is never half hidden by it.
      -->
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
      <div
        class="cinder-confirm-dialog__actions"
        data-cinder-stacked={actionsStacked ? '' : undefined}
        data-cinder-typed-destructive={destructive && normalizedTypeToConfirm !== undefined
          ? ''
          : undefined}
        data-cinder-fault-only={failure && errorAction ? '' : undefined}
        bind:this={actionsElement}
      >
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
            loadingStatus={busyLabel ?? confirmLabel}
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

<script lang="ts" module>
  /**
   * @cinder
   * @category overlay
   * @status stable
   * @purpose Edge-anchored modal panel built on the native dialog element; slides from the left, right, or bottom edge for secondary navigation, settings, or mobile-first sheet patterns.
   * @tag overlay
   * @tag dialog
   * @useWhen Showing supplementary navigation, filters, or settings that should slide in from a page edge.
   * @useWhen Presenting long-form content that benefits from a side panel without leaving the current view.
   * @useWhen Presenting a focused task or set of actions that slides up from the bottom of the viewport on touch surfaces — use `placement="bottom"`.
   * @avoidWhen Interrupting the user for a focused decision — use modal so the surface is centered and task-scoped.
   * @avoidWhen Anchoring a small surface to a trigger — use popover instead.
   * @related modal, popover
   */
  export type { DrawerDetent, DrawerProps, DrawerPlacement, DrawerSize } from './drawer.types.ts';
</script>

<script lang="ts">
  import type { DrawerDetent, DrawerPlacement, DrawerProps } from './drawer.types.ts';
  import { onDestroy, tick, untrack } from 'svelte';
  import type { HTMLAttributes } from 'svelte/elements';

  import { trackKeyboardInset } from '../../_internal/keyboard-inset.ts';
  import { pushEscapeHandler } from '../../_internal/overlay.ts';
  import { reducedMotionFadeIn } from '../../_internal/reduced-motion-fade.ts';
  import { overflowFade } from '../../utilities/attachments.ts';
  import { classNames } from '../../utilities/class-names.ts';
  import { restoreFocusTo } from '../../utilities/focus.ts';
  import { createFocusTrap } from '../focus-trap/index.ts';
  import {
    clampDragHeight,
    cycleDetent,
    DRAG_TAP_DISTANCE,
    detentHeight,
    nearestDetent,
    normalizeDetents,
    resolveDetent,
    stepDetent,
  } from './drawer-detents.ts';
  import { useReducedMotion } from '../../utilities/use-reduced-motion.svelte.ts';
  import {
    createSlidingDialogState,
    focusDialogBodyUnlessAutofocused,
  } from '../_internal/create-sliding-dialog-state.svelte.ts';

  let {
    open = $bindable(false),
    placement = 'right',
    size = 'md',
    closeIconLabel = 'Close drawer',
    modal = true,
    title,
    class: className,
    triggerRef = null,
    ariaLabelledby,
    dragHandleVisible = true,
    closeLabel,
    detents,
    detent = $bindable(),
    count,
    header,
    children,
    footer,
    action,
    onExitComplete,
    ...rest
  }: DrawerProps = $props();

  const titleId = $props.id();
  const nonModalPortalScopeId = `${titleId}-scope`;
  const asideAttributes = $derived(rest as HTMLAttributes<HTMLElement>);

  let dialogElement: HTMLDialogElement | undefined = $state();
  let bodyElement: HTMLDivElement | undefined = $state();
  let panelElement: HTMLDivElement | undefined = $state();
  let nonModalAsideElement: HTMLElement | undefined = $state();
  let nonModalPanelElement: HTMLDivElement | undefined = $state();
  let nonModalReturnFocusTarget: HTMLElement | null = null;
  let wasNonModalOpen = false;
  let wasModal = $state(untrack(() => modal));
  /**
   * The placement that was active when the current open/close cycle began.
   * Snapshotted at open time so that a placement-prop change while the drawer
   * is open or closing does not flip the slide direction mid-animation.
   * Only updated when the drawer actually (re)opens a new cycle.
   */
  let activePlacement = $state<DrawerPlacement>();

  /** What the grabber announces for each detent, as the value text of its separator. */
  const DETENT_LABELS: Record<DrawerDetent, string> = {
    peek: 'Collapsed',
    medium: 'Half height',
    large: 'Full height',
  };

  const resolvedPlacement = $derived(activePlacement ?? placement);
  // Detents belong to the bottom sheet; on a side drawer they are ignored.
  const detentList = $derived(resolvedPlacement === 'bottom' ? normalizeDetents(detents) : []);
  const currentDetent = $derived(resolveDetent(detentList, detent));
  // One detent fixes the height; two or more make the grabber a resize control.
  const resizable = $derived(detentList.length > 1);
  const showGrabber = $derived(resolvedPlacement === 'bottom' && (dragHandleVisible || resizable));
  // The three-column header bar (Cancel, title, action) is opt-in: a sheet that has an action. A
  // custom header owns its own layout.
  const headerBar = $derived(
    resolvedPlacement === 'bottom' && header === undefined && action !== undefined,
  );
  /** The pixel height the sheet is being dragged to, or null while it rests at a detent. */
  let dragHeight = $state<number | null>(null);
  const peeking = $derived(currentDetent === 'peek' && dragHeight === null);
  let handleElement: HTMLDivElement | undefined = $state();
  let drag: {
    pointerId: number;
    startY: number;
    startHeight: number;
    moved: boolean;
    onTap: (() => void) | null;
  } | null = null;
  let suppressClick = false;

  function isValidNonModalFocusTarget(target: HTMLElement | null): target is HTMLElement {
    return (
      target !== null &&
      target.isConnected &&
      target.ownerDocument === document &&
      !nonModalAsideElement?.contains(target)
    );
  }

  const reducedMotion = useReducedMotion();
  const bodyOverflowFade = overflowFade();
  const dialogState = createSlidingDialogState({
    getOpen: () => open,
    setOpen: (nextOpen) => {
      open = nextOpen;
    },
    getDialogElement: () => dialogElement,
    getPanelElement: () => panelElement,
    getReducedMotion: () => reducedMotion.current,
    // A drawer slides in with motion, so with less motion it cross-fades instead of vanishing.
    getFadeOnReducedMotion: () => true,
    getTriggerRef: () => triggerRef,
    onClosed: () => {
      activePlacement = undefined;
      onExitComplete?.();
    },
    // Host-managed initial focus (the Modal policy, via the trap's
    // `manageInitialFocus: false` opt-out): focus the body container unless a
    // child is autofocused, so opening never lands focus on the close button.
    onOpen: () =>
      focusDialogBodyUnlessAutofocused({
        getOpen: () => open,
        getDialogElement: () => dialogElement,
        getBodyElement: () => bodyElement,
      }),
  });

  $effect(() => {
    dialogState.markHydrated();
  });

  // A bottom sheet rides above the on-screen keyboard and scrolls inside itself (rows 05d, 05j).
  $effect(() => {
    if (!open || (activePlacement ?? placement) !== 'bottom') return;
    return trackKeyboardInset();
  });

  $effect.pre(() => {
    if (!modal || !open || activePlacement) return;
    activePlacement = placement;
  });

  $effect(() => {
    if (wasModal && !modal) {
      activePlacement = undefined;
      dialogState.releaseModalState();
    }
    wasModal = modal;
  });

  $effect(() => {
    if (!modal) return;
    if (open) {
      if (dialogState.isClosing) {
        // Quick-reopen while a close transition is still running.
        // Snapshot the current placement so the reversal / re-entry animation
        // uses the edge the user expects for this new open intent.
        activePlacement = placement;
      }

      if (!dialogState.renderPanel) {
        // Fresh mount — snapshot the placement for this open cycle so any
        // later placement-prop change while open or closing does not flip
        // the direction.
        activePlacement = placement;
      }
    }
    dialogState.syncOpenState();
  });

  $effect(() => {
    if (modal || !dialogState.hydrated || !open) return;
    return pushEscapeHandler((event) => {
      event.preventDefault();
      open = false;
    });
  });

  $effect(() => {
    if (modal || !dialogState.hydrated) {
      wasNonModalOpen = false;
      nonModalReturnFocusTarget = null;
      return;
    }

    if (open && !wasNonModalOpen) {
      const activeElement =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      nonModalReturnFocusTarget =
        (isValidNonModalFocusTarget(triggerRef) && triggerRef) ||
        (isValidNonModalFocusTarget(activeElement) && activeElement) ||
        null;
      wasNonModalOpen = true;
      return;
    }

    if (!open && wasNonModalOpen) {
      wasNonModalOpen = false;
      const returnTarget =
        (isValidNonModalFocusTarget(triggerRef) ? triggerRef : null) ?? nonModalReturnFocusTarget;
      nonModalReturnFocusTarget = null;
      const activeElement = document.activeElement;
      if (
        activeElement === document.body ||
        (activeElement instanceof HTMLElement && nonModalPanelElement?.contains(activeElement))
      ) {
        restoreFocusTo(returnTarget);
      }
      activePlacement = undefined;
      onExitComplete?.();
    }
  });

  onDestroy(() => {
    if (!modal && wasNonModalOpen) {
      const activeElement = document.activeElement;
      if (
        activeElement === document.body ||
        (activeElement instanceof HTMLElement && nonModalPanelElement?.contains(activeElement))
      ) {
        restoreFocusTo(
          (isValidNonModalFocusTarget(triggerRef) ? triggerRef : null) ?? nonModalReturnFocusTarget,
        );
      }
    }
    dialogState.destroy();
  });

  function setDetent(next: DrawerDetent): void {
    if (next !== currentDetent) detent = next;
  }

  function handleGrabberKeydown(event: KeyboardEvent): void {
    if (currentDetent === undefined) return;
    let next: DrawerDetent | undefined;
    switch (event.key) {
      case 'ArrowUp':
        next = stepDetent(detentList, currentDetent, 1);
        break;
      case 'ArrowDown':
        next = stepDetent(detentList, currentDetent, -1);
        break;
      case 'Home':
        next = detentList[0];
        break;
      case 'End':
        next = detentList.at(-1);
        break;
      case 'Enter':
      case ' ':
        next = cycleDetent(detentList, currentDetent);
        break;
      default:
        return;
    }
    event.preventDefault();
    if (next !== undefined) setDetent(next);
  }

  /** A tap on the grabber steps to the next larger detent, and from the largest back to the smallest. */
  function tapGrabber(): void {
    if (currentDetent !== undefined) setDetent(cycleDetent(detentList, currentDetent));
  }

  async function expandFromPeek(): Promise<void> {
    if (currentDetent === undefined) return;
    setDetent(stepDetent(detentList, currentDetent, 1));
    // The peek bar unmounts as the sheet opens, so focus moves to the grabber instead of falling
    // to the page.
    await tick();
    handleElement?.focus();
  }

  function handlePeekClick(event: MouseEvent): void {
    // A drag that ended on the bar still fires a click; only a keyboard click (detail 0) is never
    // the tail of a drag.
    if (suppressClick && event.detail !== 0) {
      suppressClick = false;
      return;
    }
    suppressClick = false;
    void expandFromPeek();
  }

  function beginDrag(event: PointerEvent, onTap: (() => void) | null): void {
    if (!resizable || currentDetent === undefined || drag !== null || event.button !== 0) return;
    suppressClick = false;
    drag = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight: detentHeight(currentDetent, window.innerHeight),
      moved: false,
      onTap,
    };
    if (event.currentTarget instanceof HTMLElement && 'setPointerCapture' in event.currentTarget) {
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // A pointer that is already gone cannot be captured; the drag ends on its own.
      }
    }
  }

  function moveDrag(event: PointerEvent): void {
    if (drag === null || drag.pointerId !== event.pointerId) return;
    const distance = drag.startY - event.clientY;
    if (!drag.moved && Math.abs(distance) < DRAG_TAP_DISTANCE) return;
    drag.moved = true;
    dragHeight = clampDragHeight(detentList, drag.startHeight + distance, window.innerHeight);
  }

  function endDrag(event: PointerEvent, cancelled: boolean): void {
    if (drag === null || drag.pointerId !== event.pointerId) return;
    const finished = drag;
    const releasedAt = dragHeight;
    drag = null;
    dragHeight = null;
    if (event.currentTarget instanceof HTMLElement && 'releasePointerCapture' in event.currentTarget) {
      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {
        // Capture was already released with the pointer.
      }
    }
    if (cancelled) return;
    if (!finished.moved) {
      finished.onTap?.();
      return;
    }
    suppressClick = true;
    setDetent(nearestDetent(detentList, releasedAt ?? finished.startHeight, window.innerHeight));
  }

  // A sheet that closes mid-drag forgets the drag.
  $effect(() => {
    if (open) return;
    drag = null;
    dragHeight = null;
  });

  function requestDrawerClose(): void {
    if (modal) {
      dialogState.requestClose();
      return;
    }
    open = false;
  }
</script>

{#snippet closeControl()}
  {#if closeLabel}
    <button
      type="button"
      class="cinder-drawer__close"
      data-cinder-close-label=""
      onclick={requestDrawerClose}
    >
      {closeLabel}
    </button>
  {:else}
    <button
      type="button"
      class="cinder-drawer__close"
      aria-label={closeIconLabel}
      onclick={requestDrawerClose}
    >
      <svg
        class="cinder-drawer__close-icon"
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 20 20"
        fill="currentColor"
        aria-hidden="true"
      >
        <path
          d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z"
        />
      </svg>
    </button>
  {/if}
{/snippet}

{#snippet grabber()}
  {#if showGrabber}
    {#if resizable && currentDetent !== undefined}
      <!-- The grabber is a window splitter (WAI-ARIA APG): a focusable separator whose value is the
           detent's position among `detents`, moved by drag, arrow keys, Home, End and tap. -->
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <div
        bind:this={handleElement}
        class="cinder-drawer__drag-handle"
        data-cinder-resizable=""
        role="separator"
        tabindex="0"
        aria-orientation="horizontal"
        aria-label="Resize sheet"
        aria-valuemin={0}
        aria-valuemax={detentList.length - 1}
        aria-valuenow={detentList.indexOf(currentDetent)}
        aria-valuetext={DETENT_LABELS[currentDetent]}
        onkeydown={handleGrabberKeydown}
        onpointerdown={(event) => beginDrag(event, tapGrabber)}
        onpointermove={moveDrag}
        onpointerup={(event) => endDrag(event, false)}
        onpointercancel={(event) => endDrag(event, true)}
      >
        <span class="cinder-drawer__drag-handle-pill"></span>
      </div>
    {:else}
      <div class="cinder-drawer__drag-handle" aria-hidden="true">
        <span class="cinder-drawer__drag-handle-pill"></span>
      </div>
    {/if}
  {/if}
{/snippet}

{#snippet peekContent()}
  <span class="cinder-drawer__peek-title">{title}</span>
  <span class="cinder-drawer__peek-count" aria-live="polite" aria-atomic="true">{count ?? ''}</span>
{/snippet}

{#snippet sheetParts()}
  {@render grabber()}

  {#if currentDetent === 'peek'}
    <!-- The collapsed bar: the sheet's title and live count. A tap or a drag opens it. -->
    {#if resizable}
      <button
        type="button"
        class="cinder-drawer__peek"
        aria-expanded="false"
        onclick={handlePeekClick}
        onpointerdown={(event) => beginDrag(event, null)}
        onpointermove={moveDrag}
        onpointerup={(event) => endDrag(event, false)}
        onpointercancel={(event) => endDrag(event, true)}
      >
        {@render peekContent()}
      </button>
    {:else}
      <div class="cinder-drawer__peek">
        {@render peekContent()}
      </div>
    {/if}
  {/if}

  <header class="cinder-drawer__header" data-cinder-bar={headerBar ? '' : undefined}>
    {#if header}
      {#if !ariaLabelledby}
        <h2 id={titleId} class="cinder-sr-only">{title}</h2>
      {/if}
      {@render header()}
    {:else}
      <h2 id={titleId} class="cinder-drawer__title">{title}</h2>
    {/if}
    {@render closeControl()}
    {#if action && headerBar}
      <div class="cinder-drawer__action">
        {@render action()}
      </div>
    {/if}
  </header>

  <div
    bind:this={bodyElement}
    class="cinder-drawer__body cinder-_scroll-fade"
    tabindex="-1"
    {@attach bodyOverflowFade}
  >
    {@render children()}
  </div>

  {#if footer}
    <div class="cinder-drawer__footer">
      {@render footer()}
    </div>
  {/if}
{/snippet}

{#if dialogState.hydrated || (!modal && open)}
  {#if modal}
    <dialog
      {...rest}
      bind:this={dialogElement}
      class={classNames('cinder-drawer', className)}
      aria-modal="true"
      aria-labelledby={ariaLabelledby ?? titleId}
      data-cinder-modal="true"
      data-cinder-closing={dialogState.isClosing ? '' : undefined}
      onclose={() => dialogState.handleClose()}
      oncancel={(event) => dialogState.handleNativeCancel(event)}
      onclick={(event) => dialogState.handleBackdropClick(event)}
    >
      {#if dialogState.renderPanel}
        <!--
          The native <dialog> (showModal) traps focus in supporting browsers; the
          shared focus-trap is the defence-in-depth fallback. The Drawer owns
          both focus restoration (returnFocus) and initial focus (the body-focus
          effect above), so the trap runs with `restoreFocus: false` and
          `manageInitialFocus: false`.
        -->
        <div
          bind:this={panelElement}
          class="cinder-drawer__panel"
          data-cinder-placement={resolvedPlacement}
          data-cinder-size={size}
          data-cinder-detent={currentDetent}
          data-cinder-peek={peeking ? '' : undefined}
          data-cinder-dragging={dragHeight === null ? undefined : ''}
          data-cinder-closing={dialogState.isClosing ? '' : undefined}
          style:height={dragHeight === null ? undefined : `${dragHeight}px`}
          inert={dialogState.isClosing}
          {@attach reducedMotionFadeIn(() => reducedMotion.current)}
          {@attach createFocusTrap({
            active: () => open && !dialogState.isClosing,
            restoreFocus: false,
            manageInitialFocus: false,
          })}
        >
          {@render sheetParts()}
        </div>
      {/if}
    </dialog>
  {:else if open}
    <aside
      bind:this={nonModalAsideElement}
      {...asideAttributes}
      class={classNames('cinder-drawer', className)}
      aria-labelledby={ariaLabelledby ?? titleId}
      data-cinder-modal="false"
      data-cinder-portal-owner={nonModalPortalScopeId}
    >
      <div id={nonModalPortalScopeId} class="cinder-drawer__portal-scope"></div>
      <div
        bind:this={nonModalPanelElement}
        class="cinder-drawer__panel"
        data-cinder-placement={placement}
        data-cinder-size={size}
        data-cinder-detent={currentDetent}
        data-cinder-peek={peeking ? '' : undefined}
        data-cinder-dragging={dragHeight === null ? undefined : ''}
        style:height={dragHeight === null ? undefined : `${dragHeight}px`}
        {@attach reducedMotionFadeIn(() => reducedMotion.current)}
      >
        {@render sheetParts()}
      </div>
    </aside>
  {/if}
{/if}

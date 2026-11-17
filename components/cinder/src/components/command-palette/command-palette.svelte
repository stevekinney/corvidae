<script lang="ts" module>
  /**
   * @cinder
   * @category overlay
   * @status stable
   * @purpose Modal search overlay for keyboard-first command launching and navigation. Filtering is consumer-owned: the `items` snippet receives `{ query }` and renders only the matching rows.
   * @tag overlay
   * @tag command
   * @useWhen Exposing a global keyboard-first launcher for power-user actions and navigation.
   * @useWhen Letting users search across heterogeneous results such as commands, pages, and records in one input.
   * @avoidWhen Picking a single value bound to a form field — use combobox instead.
   * @avoidWhen Showing a contextual action menu attached to a trigger — use dropdown instead.
   * @related combobox, dropdown, command-item
   */
  export type { CommandPaletteProps } from './command-palette.types.ts';
</script>

<script lang="ts">
  import type { CommandPaletteProps } from './command-palette.types.ts';
  import { onDestroy, tick } from 'svelte';

  import { trackKeyboardInset } from '../../_internal/keyboard-inset.ts';
  import { reducedMotionFadeIn } from '../../_internal/reduced-motion-fade.ts';
  import {
    PHONE_VIEWPORT_BREAKPOINT,
    readViewportBreakpoint,
    useViewportBelow,
  } from '../../_internal/viewport-below.svelte.ts';
  import { classNames } from '../../utilities/class-names.ts';
  import { useReducedMotion } from '../../utilities/use-reduced-motion.svelte.ts';
  import Button from '../button/button.svelte';
  import Kbd from '../kbd/kbd.svelte';
  import { setCommandListContext } from '../_internal/command-list-context.ts';
  import { createCommandListState } from '../_internal/create-command-list-state.svelte.ts';
  import { createSlidingDialogState } from '../_internal/create-sliding-dialog-state.svelte.ts';

  let {
    open = $bindable(false),
    placeholder = 'Search…',
    label = 'Command palette',
    query = $bindable(''),
    onClose,
    triggerRef = null,
    items,
    empty,
    footer,
    sheetBelow = PHONE_VIEWPORT_BREAKPOINT,
    closeLabel = 'Close',
    escapeHint = 'esc',
    class: className,
  }: CommandPaletteProps = $props();

  // ── IDs ──────────────────────────────────────────────────────────────────
  const baseId = $props.id();
  const listboxId = `${baseId}-listbox`;
  const inputId = `${baseId}-input`;

  // ── DOM refs ─────────────────────────────────────────────────────────────
  let dialogElement: HTMLDialogElement | undefined = $state();
  let panelElement: HTMLDivElement | undefined = $state();
  let inputElement: HTMLInputElement | undefined = $state();

  const reducedMotion = useReducedMotion();

  // Below `sheetBelow` the palette is a bottom sheet (rows 05d, 06c). It reads the viewport through
  // the shared hook, like Popover, so server markup is always the centred panel.
  const sheetBreakpoint = $derived(
    readViewportBreakpoint(sheetBelow, 'CommandPalette', 'sheetBelow'),
  );
  const narrowViewport = useViewportBelow(() => sheetBreakpoint);
  const sheet = $derived(narrowViewport.current);

  const commandList = createCommandListState(listboxId);

  $effect(() => {
    // Track query so this re-runs on every query change.
    void query;
    commandList.refreshRegistrationsReady();
  });

  // ── Sliding-dialog lifecycle ────────────────────────────────────────────
  // Adopts SlidingDialogState (the same mechanism Modal and Drawer use)
  // rather than hand-rolling an exit lifecycle. Per OVERLAY-POLICY.md,
  // "Transition lifecycle" > "The contract": the component renders
  // data-cinder-closing on its animated panel for the full duration of the
  // exit transition, and the shared waitForTransitionCompletion helper (used
  // internally by SlidingDialogState) — not a fixed timeout — decides when
  // the panel actually unmounts and the native dialog closes. This also
  // gives the palette the counted lockBodyScroll() acquisition/release and
  // the hydrated-gated SSR pattern it previously lacked (both tracked as
  // OVERLAY-POLICY.md deviations under CIN-426, alongside this lifecycle
  // gap itself).
  const dialogState = createSlidingDialogState({
    getOpen: () => open,
    setOpen: (nextOpen) => {
      open = nextOpen;
    },
    getDialogElement: () => dialogElement,
    getPanelElement: () => panelElement,
    getReducedMotion: () => reducedMotion.current,
    // A sheet slides in with motion, so with less motion it cross-fades instead of vanishing.
    getFadeOnReducedMotion: () => sheet,
    getTriggerRef: () => triggerRef,
    onOpen: () => {
      query = '';
      commandList.resetActiveItem();
      // Deferred: the panel subtree (and the inputElement binding) has not
      // flushed yet in the same effect that first sets renderPanel — mirrors
      // focusDialogBodyUnlessAutofocused's own tick() deferral for
      // Modal/Drawer in create-sliding-dialog-state.svelte.ts.
      void tick().then(() => {
        if (open) inputElement?.focus();
        return undefined;
      });
    },
    onClosed: () => onClose?.(),
  });

  $effect(() => {
    dialogState.markHydrated();
  });

  // The sheet rides above the on-screen keyboard and scrolls inside itself (row 05j).
  $effect(() => {
    if (!open || !sheet) return;
    return trackKeyboardInset();
  });

  $effect(() => {
    dialogState.syncOpenState();
  });

  onDestroy(() => {
    dialogState.destroy();
  });

  // ── Dialog event handlers ─────────────────────────────────────────────────

  // Matches modal.svelte's oncancel wiring: the native <dialog> fires
  // `cancel` before `close` when Escape is pressed. Prevent the browser's
  // own dialog-closing behavior so the sole close path is
  // dialogState.requestClose() → the exit transition → the real `close`
  // event → dialogState.handleClose().
  function handleCancel(event: Event) {
    dialogState.handleNativeCancel(event);
  }

  // The `close` event fires when the native dialog actually closes (any
  // path) — SlidingDialogState.handleClose() is the single place that
  // releases the scroll lock and escape-stack registration, restores focus,
  // and reports completion via onClosed.
  function handleClose() {
    dialogState.handleClose();
  }

  function handleBackdropClick(event: MouseEvent) {
    dialogState.handleBackdropClick(event);
  }

  // ── Keyboard routing ──────────────────────────────────────────────────────
  function handleKeydown(event: KeyboardEvent) {
    commandList.handleKeydown({
      event,
      onEnter: (id) => commandList.activateItemById(id),
      preventDefaultOnEmptyEnter: true,
    });
  }

  function handleInput(event: Event) {
    const target = event.target as HTMLInputElement;
    query = target.value;
  }

  $effect(() => {
    commandList.scrollActiveItemIntoView();
  });

  // ── Context ───────────────────────────────────────────────────────────────
  setCommandListContext(commandList.createContext());

  const showEmpty = $derived(
    dialogState.hydrated &&
      commandList.registrationsReady &&
      commandList.registrations.length === 0,
  );
</script>

{#if dialogState.hydrated}
  <dialog
    bind:this={dialogElement}
    class="cinder-command-palette"
    aria-label={label}
    aria-modal="true"
    oncancel={handleCancel}
    onclose={handleClose}
    onclick={handleBackdropClick}
    data-cinder-sheet={sheet ? 'docked' : undefined}
  >
    {#if dialogState.renderPanel}
      <div
        bind:this={panelElement}
        class={classNames('cinder-command-palette__panel', className)}
        data-cinder-closing={dialogState.isClosing ? '' : undefined}
        inert={dialogState.isClosing}
        {@attach reducedMotionFadeIn(() => reducedMotion.current && sheet)}
      >
        {#if sheet}
          <div class="cinder-command-palette__grabber" aria-hidden="true"></div>
        {/if}
        <div class="cinder-command-palette__search">
          <svg
            class="cinder-command-palette__search-icon"
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 20 20"
            fill="currentColor"
            aria-hidden="true"
          >
            <path
              fill-rule="evenodd"
              d="M9 3.5a5.5 5.5 0 100 11 5.5 5.5 0 000-11zM2 9a7 7 0 1112.452 4.391l3.328 3.329a.75.75 0 11-1.06 1.06l-3.329-3.328A7 7 0 012 9z"
              clip-rule="evenodd"
            />
          </svg>
          <label for={inputId} class="cinder-sr-only">{label}</label>
          <input
            bind:this={inputElement}
            id={inputId}
            type="text"
            class="cinder-command-palette__input"
            role="combobox"
            autocomplete="off"
            autocorrect="off"
            spellcheck="false"
            {placeholder}
            value={query}
            aria-autocomplete="list"
            aria-expanded="true"
            aria-controls={listboxId}
            aria-activedescendant={commandList.activeItemId ?? undefined}
            oninput={handleInput}
            onkeydown={handleKeydown}
          />
          {#if sheet}
            <Button
              variant="ghost"
              size="sm"
              class="cinder-command-palette__close"
              label={closeLabel}
              onclick={() => dialogState.requestClose()}
            />
          {:else if escapeHint !== false}
            <span class="cinder-command-palette__escape" aria-hidden="true">
              <Kbd size="sm" label={escapeHint} />
            </span>
          {/if}
        </div>

        <ul id={listboxId} role="listbox" class="cinder-command-palette__listbox">
          {@render items({ query })}
        </ul>

        {#if showEmpty && empty}
          <div class="cinder-command-palette__empty" role="status">
            {@render empty()}
          </div>
        {/if}

        {#if footer}
          <div class="cinder-command-palette__footer">
            {@render footer()}
          </div>
        {/if}
      </div>
    {/if}
  </dialog>
{/if}

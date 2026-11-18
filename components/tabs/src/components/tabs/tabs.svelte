<script lang="ts" module>
  export type { TabsContext, TabsOrientation, TabsProps } from './tabs.types.ts';
</script>

<script lang="ts">
  import type { TabsProps } from './tabs.types.ts';
  import { setTabsContext } from './tabs-context.ts';

  import { untrack } from 'svelte';
  import type { Attachment } from 'svelte/attachments';
  import {
    readViewportBreakpoint,
    useViewportBelow,
  } from '@lostgradient/foundation/_internal/viewport-below.svelte.ts';
  import Select from '@lostgradient/select/components/select/select.svelte';
  import {
    handleRovingKeydown,
    isRovingKey,
  } from '@lostgradient/foundation/utilities/roving-tabindex.ts';
  import { classNames } from '@lostgradient/foundation/utilities/class-names.ts';
  import { commitValue } from '@lostgradient/foundation/utilities/value-change.ts';

  const baseId = $props.id();

  let {
    value = $bindable(''),
    onValueChangeRequest,
    onValueChange,
    orientation = 'horizontal',
    collapseOnOverflow = true,
    collapseBelow = false,
    collapseLabel = 'Tab',
    fill = false,
    activateOnFocus,
    class: className,
    children,
  }: TabsProps = $props();

  // Default activation behavior follows the WAI-ARIA tabs pattern: horizontal
  // tablists activate on focus (left/right are dedicated to tab navigation),
  // vertical tablists activate on Enter/Space (down/up commonly belong to the
  // panel content too).
  const effectiveActivateOnFocus = $derived(activateOnFocus ?? orientation === 'horizontal');

  type RegistryEntry = {
    button: HTMLButtonElement | undefined;
    disabled: boolean;
    /** Plain-text name in the narrow form's select; `undefined` until the tab is on the page. */
    label: string | undefined;
    /** Muted line under the name in that select, such as "1 needs attention". */
    note: string | undefined;
  };

  /**
   * Registry of tab buttons keyed by their `value`. Order of registration
   * determines navigation order — children register in mount order.
   *
   * In-place mutation of an entry's `disabled` field does not trigger Svelte
   * reactivity on its own, so every mutation path also bumps `version`. Any
   * `$derived` that reads from the registry must also read `version` to
   * re-run when entries change.
   *
   * Order metadata (`registerOrder`) is written synchronously from each
   * Tab's top-level script, so the registry is fully populated for every
   * sibling before any `$effect` runs — including on the server, where
   * effects never run at all. The button reference itself (`attachButton`)
   * is only available once a Tab has mounted, so `button` starts out
   * `undefined` and is only used for imperative focus, never for
   * tabindex calculation.
   */
  const buttons: Map<string, RegistryEntry> = new Map();
  let version = $state(0);
  /**
   * Flips to `true` exactly once, from the first effect flush after the
   * initial render commits (server render and the client's initial render
   * both leave this `false`). `isFocusable`'s registry-dependent fallback
   * rule is gated behind this so it never runs mid-registration — see
   * `isFocusable` below.
   */
  let mounted = $state(false);

  $effect(() => {
    mounted = true;
  });

  // Below `collapseBelow` a horizontal tab bar becomes one select. The choice is made in script,
  // not CSS, and the viewport reads wide on the server, so server markup is always the tab bar.
  const collapseBreakpoint = $derived(
    orientation === 'horizontal'
      ? readViewportBreakpoint(collapseBelow, 'Tabs', 'collapseBelow')
      : undefined,
  );
  const viewport = useViewportBelow(() => collapseBreakpoint);

  // The bar collapses when it does not fit its container (COR-2448 AC2). While the select stands
  // in, the bar is hidden and cannot be measured, so the width it needed is remembered from the
  // moment it overflowed and compared with the container's width as that changes.
  let rootElement: HTMLDivElement | undefined = $state();
  let overflowing = $state(false);
  let measureRequest = $state(0);
  let overflowNeed = 0;
  // What the root's width exceeded the bar's own by when the bar overflowed.
  let overflowSlack = 0;
  let measuredVersion = -1;
  // A change of the tabs is waiting for focus to leave the collapsed select before it is measured.
  let waitingToMeasure = false;

  /** Whether focus, or an open list, is inside the root: drawing the bar would remount the select. */
  function busy(root: HTMLElement): boolean {
    return (
      root.contains(document.activeElement) || root.querySelector('[aria-expanded="true"]') !== null
    );
  }

  const collapsed = $derived(
    orientation === 'horizontal' && (viewport.current || (collapseOnOverflow && overflowing)),
  );

  $effect(() => {
    void measureRequest;
    void version;
    const stillOverflowing = overflowing;
    const root = rootElement;
    if (!collapseOnOverflow || orientation !== 'horizontal' || root === undefined) {
      if (stillOverflowing) overflowing = false;
      return;
    }
    untrack(() => {
      if (version !== measuredVersion) {
        // A tab came, went, or changed its text: what the bar needs is unknown until it is drawn
        // again, so draw it and measure it. Drawing it unmounts the select, so while someone is in
        // the select (focus, or its list open) the bar stays collapsed and the measurement waits
        // for focus to leave: a count that updates live must not close the list under them.
        if (stillOverflowing && busy(root)) {
          waitingToMeasure = true;
          return;
        }
        measuredVersion = version;
        overflowNeed = 0;
        if (stillOverflowing) {
          overflowing = false;
          return;
        }
      }
      waitingToMeasure = false;
      const available = root.clientWidth;
      // A hidden tabs root, or a DOM with no layout, measures nothing and keeps what is drawn.
      if (available <= 0) return;
      if (stillOverflowing) {
        // The bar can be as wide as the root less what the root keeps for itself, so this mirrors
        // the judgement that collapsed it: the tabs against the width the bar itself would have.
        // Judging by the root's whole width un-collapsed a bar the next pass collapsed again, and
        // the effect never settled.
        if (overflowNeed > 0 && available - overflowSlack + 1 >= overflowNeed) overflowing = false;
        return;
      }
      const list = root.querySelector<HTMLElement>(':scope > .cinder-tab-list');
      if (list === null || list.hidden) return;
      if (list.scrollWidth - list.clientWidth > 1) {
        overflowNeed = list.scrollWidth;
        overflowSlack = Math.max(0, available - list.clientWidth);
        overflowing = true;
      }
    });
  });

  // The container's own width, text that changes under the bar, and fonts that finish loading all
  // change what the bar needs without a tab registering.
  const measureWidth: Attachment<HTMLDivElement> = (node) => {
    rootElement = node;
    const request = (): void => {
      measureRequest += 1;
    };
    const resizeObserver =
      typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(request);
    resizeObserver?.observe(node);
    const mutationObserver =
      typeof MutationObserver === 'undefined' ? undefined : new MutationObserver(request);
    mutationObserver?.observe(node, { childList: true, subtree: true, characterData: true });
    const fonts = typeof document === 'undefined' ? undefined : document.fonts;
    fonts?.addEventListener('loadingdone', request);
    // Focus that leaves the collapsed select ends the wait. A move between two controls inside the
    // root also fires a focusout, with the next control as its related target, which is skipped.
    const focusMoved = (event: FocusEvent): void => {
      if (!waitingToMeasure) return;
      if (event.type === 'focusout' && event.relatedTarget !== null) return;
      request();
    };
    document.addEventListener('focusin', focusMoved);
    document.addEventListener('focusout', focusMoved);
    return () => {
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      fonts?.removeEventListener('loadingdone', request);
      document.removeEventListener('focusin', focusMoved);
      document.removeEventListener('focusout', focusMoved);
      rootElement = undefined;
    };
  };

  const collapseOptions = $derived.by(() => {
    void version;
    return [...buttons].map(([registeredValue, entry]) => ({
      value: registeredValue,
      label: entry.label ?? registeredValue,
      disabled: entry.disabled,
      ...(entry.note === undefined ? {} : { note: entry.note }),
    }));
  });

  const focusableValue = $derived.by(() => {
    void version;
    for (const [registeredValue, entry] of buttons) {
      if (!entry.disabled) return registeredValue;
    }
    return undefined;
  });

  function focusValue(target: string): void {
    const entry = buttons.get(target);
    entry?.button?.focus();
  }

  function resolveFocusedIndex(active: Element | null): number {
    const entries = [...buttons.values()];
    return entries.findIndex(({ button }) => button === active);
  }

  function readActiveElement(event: KeyboardEvent): Element | null {
    // Prefer the event target if it is itself a registered tab button —
    // that is the most local, most reliable signal. Fall back to
    // ownerDocument.activeElement when the target is not a tab (e.g., when
    // the handler is attached at a higher level).
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (target) {
      for (const { button } of buttons.values()) {
        if (button === target) return target;
      }
    }
    const currentTarget = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
    return currentTarget?.ownerDocument.activeElement ?? null;
  }

  function resolveStartingIndex(event: KeyboardEvent): number {
    const entries = [...buttons.values()];
    if (entries.length === 0) return -1;
    const focused = resolveFocusedIndex(readActiveElement(event));
    if (focused !== -1) return focused;
    // Fallback: active tab if enabled, else first enabled. Returns -1 only
    // when every entry is disabled — the caller's guard handles that case.
    const order = [...buttons.keys()];
    const activeIdx = order.indexOf(value);
    if (activeIdx !== -1 && !entries[activeIdx]?.disabled) return activeIdx;
    return entries.findIndex((entry) => !entry.disabled);
  }

  /**
   * Whether the given key is one this orientation handles. Home/End are
   * always relevant; Arrow keys are orientation-specific. Mirrors the
   * `horizontal`/`vertical` filtering inside `handleRovingKeydown` so the
   * all-disabled no-op path does not preventDefault on keys we would
   * otherwise have let bubble (e.g., ArrowUp on a horizontal tablist).
   */
  function isOrientedKey(key: string, isHorizontal: boolean): boolean {
    if (!isRovingKey(key)) return false;
    if (key === 'Home' || key === 'End') return true;
    if (isHorizontal) return key === 'ArrowLeft' || key === 'ArrowRight';
    return key === 'ArrowUp' || key === 'ArrowDown';
  }

  function handleKeydown(event: KeyboardEvent): void {
    const entries = [...buttons.values()];
    const order = [...buttons.keys()];

    if (event.key === 'Enter' || event.key === ' ') {
      // Manual activation: activate the focused tab if it is enabled.
      const focused = resolveFocusedIndex(readActiveElement(event));
      if (focused === -1) return;
      if (entries[focused]?.disabled !== false) return;
      const focusedValue = order[focused];
      if (focusedValue === undefined) return;
      event.preventDefault();
      commitValue(
        focusedValue,
        onValueChangeRequest,
        (next) => {
          value = next;
        },
        onValueChange,
      );
      return;
    }

    const isHorizontal = orientation === 'horizontal';
    if (!isOrientedKey(event.key, isHorizontal)) return;
    if (entries.length === 0) return;

    const currentIndex = resolveStartingIndex(event);
    if (currentIndex === -1) {
      // All entries disabled — prevent default so arrow/Home/End do not leak
      // page scroll, but otherwise no-op.
      event.preventDefault();
      return;
    }

    const nextIdx = handleRovingKeydown(event, currentIndex, entries.length, {
      isDisabled: (i) => entries[i]?.disabled ?? false,
      horizontal: isHorizontal,
      vertical: !isHorizontal,
    });

    if (nextIdx === null) return;
    event.preventDefault();
    if (nextIdx === currentIndex) return;

    const nextValue = order[nextIdx];
    if (nextValue === undefined) return;
    focusValue(nextValue);
    if (effectiveActivateOnFocus) {
      commitValue(
        nextValue,
        onValueChangeRequest,
        (next) => {
          value = next;
        },
        onValueChange,
      );
    }
  }

  setTabsContext({
    get value() {
      return value;
    },
    get orientation() {
      return orientation;
    },
    get collapsed() {
      return collapsed;
    },
    get activateOnFocus() {
      return effectiveActivateOnFocus;
    },
    get baseId() {
      return baseId;
    },
    select(next) {
      commitValue(
        next,
        onValueChangeRequest,
        (nextValue) => {
          value = nextValue;
        },
        onValueChange,
      );
    },
    isActive(candidate) {
      return value === candidate;
    },
    registerOrder(target, disabled) {
      // Idempotent: only inserts an order entry the first time a target is
      // seen. Called both synchronously (once, from each Tab's top-level
      // script — see tab.svelte) and defensively from Effect A on every
      // rerun, so a rerun that finds the entry already present is a no-op
      // rather than clobbering the seeded `disabled` state.
      if (buttons.has(target)) return;
      buttons.set(target, { button: undefined, disabled, label: undefined, note: undefined });
      version += 1;
    },
    setLabel(target, nextLabel, note) {
      const existing = buttons.get(target);
      if (!existing) return;
      if (existing.label === nextLabel && existing.note === note) return;
      existing.label = nextLabel;
      existing.note = note;
      version += 1;
    },
    attachButton(target, button) {
      const existing = buttons.get(target);
      if (!existing) return;
      existing.button = button;
    },
    unregister(target) {
      if (buttons.delete(target)) {
        version += 1;
      }
    },
    setDisabled(target, disabled) {
      const existing = buttons.get(target);
      if (!existing) return;
      if (existing.disabled === disabled) return;
      existing.disabled = disabled;
      version += 1;
    },
    isFocusable(candidate) {
      // Force reads of every reactive input up front, regardless of which
      // branch the predicate ultimately takes. The calling $derived in
      // tab.svelte needs to subscribe to `value`, `version`, AND `mounted`
      // for any possible code path — early-returning before reading one of
      // them would leave the derived under-subscribed and stale when only
      // the unread input changes. Must be called inside a $derived/$effect.
      void value;
      void version;
      void mounted;

      // `candidate` is always the calling Tab's own value, and every Tab
      // registers its own order entry synchronously before its own
      // isFocusable is ever read (see tab.svelte) — so this lookup never
      // misses on a real render.
      const entry = buttons.get(candidate);
      if (!entry || entry.disabled) return false;

      // Direct rule — order-independent. If this candidate IS the selected
      // value and is enabled (already confirmed above), it is always the
      // tab stop, regardless of registration order or position among
      // siblings. Needs no information about any other tab, so it is
      // correct on the very first render pass, whether that's SSR or the
      // client's initial render.
      if (candidate === value) return true;

      // Fallback rule — "first enabled tab" — is only correct once every
      // sibling has registered. Gated behind `mounted` so it never runs
      // mid-registration: evaluating it during a single top-down SSR pass
      // (or the client's still-registering initial render) would answer
      // "has the selected tab registered yet?" based on registration
      // order rather than tab identity, wrongly awarding the tab stop to
      // an earlier, unrelated sibling.
      if (!mounted) return false;
      const selectedEntry = buttons.get(value);
      const selectedIsEnabled = selectedEntry !== undefined && !selectedEntry.disabled;
      if (selectedIsEnabled) return false; // the real selected tab handles itself via the direct rule
      return focusableValue === candidate;
    },
    handleKeydown,
  });
</script>

<div
  class={classNames('cinder-tabs', className)}
  data-cinder-orientation={orientation}
  data-cinder-fill={fill ? '' : undefined}
  data-cinder-collapsed={collapsed ? '' : undefined}
  {@attach measureWidth}
>
  {#if collapsed}
    <!-- The narrow form: one full-width select reading "Tab: Access". The tab bar below it is
       hidden, not removed, so every tab still registers and still names its panel. -->
    <Select
      id={`${baseId}-collapse`}
      class="cinder-tabs__collapse"
      presentation="listbox"
      label={collapseLabel}
      labelVisible={false}
      valuePrefix={`${collapseLabel}:`}
      {value}
      options={collapseOptions}
      {...onValueChangeRequest === undefined ? {} : { onValueChangeRequest }}
      onValueChange={(next) => {
        commitValue(
          next,
          undefined,
          (nextValue) => {
            value = nextValue;
          },
          onValueChange,
        );
      }}
    />
  {/if}
  {@render children()}
</div>

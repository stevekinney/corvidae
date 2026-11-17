<script lang="ts" module>
  export type { ToolbarOrientation, ToolbarProps } from './toolbar.types.ts';
</script>

<script lang="ts">
  import type { HTMLAttributes } from 'svelte/elements';

  import { classNames } from '@lostgradient/foundation/utilities/class-names.ts';
  import { devWarn } from '@lostgradient/foundation/utilities/dev-warn.ts';
  import {
    createRovingToolbar,
    ROVING_TOOLBAR_MUTATION_OPTIONS,
  } from '@lostgradient/foundation/utilities/roving-toolbar.ts';
  import { useMutationObserver } from '@lostgradient/foundation/utilities/use-mutation-observer.svelte.ts';
  import type { ToolbarProps } from './toolbar.types.ts';

  type ToolbarRuntimeProps = ToolbarProps & {
    role?: unknown;
    'aria-orientation'?: unknown;
    onkeydown?: HTMLAttributes<HTMLDivElement>['onkeydown'];
    onfocusin?: HTMLAttributes<HTMLDivElement>['onfocusin'];
  };

  let {
    class: className,
    orientation = 'horizontal',
    children,
    onkeydown: consumerOnKeyDown,
    onfocusin: consumerOnFocusIn,
    role: _role,
    'aria-orientation': _ariaOrientation,
    'aria-label': ariaLabel,
    'aria-labelledby': ariaLabelledBy,
    ...rest
  }: ToolbarRuntimeProps = $props();

  let rootElement: HTMLDivElement | null = null;
  let lastWarnedNameSource = '';

  function resolveAccessibleNameSource(): string {
    const inlineLabel = ariaLabel?.trim() ?? '';
    const labelledBy = ariaLabelledBy?.trim() ?? '';
    return inlineLabel || labelledBy;
  }

  function hasResolvedLabelledByText(): boolean {
    if (!rootElement || !ariaLabelledBy) return false;
    const identifiers = ariaLabelledBy
      .split(/\s+/)
      .map((value) => value.trim())
      .filter(Boolean);
    if (identifiers.length === 0) return false;
    return identifiers.every((identifier) => {
      const element = document.getElementById(identifier);
      return element !== null && (element.textContent?.trim().length ?? 0) > 0;
    });
  }

  function warnAboutAccessibleName(): void {
    if (!rootElement) return;
    const warningKey = `${ariaLabel ?? ''}|${ariaLabelledBy ?? ''}`;
    if (warningKey === lastWarnedNameSource) return;

    const inlineLabel = ariaLabel?.trim() ?? '';
    if (inlineLabel.length > 0) return;
    if (ariaLabelledBy?.trim() && hasResolvedLabelledByText()) return;

    lastWarnedNameSource = warningKey;
    devWarn(
      '[cinder/Toolbar] rendered without a resolvable accessible name. Pass a non-empty `aria-label` or `aria-labelledby` that points to non-empty text.',
    );
  }

  // The attachment re-runs when the accessible name changes; carry the Tab stop across re-runs so
  // the user's place in the toolbar survives (the previous controller restores tabindex on cleanup).
  let lastActiveItem: HTMLElement | null = null;

  function toolbarSetup(node: HTMLDivElement) {
    rootElement = node;

    // The roving keyboard model, tab stops, and focusability observation are shared with
    // SelectionPopover's custom actions; see utilities/roving-toolbar.ts.
    const roving = createRovingToolbar({
      root: node,
      orientation: () => (orientation === 'vertical' ? 'vertical' : 'horizontal'),
      onKeydown: (event) =>
        consumerOnKeyDown?.(
          event as KeyboardEvent & { currentTarget: EventTarget & HTMLDivElement },
        ),
      onFocusIn: (event) =>
        consumerOnFocusIn?.(event as FocusEvent & { currentTarget: EventTarget & HTMLDivElement }),
    });

    roving.sync(lastActiveItem);

    const detachRoving = roving.attach();

    const detachMutationObserver = useMutationObserver(() => {
      roving.sync();
      warnAboutAccessibleName();
    }, ROVING_TOOLBAR_MUTATION_OPTIONS)(node);

    warnAboutAccessibleName();

    return () => {
      lastActiveItem = roving.activeItem();
      detachRoving();
      detachMutationObserver?.();
      rootElement = null;
    };
  }
</script>

<div
  {...rest}
  {@attach toolbarSetup}
  role="toolbar"
  aria-label={ariaLabel}
  aria-labelledby={ariaLabelledBy}
  aria-orientation={orientation === 'vertical' ? 'vertical' : undefined}
  class={classNames('cinder-toolbar', className)}
  data-cinder-orientation={orientation}
  data-cinder-name-source={resolveAccessibleNameSource()}
>
  {@render children()}
</div>

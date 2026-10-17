<script lang="ts" module>
  /**
   * @cinder
   * @category action
   * @status stable
   * @purpose Named grouping of related controls that implements the WAI-ARIA toolbar pattern with DOM-driven roving tabindex.
   * @tag action
   * @tag grouping
   * @useWhen Rendering a row or column of related controls where the whole set should be one Tab stop and arrow keys should move between items.
   * @useWhen Wrapping existing cinder controls such as Button, SegmentedControl, and NumberInput without adding toolbar-specific child APIs.
   * @avoidWhen Building a static flex row of controls that should remain in ordinary Tab order — use inline, cluster, or button-group instead.
   * @related button-group, segmented-control, number-input
   */
  export type { ToolbarOrientation, ToolbarProps } from './toolbar.types.ts';
</script>

<script lang="ts">
  import type { HTMLAttributes } from 'svelte/elements';

  import { classNames } from '../../utilities/class-names.ts';
  import { devWarn } from '../../utilities/dev-warn.ts';
  import {
    createRovingToolbar,
    ROVING_TOOLBAR_MUTATION_OPTIONS,
  } from '../../utilities/roving-toolbar.ts';
  import { useMutationObserver } from '../../utilities/use-mutation-observer.svelte.ts';
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

    roving.sync();

    const detachRoving = roving.attach();

    const detachMutationObserver = useMutationObserver(() => {
      roving.sync();
      warnAboutAccessibleName();
    }, ROVING_TOOLBAR_MUTATION_OPTIONS)(node);

    warnAboutAccessibleName();

    return () => {
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

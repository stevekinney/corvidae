import type { Snippet } from 'svelte';
import type { BadgeVariant } from '../badge/badge.types.ts';

import type {
  FlatHTMLAttributesSpanElement,
  FlatHTMLButtonAttributes,
} from '../../_internal/forwarded-html-attributes.generated.ts';

export type ChipVariant = BadgeVariant;
export type ChipSize = 'sm' | 'md';
export type ChipMode = 'display' | 'toggle' | 'removable';
/**
 * Opt the chip into a shared toolbar height (via `--cinder-control-height-sm`)
 * so it lines up with sibling Button (size="sm") and SegmentedControl
 * (density="toolbar"). Default rendering is unchanged.
 */
export type ChipDensity = 'toolbar';
// Forwarded through the flattened (non-generic) copies of svelte/elements' attribute
// interfaces — see `_internal/forwarded-html-attributes.generated.ts` (COR-239). Referencing
// the generic interfaces directly from all three modes of this union pushes `keyof ChipProps`
// (which svelte's `Component<Props, {}, Bindings>` computes for its `Bindings` constraint)
// over TypeScript's type complexity budget: TS2590 under a consumer's `skipLibCheck: false`.
export type ChipDisplayProps = Omit<FlatHTMLAttributesSpanElement, 'class'> & {
  // Named rather than a general `data-*` index signature — the flattened attribute type above is
  // already at TypeScript's type complexity budget for this three-mode union, and an index
  // signature (even a small `data-${string}` one) reintroduces TS2590. `data-test-id`,
  // `data-cinder-mode`, and `data-cinder-variant` are the three this workspace's own tests rely
  // on (chip-attributes.test.ts); the latter two are also intentionally overridable-and-
  // overridden — the component's own derived value wins when a consumer spreads a conflicting
  // one (see that same test).
  'data-test-id'?: string;
  'data-cinder-mode'?: string;
  'data-cinder-variant'?: string;
  /** Rendering and interaction mode. Default `"display"`. */
  mode?: 'display';
  /** Visible text content of the chip. */
  label: string;
  /** Color variant applied to the chip. Default `"neutral"`. */
  variant?: ChipVariant;
  /** Optional third-party brand color mixed toward the foreground for legibility. */
  brandColor?: string;
  /** Allow long entity URLs to wrap at any character. */
  breakable?: boolean;
  /** Size of the chip. Default `"md"`. */
  size?: ChipSize;
  /** When set to `"toolbar"`, opts the chip into compact toolbar sizing to align with sibling toolbar controls. */
  density?: ChipDensity;
  leadingIcon?: Snippet;
  /** Additional class names merged onto the chip element. */
  class?: string;
  // Cross-variant sentinel props: present as `never` so the union is destructurable in chip.svelte,
  // and consumers get a compile-time error if they pass toggle/removable-only props to display mode.
  pressed?: never;
  disabled?: never;
  onPressedChange?: never;
  onRemove?: never;
  removeAriaLabel?: never;
};
// `aria-pressed` is owned (set from the `pressed` prop) and `type` is always `"button"`
// (a toggle chip must never become a form submitter), so both are Omit-ted — a consumer
// value would be silently overridden. `onclick` and `aria-label` are intentionally NOT
// omitted: the component consumes them (wraps onclick, suppresses empty aria-label)
// rather than discarding them.
export type ChipToggleProps = Omit<
  FlatHTMLButtonAttributes,
  'class' | 'disabled' | 'aria-pressed' | 'type'
> & {
  'data-test-id'?: string;
  'data-cinder-mode'?: string;
  'data-cinder-variant'?: string;
  /** Rendering and interaction mode. Must be `"toggle"` for this variant. */
  mode: 'toggle';
  /** Visible text content of the chip. */
  label: string;
  /** Color variant applied to the chip. Default `"neutral"`. */
  variant?: ChipVariant;
  /** Optional third-party brand color mixed toward the foreground for legibility. */
  brandColor?: string;
  /** Allow long entity URLs to wrap at any character. */
  breakable?: boolean;
  /** Size of the chip. Default `"md"`. */
  size?: ChipSize;
  /** When set to `"toolbar"`, opts the chip into compact toolbar sizing to align with sibling toolbar controls. */
  density?: ChipDensity;
  leadingIcon?: Snippet;
  /** Additional class names merged onto the chip element. */
  class?: string;
  /** Toggle mode only. Whether the chip is currently in the pressed (selected) state. Reflected as `aria-pressed`. */
  pressed: boolean;
  onPressedChange?: (pressed: boolean) => void;
  /** Toggle mode only. When true, disables the toggle button and prevents interaction. */
  disabled?: boolean;
  // Cross-variant sentinel props
  onRemove?: never;
  removeAriaLabel?: never;
};
export type ChipRemovableProps = Omit<FlatHTMLAttributesSpanElement, 'class'> & {
  'data-test-id'?: string;
  'data-cinder-mode'?: string;
  'data-cinder-variant'?: string;
  /** Rendering and interaction mode. Must be `"removable"` for this variant. */
  mode: 'removable';
  /** Visible text content of the chip and fallback accessible name for the remove button. */
  label: string;
  /** Color variant applied to the chip. Default `"neutral"`. */
  variant?: ChipVariant;
  /** Optional third-party brand color mixed toward the foreground for legibility. */
  brandColor?: string;
  /** Allow long entity URLs to wrap at any character. */
  breakable?: boolean;
  /** Size of the chip. Default `"md"`. */
  size?: ChipSize;
  /** When set to `"toolbar"`, opts the chip into compact toolbar sizing to align with sibling toolbar controls. */
  density?: ChipDensity;
  leadingIcon?: Snippet;
  /** Additional class names merged onto the chip element. */
  class?: string;
  onRemove?: () => void;
  /** Removable mode only. When true, disables the remove button and prevents removal. */
  disabled?: boolean;
  /** Removable mode only. Accessible label for the remove button. Defaults to `Remove` followed by the chip's `label`. */
  removeAriaLabel?: string;
  // Cross-variant sentinel props
  pressed?: never;
  onPressedChange?: never;
};
export type ChipProps = ChipDisplayProps | ChipToggleProps | ChipRemovableProps;

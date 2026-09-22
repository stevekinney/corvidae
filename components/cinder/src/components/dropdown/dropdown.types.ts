import type { Placement } from '@floating-ui/dom';
import type { Snippet } from 'svelte';
import type { AnchoredOverlayWidthMode } from '../../_internal/anchored-overlay.svelte.ts';
import type { FlatHTMLAttributesDivElement } from '../../_internal/forwarded-html-attributes.generated.ts';

export type DropdownPlacement = 'top-start' | 'top-end' | 'bottom-start' | 'bottom-end';
export type DropdownContext = {
  get menuId(): string;
  get isOpen(): boolean;
  get supportsPopover(): boolean;
  readonly anchorElement?: HTMLElement | null | undefined;
  readonly fallbackAnchorElement?: HTMLElement | null | undefined;
  readonly fallbackPositionStyle?: string | undefined;
  readonly fallbackPositionReady?: boolean | undefined;
  readonly fallbackPlacement?: Placement | undefined;
  readonly widthMode?: AnchoredOverlayWidthMode | undefined;
  readonly initialFocus?: 'first' | 'last' | 'none' | undefined;
  close: () => void;
  focusTrigger: () => void;
};
// Forwarded through the flattened (non-generic) copy of `HTMLAttributes<HTMLDivElement>` —
// see `_internal/forwarded-html-attributes.generated.ts` (COR-239). `DropdownBaseProps` is
// intersected into both arms of `DropdownProps`, and referencing the generic interface
// directly there pushes `keyof DropdownProps` (which svelte's `Component<Props, {}, "open">`
// computes for its `Bindings` constraint) over TypeScript's type complexity budget: TS2590
// under a consumer's `skipLibCheck: false`.
type DropdownBaseProps = Omit<FlatHTMLAttributesDivElement, 'class'> & {
  /** HTML id applied to the dropdown root element. Auto-generated when omitted. */
  id?: string;
  /** Additional class names merged with the component's root class. */
  class?: string;
};
type LegacyDropdownProps = DropdownBaseProps & {
  /** Controls the open state of the dropdown menu; bindable for controlled usage. */
  open?: boolean;
  /**
   * Preferred menu placement relative to the trigger. Default `bottom-start`.
   * The rendered menu may still flip to stay within the viewport.
   */
  placement?: DropdownPlacement;
  trigger: Snippet;
  children: Snippet;
};
type CompoundDropdownProps = DropdownBaseProps & {
  id: string;
  children?: Snippet;
  trigger?: never;
  open?: never;
  /**
   * Preferred menu placement relative to the trigger. Default `bottom-start`.
   * The rendered menu may still flip to stay within the viewport.
   */
  placement?: DropdownPlacement;
};
export type DropdownProps = LegacyDropdownProps | CompoundDropdownProps;

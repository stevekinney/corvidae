import type { Snippet } from 'svelte';
import type { HTMLDialogAttributes } from 'svelte/elements';
export type DrawerPlacement = 'left' | 'right' | 'bottom';
export type DrawerSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';
/**
 * A height a bottom sheet rests at. `peek` is a collapsed bar that shows the sheet's title and live
 * count and opens on tap or drag, `medium` is half the viewport, and `large` is the sheet's full
 * height, 90% of the viewport.
 */
export type DrawerDetent = 'peek' | 'medium' | 'large';
export type DrawerProps = {
  /** Whether the drawer is open. Bindable via `bind:open`. */
  open?: boolean;
  /**
   * Edge the drawer slides in from.
   * @default 'right'
   */
  placement?: DrawerPlacement;
  /**
   * Drawer width token for `left`/`right` placements.
   * Ignored for `placement="bottom"`, which always spans the full viewport
   * width and caps its height at 90dvh.
   * `xs` is 280px, the width of a navigation drawer; `sm` is 360px, `md` 448px, `lg` 576px and `xl`
   * 768px.
   * @default 'md'
   */
  size?: DrawerSize;
  /**
   * Accessible name of the X icon close button, for a drawer that is not a generic one, such as "Close
   * navigation" on a sidebar's drawer.
   * @default 'Close drawer'
   */
  closeIconLabel?: string;
  /**
   * Whether the drawer is modal. Modal drawers use the native dialog top layer,
   * backdrop, body scroll lock, and focus trap. Non-modal drawers render as an
   * aside and leave the page interactive.
   * @default true
   */
  modal?: boolean;
  /**
   * Accessible name for the drawer. Required for screen-reader labelling.
   * Rendered as a visible `<h2>` in the default header. When a custom
   * `header` snippet is provided without `ariaLabelledby`, this text is
   * rendered in a visually-hidden `<h2>` as the accessible name fallback.
   */
  title: string;
  /** Additional class names merged with `.cinder-drawer`. */
  class?: string;
  /**
   * Optional reference to the element that opened the drawer. When supplied,
   * focus returns to this element on close. When omitted, focus restores to
   * the element that held focus before the drawer opened.
   */
  triggerRef?: HTMLElement | null;
  /**
   * Optional id of an element that names the drawer. When supplied, drawer
   * wires `aria-labelledby` to this id and renders no internal heading.
   * Use this when a custom `header` snippet has its own visible heading —
   * supply `ariaLabelledby` pointing to that heading's id so the
   * visible and accessible names stay in sync.
   */
  ariaLabelledby?: string;
  /**
   * Whether a `placement="bottom"` drawer shows the grabber, the small pill above the header that
   * marks it as a sheet. Swipe-to-close is not implemented, so the pill is a visual affordance
   * only, unless the drawer has `detents`: then the grabber is the resize control and always shows.
   * Ignored for `left`/`right` placements.
   *
   * Named `dragHandleVisible` (not `draggable`) to avoid colliding with the native HTML
   * `draggable` attribute on the underlying `<dialog>`.
   * @default true
   */
  dragHandleVisible?: boolean;
  /**
   * Words for the close control. When set, the control is a text button that reads these words
   * ("Close", as on the shared sheets) instead of the X icon, and they are its accessible name.
   * Left out, the control is the X icon named "Close drawer".
   */
  closeLabel?: string | undefined;
  /**
   * The heights a `placement="bottom"` drawer can rest at, from `peek`, `medium` and `large`. Listed
   * in any order, they are used smallest first. With two or more, the grabber becomes a resize
   * control: drag it, press ArrowUp and ArrowDown on it, or tap it, and the sheet snaps to the
   * nearest detent. A single detent fixes the sheet at that height. Left out, the sheet is as tall
   * as its content up to 90% of the viewport. Ignored for `left`/`right` placements.
   */
  detents?: DrawerDetent[];
  /**
   * The detent the sheet rests at, one of `detents`. Bindable via `bind:detent`. Left out, or not
   * one of `detents`, the sheet rests at the smallest detent.
   */
  detent?: DrawerDetent;
  /**
   * A live count the collapsed `peek` bar shows beside the title, such as "12 results". It is a
   * polite live region, so screen readers announce it as it changes. Only the peek bar draws it.
   */
  count?: string;
  /** Custom header. Falls back to a default header that renders `title`. */
  header?: Snippet;
  /** Drawer body content. Required. */
  children: Snippet;
  /** Optional footer (e.g. action buttons). */
  footer?: Snippet;
  /**
   * The primary action of a bottom sheet's header, such as "Apply" or "Done", drawn at the trailing
   * edge. With it, the sheet's default header is a three-column bar: the close control at the start
   * (a text "Cancel" when `closeLabel` says so), the title centred as a small label, and this action
   * at the end. Ignored for `left`/`right` placements and next to a custom `header`.
   */
  action?: Snippet;
  /**
   * Called once a close has fully finished: after the modal drawer's exit
   * transition and unmount, or as soon as a non-modal drawer closes. A
   * consumer that wraps Drawer in its own `{#if}` clears that gate here, so
   * the exit transition plays before the instance is destroyed.
   */
  onExitComplete?: () => void;
} & Omit<
  HTMLDialogAttributes,
  | 'open'
  | 'class'
  | 'children'
  | 'aria-labelledby'
  | 'aria-modal'
  | 'role'
  | 'onclose'
  | 'oncancel'
  | 'onclick'
>;

import type { Snippet } from 'svelte';
export type {
  SortableAnnouncements,
  SortableItemContext,
  SortableReorderChange,
} from '../../utilities/sortable-controller.types.ts';
/**
 * How a row can be reordered. `handle` is the drag handle, also reachable by keyboard. `buttons`
 * gives each row Move up and Move down buttons instead, with no drag handle, the single-pointer
 * alternative to dragging (WCAG 2.5.7). `both` keeps the handle and adds the buttons.
 */
export type SortableReorderMode = 'handle' | 'buttons' | 'both';
/** Props for the SortableList component. */
export type SortableListProps<Item> = {
  /** The list of items to render. */
  items: Item[];
  /** Returns a stable key for each item. Must not change across reorders. */
  getKey: (item: Item) => string | number;
  /**
   * Returns an accessible label for each item (e.g., "Buy milk").
   * The second argument is the item's original index in the `items` array
   * (not its current visual position during a drag).
   * Used in handle aria-label and announcements.
   */
  getItemLabel: (item: Item, originalIndex: number) => string;
  /** Optional formatter for the drag handle's accessible name. Default: "Reorder {itemLabel}". */
  formatHandleLabel?: (itemLabel: string) => string;
  /**
   * How a row is reordered; see `SortableReorderMode`. With `buttons` or `both` the row's context
   * carries a `moveButtons` snippet, which the row content renders where the buttons belong.
   * @default "handle"
   */
  reorderMode?: SortableReorderMode;
  /** Optional formatter for the Move up button's accessible name. Default: "Move {itemLabel} up". */
  formatMoveUpLabel?: (itemLabel: string) => string;
  /** Optional formatter for the Move down button's accessible name. Default: "Move {itemLabel} down". */
  formatMoveDownLabel?: (itemLabel: string) => string;
  /** Optional snippet rendered inside the drag-handle button. Receives { pressed, label }. */
  handle?: Snippet<[{ pressed: boolean; label: string }]>;
  /** Fires with the full reordered array and change metadata on drop. */
  onReorder: (
    nextItems: Item[],
    change: import('../../utilities/sortable-controller.types.ts').SortableReorderChange,
  ) => void;
  /** Optional overrides for announcement strings. */
  announcements?: Partial<
    import('../../utilities/sortable-controller.types.ts').SortableAnnouncements
  >;
  /** Row content snippet. Receives the item and a per-row context. */
  children: Snippet<
    [Item, import('../../utilities/sortable-controller.types.ts').SortableItemContext]
  >;
  /** Accessible name for the list (applied as aria-label on the list root). */
  label?: string;
  /** Additional class merged onto the `.cinder-sortable-list` root element. */
  class?: string;
};

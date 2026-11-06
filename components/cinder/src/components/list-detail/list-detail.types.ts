import type { Snippet } from 'svelte';
import type { HTMLAttributes } from 'svelte/elements';

import type { DataListGroup } from '../data-list/data-list.types.ts';

/** State a `list` snippet receives for the row it renders. */
export type ListDetailRowContext = {
  /** True when this row is the open item, the one the detail pane shows. */
  selected: boolean;
  /** True when the keyboard cursor, moved by `J` and `K`, is on this row. */
  active: boolean;
  /** Opens this row's item: selects it, writes it to the URL, and shows the detail pane. */
  open: () => void;
};

/** State the `listBody` snippet receives, for a list pane that draws its own rows. */
export type ListDetailListBodyContext<T> = {
  /** The records to list, in order. */
  items: T[];
  /** Key of the open item, or `null` when none is open. */
  selectedKey: string | null;
  /** Opens the item with this key: selects it, writes it to the URL, and shows the detail pane. */
  open: (key: string) => void;
};

/**
 * Reads and writes the selected key in the address bar. The default adapter uses
 * `window.location` and `history.replaceState`; pass another to test or to route differently.
 */
export type ListDetailSelectionLocation = {
  /** Returns the value of the search parameter, or `null` when it is absent. */
  read: (parameter: string) => string | null;
  /** Sets the search parameter to `key`, or removes it when `key` is `null`. */
  write: (parameter: string, key: string | null) => void;
};

/** The slice of `Storage` that ListDetail uses to remember the divider width. */
export type ListDetailStorage = Pick<Storage, 'getItem' | 'setItem'>;

/** Props for ListDetail. `items`, `key`, `label` and `detail` are required, and so is `list` unless `listBody` draws the rows. */
export type ListDetailProps<T> = Omit<HTMLAttributes<HTMLDivElement>, 'children' | 'class'> & {
  /** The records to list. Each is passed to `list` and, when selected, to `detail`. */
  items: T[];
  /** Key extractor. The key identifies an item in the keyboard cursor, the selection, and the URL. */
  key: (item: T) => string;
  /** Accessible name of the list region, for example "Chats". */
  label: string;
  /**
   * Row renderer, called once per item inside an `<li>` that ListDetail provides. Render a
   * `SelectableRow` with `selected={row.selected}` and `selectedState="current"`; activating its
   * primary action opens the item. Omit it when `listBody` draws the rows.
   */
  list?: Snippet<[item: T, row: ListDetailRowContext]>;
  /**
   * Draws the whole list pane body itself, in place of the `<li>` rows, for a list that is a table.
   * Give each row a `data-cinder-row-id` equal to its `key` (a `DataTable` does) so the J and K
   * cursor finds it, and call `open` when a row is chosen. `list`, `groupBy` and `listEmpty` are
   * ignored while it is set.
   */
  listBody?: Snippet<[context: ListDetailListBodyContext<T>]>;
  /**
   * Groups consecutive items under a header band, such as a source or a day. Passed to the list's
   * `DataList`, so a group is a nested list named by its header.
   */
  groupBy?: (item: T) => DataListGroup;
  /**
   * Shows a placeholder in place of the rows and the open item while the records load: five list
   * rows in the list pane and a block in the detail pane. Nothing shows for the first 300
   * milliseconds, so a fast load never flickers, and a slow one adds a "still loading" line after
   * ten seconds.
   * @default false
   */
  loading?: boolean;
  /**
   * What the loading region announces, politely, once the placeholder appears: "Loading memories".
   * @default 'Loading'
   */
  loadingLabel?: string;
  /** Detail renderer for the open item. */
  detail: Snippet<[item: T]>;
  /** Rendered in the detail pane while no item is open. A default message is shown when omitted. */
  empty?: Snippet;
  /** Rendered in the list when `items` is empty. */
  listEmpty?: Snippet;
  /**
   * List header, above the rows: the title, the count, the create action, the search and the
   * filter. Put the title and the create action on their own row and the filter below at full
   * width, so the action never reads as the filter's submit button.
   */
  header?: Snippet;
  /**
   * Opens the first item when none is open and the panes sit side by side, so the detail beside the
   * list is never empty. An item named by the URL, or by `selectedKey`, wins. Nothing opens while
   * the component shows one pane at a time (below `pushBelow`): there the list is where it starts.
   * @default false
   */
  openFirst?: boolean;
  /**
   * Key of the open item, or `null` when none is open. Bindable. When it is `null` on mount, the
   * item named by the URL's search parameter opens.
   * @default null
   */
  selectedKey?: string | null;
  /** Called with the new key when an item opens, and with `null` when the selection is cleared. */
  onSelectedKeyChange?: (key: string | null) => void;
  /**
   * Name of the search parameter that holds the open item's key. Pass `null` to keep the
   * selection out of the URL.
   * @default 'selected'
   */
  selectionParameter?: string | null;
  /** Where the selection is read and written. Defaults to the address bar. */
  selectionLocation?: ListDetailSelectionLocation;
  /**
   * Storage key under which the divider width is remembered. Omit to not remember it. The key is
   * the caller's, so two ListDetails on one page do not share a width.
   */
  storageKey?: string;
  /** Where the divider width is remembered. Defaults to `localStorage`. */
  storage?: ListDetailStorage;
  /**
   * Width in pixels of the component below which it shows one pane at a time: the list, then the
   * detail with a Back button. It is measured on the component, not the viewport.
   * @default 600
   */
  pushBelow?: number;
  /**
   * Width in pixels of the component below which, down to `pushBelow`, the two panes are shown one
   * above the other, the detail under the list, instead of side by side. The default `0` never
   * stacks them: the panes sit side by side until `pushBelow` and show one at a time under it.
   * @default 0
   */
  stackBelow?: number;
  /**
   * Removes the detail pane's inner padding, for a detail view that lays out its own header, body
   * and footer edge to edge (an open chat, a table, a code frame). In the stacked layout the open
   * detail also fills the height the component is given, so what it docks at its bottom edge, such as
   * a composer, sits at the bottom of the screen instead of after its content.
   * @default false
   */
  flushDetail?: boolean;
  /**
   * Width in pixels of the list pane before the divider is moved.
   * @default 280
   */
  defaultListWidth?: number;
  /**
   * Widest width in pixels the divider can give the list pane, and the most a remembered or default
   * width can be. Raise it for a list that is a table, whose columns need more than a list of rows.
   * @default 560
   */
  maximumListWidth?: number;
  /**
   * Label of the Back button shown above the detail below `pushBelow`.
   * @default 'Back'
   */
  backLabel?: string;
  /**
   * Accessible name of the detail region.
   * @default 'Details'
   */
  detailLabel?: string;
  /**
   * Title of the default empty detail, used when `empty` is omitted.
   * @default 'Nothing selected'
   */
  emptyTitle?: string;
  /**
   * Description of the default empty detail, used when `empty` is omitted.
   * @default 'Choose an item from the list to see it here.'
   */
  emptyDescription?: string;
  /** Additional class merged onto the `.cinder-list-detail` root element. */
  class?: string;
};

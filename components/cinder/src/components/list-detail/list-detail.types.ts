import type { Snippet } from 'svelte';
import type { HTMLAttributes } from 'svelte/elements';

/** State a `list` snippet receives for the row it renders. */
export type ListDetailRowContext = {
  /** True when this row is the open item, the one the detail pane shows. */
  selected: boolean;
  /** True when the keyboard cursor, moved by `J` and `K`, is on this row. */
  active: boolean;
  /** Opens this row's item: selects it, writes it to the URL, and shows the detail pane. */
  open: () => void;
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

/** Props for ListDetail. `items`, `key`, `label`, `list` and `detail` are required. */
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
   * primary action opens the item.
   */
  list: Snippet<[item: T, row: ListDetailRowContext]>;
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
   * @default 900
   */
  pushBelow?: number;
  /**
   * Width in pixels of the list pane before the divider is moved.
   * @default 320
   */
  defaultListWidth?: number;
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

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

/** How the selection changed, as `onSelectedKeyChange` reports it. */
export type ListDetailSelectionChange = {
  /**
   * True when ListDetail chose the item itself (`openFirst` opening the first item, or the new first
   * one after the open item left the list), false when the person or the address did.
   */
  automatic: boolean;
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
   * How many placeholder rows the list pane shows while `loading`, for a list whose design draws
   * fewer or more than five: a short inbox draws three.
   * @default 5
   */
  loadingRows?: number;
  /**
   * What the loading region announces, politely, once the placeholder appears: "Loading memories".
   * @default 'Loading'
   */
  loadingLabel?: string;
  /**
   * Adds a Cancel button to the loading placeholder's "still loading" line, for a read the person
   * can give up on. It is called when the button is pressed; the host decides what giving up
   * means (stop the read, show a "canceled" state). Without it the line has no button.
   */
  onLoadingCancel?: () => void;
  /** Detail renderer for the open item. */
  detail: Snippet<[item: T]>;
  /** Rendered in the detail pane while no item is open. A default message is shown when omitted. */
  empty?: Snippet;
  /** Rendered in the list when `items` is empty. */
  listEmpty?: Snippet;
  /**
   * Drawn at the end of the list pane, after the rows or after `listEmpty`, and outside `items`: it
   * is not a row, so it never stops `listEmpty` from drawing, is not selectable, and J and K never
   * land on it. Use it for a link to a related list that has no place among the rows, such as the
   * archived or quarantined ones. It is not drawn while the list is loading.
   */
  listFooter?: Snippet;
  /**
   * List header, above the rows: the title, the count, the create action, the search and the
   * filter. Put the title and the create action on their own row and the filter below at full
   * width, so the action never reads as the filter's submit button. The toggle that hides the list
   * (`listCollapsible`) is not part of it: ListDetail draws it in the header's start corner, and the
   * header's first row, whatever it holds, starts after it.
   */
  header?: Snippet;
  /**
   * Opens the first item drawn when none is open and the panes sit side by side, so the detail beside
   * the list is never empty: the first row on screen, after the host's filter, search and sort, which
   * for a table that sorts its own rows is not always `items[0]`. An item named by the URL, or by
   * `selectedKey`, wins, and one that names nothing in the list shows `notFound` rather than the
   * first item. When the open item leaves the list (a filter hides it), the new first item opens
   * (see `reopenFirst`), and when the list empties the selection is cleared. Nothing opens while the
   * component shows one pane at a time or one above the other (below `pushBelow` or `stackBelow`):
   * there the list is where it starts. An item it opens is reported to `onSelectedKeyChange` as
   * `automatic`, and focus stays where it was.
   * @default false
   */
  openFirst?: boolean;
  /**
   * With `openFirst`, whether the new first item opens when the open one, which the list showed,
   * leaves it. Turn it off for a host that says in the open item's place that it left (a review the
   * agent moved on from) and offers the way on itself; `notFound` is drawn there instead.
   * @default true
   */
  reopenFirst?: boolean;
  /**
   * With `openFirst`, drawn in the detail pane when the open key names nothing in the list: a link
   * to an item that was removed, or one the list never had. It receives the key. A default message
   * (`notFoundTitle`, `notFoundDescription`) is shown when omitted.
   */
  notFound?: Snippet<[key: string]>;
  /**
   * Title of the default not-found detail, used when `notFound` is omitted.
   * @default 'Not found'
   */
  notFoundTitle?: string;
  /**
   * Description of the default not-found detail, used when `notFound` is omitted.
   * @default 'This item is not in the list. It may have been removed.'
   */
  notFoundDescription?: string;
  /**
   * Key of the open item, or `null` when none is open. Bindable. When it is `null` on mount, the
   * item named by the URL's search parameter opens.
   * @default null
   */
  selectedKey?: string | null;
  /**
   * Called with the new key when an item opens, and with `null` when the selection is cleared. The
   * second argument says whether ListDetail chose it (`openFirst`) rather than the person, so a host
   * that navigates on a change replaces the history entry for it instead of adding one.
   */
  onSelectedKeyChange?: (key: string | null, change: ListDetailSelectionChange) => void;
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
   * Offers a toggle that hides the list pane while the panes sit side by side or one above the
   * other, so the detail takes the whole width. The toggle is one control in one place, the start
   * corner of the list's header, which is also where a narrow rail holds it once the list is hidden
   * (no rail is drawn while the list shows), so it is always on screen, never beside the header's
   * own actions, and does not move or lose focus as it flips. It is drawn with or without an open
   * item, so its corner is never empty; hidden with nothing open, the detail shows its empty state.
   * Below `pushBelow`, where one pane shows at a time, there is nothing to hide.
   * @default false
   */
  listCollapsible?: boolean;
  /**
   * Whether the list pane is hidden, with `listCollapsible`. Bindable. With `storageKey`, the
   * choice is remembered beside the divider width, and a remembered choice wins on mount.
   * @default false
   */
  listCollapsed?: boolean;
  /**
   * Accessible name and tooltip of the toggle while the list shows: what pressing it does.
   * @default 'Hide list'
   */
  collapseListLabel?: string;
  /**
   * Accessible name and tooltip of the toggle while the list is hidden.
   * @default 'Show list'
   */
  expandListLabel?: string;
  /**
   * Label of the Back button shown above the detail below `pushBelow`.
   * @default 'Back'
   */
  backLabel?: string;
  /**
   * Whether the Back button shows above the detail below `pushBelow`. A host whose own chrome
   * already carries the way back to the list (a top bar's back link) turns it off, so the screen
   * has one Back and not two. Back is also how a person returns to the list by keyboard, so the
   * host's way back must be a link or a button, and opening an item focuses the detail region
   * when there is no Back button to focus.
   * @default true
   */
  backVisible?: boolean;
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

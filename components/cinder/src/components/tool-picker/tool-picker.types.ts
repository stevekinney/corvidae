/**
 * One row of a ToolPicker: a tool the person can choose, or a skill they can only read.
 */
export type ToolPickerItem = {
  /** Stable identity of the item, and what `selected` holds when it is chosen. */
  value: string;
  /** The human name, drawn first on the row and used as the checkbox's accessible name. */
  label: string;
  /**
   * The raw identifier, drawn once beside the name in monospace (`bureau:discover-agents`). It is
   * not repeated anywhere else on the row.
   */
  code?: string;
  /** Muted words after the identifier ("Skill"), drawn after a middle dot. */
  suffix?: string;
  /** One line saying what the item does, under the name. */
  description?: string;
  /** The name of the group the item sits under, usually its source ("Built in", "GitHub"). */
  group: string;
  /**
   * A short word in the first trailing column, such as how risky the tool is ("Reads", "Changes
   * things", "Dangerous"). Left out, the column reads an em dash named by `emptyMetaLabel`.
   */
  meta?: string;
  /**
   * Text in the trailing column at the row's edge, such as the level the tool starts at ("Never
   * (default)"). It is read-only: changing it happens wherever the chosen tools are listed.
   */
  detail?: string;
  /**
   * Whether the person can choose the item. A skill follows the tools it uses, so it is listed with
   * no checkbox and its `detail` ("Follows its tools") in the trailing column.
   * @default true
   */
  selectable?: boolean;
};

/**
 * A group of items under one header. Groups appear in the order given; any group an item names that
 * is not listed follows, in order of first appearance.
 */
export type ToolPickerGroup = {
  /** The group's name, matching `ToolPickerItem.group`. */
  name: string;
  /**
   * Words after the count on the group's header ("they follow the tools they use"), for a group
   * whose items cannot be chosen. A group whose items can be chosen shows `noneChosenLabel` instead
   * when none of them is.
   */
  note?: string;
};

/** Props for the ToolPicker component. */
export type ToolPickerProps = {
  /**
   * Whether the picker is open. Bindable. It closes itself on Done and Cancel, on Escape and on a
   * click outside, and opens with the chosen items as `selected` says.
   */
  open: boolean;
  /**
   * The values of the chosen items. Bindable. The picker works on a copy while it is open: Done
   * writes it back (in the order of `items`, keeping any value no item names), and Cancel and
   * dismissing leave it alone.
   */
  selected?: string[];
  /** Everything that can be listed, in the order it should read within each group. */
  items: readonly ToolPickerItem[];
  /** The groups, in the order they should appear, with a note for a group that cannot be chosen from. */
  groups?: readonly ToolPickerGroup[] | undefined;
  /**
   * Heading of the dialog.
   * @default "Add tools and skills"
   */
  title?: string;
  /**
   * What the items are called, plural, in the counter, the group counts and the empty state
   * ("tools"). The counter reads "3 of 9 tools chosen".
   * @default "tools"
   */
  itemNoun?: string;
  /**
   * Accessible name and placeholder of the search field.
   * @default "Search tools and skills"
   */
  searchLabel?: string;
  /**
   * How many selectable items it takes to switch to the long-list layout: the counter reads the
   * total ("42 tools"), and every group but the first starts collapsed under its sticky header.
   * @default 40
   */
  collapseFrom?: number;
  /**
   * Draw the loading state: three skeleton rows, after 300 ms, under the title and a live search
   * field. Nothing can be chosen until it is false.
   * @default false
   */
  loading?: boolean;
  /**
   * Announced politely when the loading placeholder appears.
   * @default "Loading tools and skills"
   */
  loadingLabel?: string;
  /**
   * Words on a group's header, after its count, when none of its items is chosen and something else
   * is. Skills and other groups that cannot be chosen from show their `note` instead.
   * @default "none chosen"
   */
  noneChosenLabel?: string;
  /**
   * Names the trailing column of an item with no `meta`, which draws an em dash.
   * @default "No risk word"
   */
  emptyMetaLabel?: string;
  /**
   * The line shown when there is nothing at all to choose from (no search involved).
   * @default "No tools to choose from."
   */
  emptyLabel?: string;
  /**
   * The heading of the empty state, given what was typed.
   * @default (query) => `No ${itemNoun} match “${query}”`
   */
  noMatchTitle?: string | ((query: string) => string);
  /**
   * The line under the empty state's heading.
   * @default "Try a shorter word."
   */
  noMatchHint?: string;
  /**
   * Label of the button in the empty state that clears the search.
   * @default "Clear search"
   */
  clearSearchLabel?: string;
  /**
   * Label of the button that closes the picker and keeps the choices.
   * @default "Done"
   */
  doneLabel?: string;
  /**
   * Label of the button that closes the picker and drops the choices made in it.
   * @default "Cancel"
   */
  cancelLabel?: string;
  /** Called with the chosen values when Done is pressed, after `selected` is updated. */
  onDone?: (selected: string[]) => void;
  /** Called when the picker is closed without keeping its choices: Cancel, Escape or a click outside. */
  onCancel?: () => void;
  /** The element focus returns to when the picker closes, usually the button that opened it. */
  triggerRef?: HTMLElement | null;
  /** Additional CSS classes applied to the dialog. */
  class?: string;
};

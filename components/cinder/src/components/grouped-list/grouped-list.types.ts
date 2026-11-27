import type { Snippet } from 'svelte';
import type { HTMLAttributes } from 'svelte/elements';

/** Props for the GroupedList component. */
export type GroupedListProps = Omit<HTMLAttributes<HTMLUListElement>, 'class' | 'children'> & {
  /** A header drawn above the group, outside its surface and on its edge, in small muted text. It also names the list. */
  header?: string;
  /** A note drawn under the group, outside its surface and on its edge, in small muted text. */
  footer?: string;
  /**
   * A link to the full set when the group shows only part of it ("View the whole History"), drawn
   * under the group as a Cinder `Link` in its `more` form, on the group's edge, as the header and footer are. It renders after
   * `footer` when both are set. Use it instead of a link placed after the GroupedList, which nothing
   * spaces or insets. It always navigates, so it takes an `href` and no callback.
   */
  more?: { label: string; href: string };
  /** The rows: GroupedListItem elements. */
  children?: Snippet;
  /**
   * Adds a quick-add first row: a leading accent "+" and a borderless input. Return submits the
   * trimmed text here and clears the input; an empty entry is ignored.
   */
  onItemAdd?: (value: string) => void;
  /**
   * Accessible name of the quick-add input.
   * @default 'Add an item'
   */
  addLabel?: string;
  /** Placeholder text of the quick-add input. Left unset, it shows the label. */
  addPlaceholder?: string;
  /** Custom class merged with `.cinder-grouped-list`. */
  class?: string;
};

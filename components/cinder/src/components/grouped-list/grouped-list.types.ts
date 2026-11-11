import type { Snippet } from 'svelte';
import type { HTMLAttributes } from 'svelte/elements';

/** Props for the GroupedList component. */
export type GroupedListProps = Omit<HTMLAttributes<HTMLUListElement>, 'class' | 'children'> & {
  /** A header drawn above the group, outside its surface, in small muted text. It also names the list. */
  header?: string;
  /** A note drawn under the group, outside its surface, in small muted text. */
  footer?: string;
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

/** One key ListDetail handles itself, described for a shortcut map. */
export type ListDetailShortcut = {
  /** The key, as a person presses it. */
  readonly keys: readonly string[];
  /** What the key does. */
  readonly label: string;
};

/**
 * The keys ListDetail's list region handles while focus is in it. An application that lists its
 * shortcuts shows these beside its own, and does not handle them: the component already does.
 * The region's `aria-keyshortcuts` is built from this list, so the two never disagree.
 */
export const LIST_DETAIL_SHORTCUTS: readonly ListDetailShortcut[] = [
  { keys: ['J'], label: 'Next row' },
  { keys: ['K'], label: 'Previous row' },
  { keys: ['Enter'], label: 'Open the row' },
];

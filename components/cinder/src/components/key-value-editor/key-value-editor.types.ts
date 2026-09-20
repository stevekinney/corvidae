import type { HTMLAttributes } from 'svelte/elements';
export type KeyValueEntry = { key: string; value: string };
export type KeyValueEditorProps = Omit<HTMLAttributes<HTMLDivElement>, 'class'> & {
  /** The editable list of key/value rows. Bindable. */
  entries?: KeyValueEntry[];
  /** Callback form of the resulting array, for when the parent does not use `bind:entries`. */
  onValueChange?: (entries: KeyValueEntry[]) => void;
  /** Predicate receiving a row's key; routes that row's value through a password input when it returns `true`. */
  secret?: (key: string) => boolean;
  /** Label for the add-row action. Give it concrete wording when more than one editor is on the page. */
  addLabel?: string;
  /** Label for a row's remove action, given that row's key. Give it concrete wording when more than one editor is on the page. */
  removeLabel?: (key: string) => string;
  /** Additional class merged with the component's root class. */
  class?: string;
};

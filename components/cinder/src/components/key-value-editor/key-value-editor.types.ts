import type { HTMLAttributes } from 'svelte/elements';
/**
 * A single editable row. `id` is an immutable identity, independent of the
 * editable `key`/`value` text — it must be unique within one editor's
 * `entries`, but two rows may otherwise share equal `key`/`value` text.
 * Consumers own minting `id` for rows they supply; the editor mints one
 * itself for a row added by typing into the empty last row.
 */
export type KeyValueEntry = { id: string; key: string; value: string };
export type KeyValueEditorProps = Omit<HTMLAttributes<HTMLDivElement>, 'class'> & {
  /**
   * The editable list of key/value rows. Bindable. Defaults to `[]`.
   * (`KeyValueEntry` is not expressible in JSON Schema, so this default
   * only appears here in prose.)
   */
  entries?: KeyValueEntry[];
  /** Callback form of the resulting array, for when the parent does not use `bind:entries`. */
  onValueChange?: (entries: KeyValueEntry[]) => void;
  /** Predicate receiving a row's key; routes that row's value through a password input when it returns `true`. */
  secret?: (key: string) => boolean;
  /**
   * Accessible description of the empty last row, whose key and value boxes add a pair when typed
   * into. Give it concrete wording when more than one editor is on the page. Defaults to
   * `'Add pair'`.
   * @default 'Add pair'
   */
  addLabel?: string;
  /**
   * Label for a row's remove action, given that row's key. Give it concrete
   * wording when more than one editor is on the page. Defaults to
   * `` (key) => `Remove ${key || 'pair'}` ``—an empty key (a newly added,
   * not-yet-named row) falls back to `'Remove pair'`.
   */
  removeLabel?: (key: string) => string;
  /**
   * Visible name for the whole list, shown above the rows ("Environment"). The editor becomes a
   * labelled group, so a screen reader announces it when focus enters the list.
   */
  label?: string;
  /**
   * Help under the rows, linked to the group with `aria-describedby`. State what the values
   * are, such as that they are masked and never shown again.
   */
  description?: string;
  /**
   * Accessible name of every row's key input, also drawn once as the column heading above the
   * rows (the inputs have no visible label of their own). Give it the noun the rows use, such as
   * `'Name'` for environment variables.
   * @default 'Key'
   */
  keyLabel?: string;
  /**
   * Accessible name of every row's value input, also drawn once as the column heading above the
   * rows.
   * @default 'Value'
   */
  valueLabel?: string;
  /**
   * Draws the key and value inputs in the monospace face, for identifiers and secrets such as
   * environment variable names.
   * @default false
   */
  monospace?: boolean;
  /** Additional class merged with the component's root class. */
  class?: string;
};

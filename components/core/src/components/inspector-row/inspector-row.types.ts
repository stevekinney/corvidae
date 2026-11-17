import type { Snippet } from 'svelte';
import type { HTMLAttributes } from 'svelte/elements';

/** The built-in editors of an InspectorRow: a line of `text`, a `select` of options, a `date`, or a `toggle` that commits as soon as the row is activated. */
export type InspectorRowKind = 'text' | 'select' | 'date' | 'toggle';

/** A value an InspectorRow commits: the text of a `text`, `select` or `date` editor, or the new state of a `toggle`. */
export type InspectorRowValue = string | boolean;

/** One choice of a `select` row. */
export type InspectorRowOption = {
  /** The value committed when this choice is picked. */
  value: string;
  /** The text of the choice. */
  label: string;
};

/** What a custom `editor` receives to end its edit. */
export type InspectorRowEditorContext = {
  /** Closes the editor and calls `onCommit` with the given value. */
  commit: (next?: InspectorRowValue) => void;
  /** Closes the editor and calls `onCancel`. */
  cancel: () => void;
};

/** Props for the InspectorRow component. */
export type InspectorRowProps = Omit<HTMLAttributes<HTMLDivElement>, 'class' | 'children'> & {
  /** The row's label, drawn muted in a fixed-width column. */
  label: string;
  /** An optional icon drawn before the label. */
  icon?: Snippet;
  /** The row's value, as it reads at rest. */
  value: Snippet;
  /** The built-in editor an activation opens. Leave it unset, with no `editor`, for a read-only row. A `toggle` row has no editor: activating it commits the opposite of `current`. */
  kind?: InspectorRowKind;
  /** The value an editor starts from: the text of a `text`, `select` or `date` row, or the state of a `toggle`. */
  current?: InspectorRowValue;
  /** The choices of a `select` row. */
  options?: readonly InspectorRowOption[];
  /** A custom editor, shown in a popover anchored to the row's value. It wins over `kind`. */
  editor?: Snippet<[InspectorRowEditorContext]>;
  /** The accessible name of the editor. Left unset, it reads "Edit" and the label. */
  editLabel?: string;
  /**
   * Draws the row as read-only, even when it has an editor.
   * @default false
   */
  disabled?: boolean;
  /**
   * Marks the value as a suggestion that is not saved until the person confirms it: a quiet accent
   * text label under the row's label, with no tint, border or pill.
   * @default false
   */
  suggested?: boolean;
  /**
   * The words of the suggested label, such as "Suggested wording". Used with `suggested`.
   * @default "Suggested"
   */
  suggestedLabel?: string;
  /** Called when an edit is committed: with Enter, by leaving a field, by picking an option, by activating a toggle, or by a custom editor's `commit`. */
  onCommit?: (next: InspectorRowValue | undefined) => void;
  /** Called when an edit is cancelled: with Escape, by activating the row again, or by dismissing the popover. */
  onCancel?: () => void;
  /** Custom class merged with `.cinder-inspector-row`. */
  class?: string;
};

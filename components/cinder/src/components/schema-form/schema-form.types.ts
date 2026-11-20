import type { HTMLFormAttributes } from 'svelte/elements';

import type { JsonSchemaObject } from './schema-form-model.ts';

export type SchemaFormSchema = JsonSchemaObject;

export type SchemaFormOutput = unknown;

/** How a SchemaForm draws its fields; see {@link SchemaFormProps.variant}. */
export type SchemaFormVariant = 'default' | 'input' | 'setting-rows';

export type SchemaFormDraftChangeHandler = (value: SchemaFormOutput) => void;

/** One saved secret a form's secret field can name. */
export type SchemaFormSecretKey = {
  /** The key. It is the whole of what the field holds: `{ "$secret": key }`. */
  key: string;
  /** What groups the key in the list, such as the plugin that declares it. */
  group?: string;
  /** Whether a value is saved under the key. A key that is not set shows as Missing. */
  set: boolean;
};

/** The words of a form's secret fields. Every member has a default. */
export type SchemaFormSecretCopy = {
  /** Help under the field. */
  help: string;
  /** The trigger's text while no key is chosen. */
  placeholder: string;
  /** The disabled trigger's text when there is no key to choose. */
  emptyPlaceholder: string;
  /** What the form says when there is no key; a `manage` link follows it. */
  emptyHelp: string;
  /** What follows the `manage` link, such as a full stop. */
  emptyHelpEnd: string;
  /** The line shown when the keys could not be read. */
  failed: string;
  /** The button that reads them again. */
  retry: string;
  /** The warning under a chosen key that is not set; it names the key, which is drawn in monospace. */
  missing: (key: string) => string;
  /** The button on that warning. */
  addKey: string;
  /** An optional field's empty choice. */
  none: string;
  /** An option's note for a key that is set. */
  set: string;
  /** An option's note for a key that is not set. */
  missingNote: string;
  /** What a read-only form shows for a field it never shows, such as a password. */
  hidden: string;
  /** What a read-only form shows for a secret field that names no key. */
  notChosen: string;
  /** A read-only boolean's two words. */
  yes: string;
  /** The text for a false value in a read-only boolean field. */
  no: string;
};

/**
 * What a form needs to draw a field marked `secret: true`: the saved keys to choose from, the words,
 * and what to do when the person wants to add a missing key or read the keys again. The form never
 * holds a secret's value: the field is `{ "$secret": key }` and nothing else.
 */
export type SchemaFormSecrets = {
  /** The keys the field offers, each with its group and whether it is set. */
  keys: readonly SchemaFormSecretKey[];
  /** `failed` when the keys could not be read: the field says so and the rest of the form stays usable. */
  status?: 'ready' | 'failed';
  /** Words that replace the defaults. */
  copy?: Partial<SchemaFormSecretCopy>;
  /** Called with the chosen key when the person asks to add it, which is a key that is not set. */
  onAdd?: (key: string) => void;
  /** Called when the person asks to read the keys again (`status` is `failed`). */
  onRetry?: () => void;
  /** Where to save a key when there is none to choose: a link after `copy.emptyHelp`. */
  manage?: { label: string; href: string; onclick?: (event: MouseEvent) => void };
};

export type SchemaFormSubmitHandler = (
  value: SchemaFormOutput,
  event: SubmitEvent,
) => void | Promise<void>;

/** Props for the SchemaForm component. */
export type SchemaFormProps = Omit<HTMLFormAttributes, 'class' | 'onsubmit'> & {
  /** JSON Schema object used to render and validate the form. */
  schema: SchemaFormSchema;
  /**
   * Initial form value. Missing fields are seeded from the schema where possible.
   *
   * **Seed-only — value changes do not reset form state.** After mount the
   * consumer owns the form state. Changing `value` with the same `schema` does
   * NOT reset the form (formValue, errors, rawDrafts). Only changing `schema`
   * causes a remount and resets form state. This is intentional: the form is an
   * editing surface and resetting it on every external value change would
   * silently discard in-progress user edits.
   */
  value?: unknown;
  /**
   * Whether a large form offers its own Edit as JSON panel. Defaults to `true`; set `false` when
   * the host already provides a JSON entry point for the same payload, so the page does not show
   * two. Find a field and the other large-form affordances are unaffected.
   */
  jsonEditable?: boolean;
  /**
   * Problems the host found with a value this form submitted, such as a server-side validation
   * refusal. Each one is shown on the field its `path` names, as a built-in validation message is,
   * and cleared when that field is edited. Pass a new array to show a new set.
   */
  issues?: readonly { path: readonly (string | number)[]; message: string }[] | undefined;
  /** Name of the hidden serialized output field. Defaults to `value`. */
  name?: string;
  /** Label for the built-in submit button. Defaults to `Submit`. */
  submitLabel?: string;
  /**
   * How the fields are drawn. `default` is the plain form. `input` is the Input block of a page
   * that runs or schedules something: short fields share a row two at a time (a switch, an
   * array, a group or a JSON field takes the whole row), a boolean is a switch with its
   * description beside it, and an array of objects is one JSON editor whose status line counts
   * the items. `setting-rows` draws each top-level property as one Settings row (`SettingRow`):
   * the label, the key and the description at the start, the control at the inline end, and a
   * hairline between rows. A property whose control does not fit a column (an object, an array of
   * objects, a JSON field) is drawn under its row, full width and with no box of its own. The
   * rows stack below a container width. A large form keeps the same rows: no Find a field, no
   * Edit as JSON, no reordering.
   * @default "default"
   */
  variant?: SchemaFormVariant;
  /**
   * Whether every control is disabled, such as a form the host locks. The form is also disabled
   * while it validates a submit. Defaults to `false`.
   */
  disabled?: boolean;
  /**
   * Whether the form draws its own submit button. Set `false` when the host submits the form from
   * a button elsewhere on the page, such as a footer, whose `form` attribute names this form's
   * `id`. Without the built-in button a form with several fields does not submit on Enter. Defaults to `true`.
   */
  submitVisible?: boolean;
  /**
   * Whether the form is drawn inside another surface, such as a card or a page's own form. A hosted
   * form is a `div` with `role="group"` and no `<form>` of its own, which a `<form>` in a `<form>`
   * would be, so it never submits, draws no submit button and offers no Edit as JSON panel. A group
   * inside it is a legend line with its fields indented and no border, and the items of an array
   * are told apart by a hairline instead of a dashed box, so the host's own border is the only box.
   * Read the value through `onDraftChange`. Defaults to `false`.
   */
  hosted?: boolean;
  /**
   * The saved secret keys a field marked `secret: true` offers, with the words and actions around
   * it. A schema string marked `secret: true` is drawn as a Select of keys (never a text input) and
   * its value is `{ "$secret": key }`. Without this prop such a field has no key to choose.
   */
  secrets?: SchemaFormSecrets;
  /**
   * Draws every field as a label and its value, with no control, no submit button and no Edit
   * as JSON: a form the person can read and not change, such as a default hook's configuration. A
   * secret field shows its key in monospace beside a Set or Missing dot, and a `writeOnly` field
   * shows "Hidden". Defaults to `false`.
   */
  readOnly?: boolean;
  /** Custom class merged with `.cinder-schema-form`. */
  class?: string;
  /** Called after validation passes with the schema-conformant output value. */
  onSubmit?: SchemaFormSubmitHandler;
  /**
   * Called after each edit with the complete current draft, before schema validation.
   * The draft can be schema-invalid and does not change the seed-only `value` contract.
   * In-progress numeric editors and temporarily unparseable JSON fields are reported as
   * their current raw text until the value commits or parses successfully.
   */
  onDraftChange?: SchemaFormDraftChangeHandler;
};

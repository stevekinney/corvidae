import type { HTMLAttributes } from 'svelte/elements';

/** Schema-facing payload value. Kept permissive to match the runtime `unknown` prop. */
export type PayloadInspectorSchemaValue = unknown;

/** Which view of a structured payload the inspector shows. */
export type PayloadInspectorView = 'fields' | 'json';

/** A value in the Fields view, passed to `linkFor` so it can say where the value leads. */
export type PayloadInspectorField = {
  /** Property names from the payload root down to this value. Array entries use their 1-based position. */
  path: string[];
  /** The property name of this value, or its 1-based position in an array. */
  key: string;
  /** The value itself. Only scalars (text, numbers, booleans) are offered. */
  value: unknown;
};

/**
 * Props for the PayloadInspector component.
 */
export type PayloadInspectorProps = Omit<HTMLAttributes<HTMLElement>, 'class' | 'children'> & {
  /**
   * The payload value to inspect. Pass any JSON-serializable value — object,
   * array, string, number, boolean, or null. Plain strings are rendered as
   * string values; strings that look like serialized JSON are parsed, and one
   * that does not parse is shown as text. Pass `undefined` when there is no
   * payload, which draws one muted line and no card. While `streaming`, pass
   * the JSON text received so far.
   */
  value?: unknown;
  /**
   * When true, the payload has been truncated by the producer (e.g. because it
   * exceeded a wire size limit). The inspector renders a truncation badge in
   * the header.
   */
  truncated?: boolean;
  /**
   * Maximum serialized size before nothing is rendered. A payload over it shows
   * only its size, a Copy button and a Download JSON button. Defaults to
   * 1,048,576 (1 MB).
   */
  maxBytes?: number;
  /**
   * Initial collapse depth. In the JSON view, nodes deeper than this start
   * collapsed; in the Fields view, an object nested deeper than this starts
   * collapsed. Defaults to 1.
   */
  initialDepth?: number;
  /**
   * Hard depth cap. Nodes deeper than this never render their children.
   * Defaults to 50.
   */
  maxDepth?: number;
  /**
   * Custom parser applied when `value` is a string. Receives the raw string
   * and must return a parsed value or throw. Defaults to JSON.parse. Use this
   * to support alternative serialization formats.
   */
  parse?: (raw: string) => unknown;
  /**
   * A heading drawn at the left of the header row, before the Fields / JSON
   * switch, such as "Input" or "Output". It also names the card for assistive
   * technology; without one the card is named "Payload".
   */
  label?: string;
  /**
   * Which view the payload shows. `'fields'` lists each property with a
   * sentence-case label; `'json'` shows the stored payload with its raw keys.
   * Bindable, and switched by the Fields / JSON control in the header row.
   * @default "fields"
   */
  view?: PayloadInspectorView;
  /**
   * Returns the address a value in the Fields view leads to, so a value that
   * names something (a run, a workflow, a user) can link to it. Return
   * `undefined` to leave the value as text. The JSON view is never linked.
   */
  linkFor?: (field: PayloadInspectorField) => string | undefined;
  /**
   * Secret paths: values to hide in both views and in Copy, before anything is
   * laid out. Each path is dot-separated property names from the root, array
   * positions count from 1, and `*` stands for any one name or position (`headers.authorization`,
   * `attachments.*.token`). Read them from a JSON Schema with
   * `readSecretPaths`. When this is not passed, a property whose name reads as
   * a secret (token, key, password, authorization) is hidden as a fallback;
   * pass `[]` to hide nothing.
   */
  redact?: readonly string[];
  /**
   * Writes a value in the Fields view as the caller wants it, such as cents as
   * dollars. It receives the path and the stored value; return `undefined` to
   * keep the default. The JSON view and Copy always show the stored value.
   */
  formatValue?: (field: PayloadInspectorField) => string | undefined;
  /**
   * True while the payload is still arriving. `value` is the JSON text received
   * so far: fields appear as they complete, the last one shows "Receiving…", the
   * count reads "so far", and Copy waits until the stream ends.
   */
  streaming?: boolean;
  /**
   * True when the payload failed to load. The card keeps its header, hides the
   * switch, disables Copy, and shows `failedMessage` with a Try again button.
   */
  failed?: boolean;
  /** What a failed load says. Defaults to "Couldn't load the full result." */
  failedMessage?: string;
  /** Called when Try again is pressed after a failed load. Without it, no button is drawn. */
  onRetry?: () => void;
  /** The muted line shown when there is no payload. Defaults to "No payload". */
  emptyLabel?: string;
  /** The file name Download JSON saves a payload over `maxBytes` as. Defaults to "payload.json". */
  downloadFilename?: string;
  /**
   * Draws the payload without its card, for a pane that already is one: no border, no divider under
   * the header, and no count or Copy button, since the pane carries its own Copy. The Fields view is
   * always one label and value per row with a quiet rule between rows, never the inline or grid
   * layouts, so a person reads a record as a list. The Fields / JSON switch sits at the end of the
   * header row, across from the label.
   * @default false
   */
  bare?: boolean;
  /**
   * Shows a string `value` as it is, as text in a code block under the label, whatever it holds:
   * the Fields / JSON switch is not drawn, nothing is parsed and no invalid-JSON notice appears.
   * Use it for a value that is not JSON, or one too long to lay out as fields, and say so beside
   * it. A value that is not a string is shown as usual.
   * @default false
   */
  plain?: boolean;
  /** Additional CSS classes applied to the root element. */
  class?: string;
};

/**
 * Cinder-specific schema surface for PayloadInspector.
 *
 * The callbacks are documented but marked unsupported because functions
 * cannot be represented as JSON Schema controls.
 */
export type PayloadInspectorSchemaProps = {
  /**
   * The payload value to inspect. Pass any JSON-serializable value — object,
   * array, string, number, boolean, or null. Plain strings are rendered as
   * string values; strings that look like serialized JSON are parsed, and one
   * that does not parse is shown as text. Pass `undefined` when there is no
   * payload, which draws one muted line and no card. While `streaming`, pass
   * the JSON text received so far.
   *
   * @schemaPermissive
   */
  value?: PayloadInspectorSchemaValue;
  /**
   * When true, the payload has been truncated by the producer (e.g. because it
   * exceeded a wire size limit). The inspector renders a truncation badge in
   * the header.
   */
  truncated?: boolean;
  /**
   * Maximum serialized size before nothing is rendered. A payload over it shows
   * only its size, a Copy button and a Download JSON button. Defaults to
   * 1,048,576 (1 MB).
   */
  maxBytes?: number;
  /**
   * Initial collapse depth. In the JSON view, nodes deeper than this start
   * collapsed; in the Fields view, an object nested deeper than this starts
   * collapsed. Defaults to 1.
   */
  initialDepth?: number;
  /**
   * Hard depth cap. Nodes deeper than this never render their children.
   * Defaults to 50.
   */
  maxDepth?: number;
  /**
   * Which view the payload shows. `'fields'` lists each property with a
   * sentence-case label; `'json'` shows the stored payload with its raw keys.
   * Bindable, and switched by the Fields / JSON control in the header row.
   * @default "fields"
   */
  view?: PayloadInspectorView;
  /**
   * A heading drawn at the left of the header row, before the Fields / JSON
   * switch, such as "Input" or "Output". It also names the card for assistive
   * technology; without one the card is named "Payload".
   */
  label?: string;
  /**
   * Secret paths: values to hide in both views and in Copy, before anything is
   * laid out. Each path is dot-separated property names from the root, array
   * positions count from 1, and `*` stands for any one name or position (`headers.authorization`,
   * `attachments.*.token`). Read them from a JSON Schema with
   * `readSecretPaths`. When this is not passed, a property whose name reads as
   * a secret (token, key, password, authorization) is hidden as a fallback;
   * pass `[]` to hide nothing.
   */
  redact?: readonly string[];
  /**
   * True while the payload is still arriving. `value` is the JSON text received
   * so far: fields appear as they complete, the last one shows "Receiving…", the
   * count reads "so far", and Copy waits until the stream ends.
   */
  streaming?: boolean;
  /**
   * True when the payload failed to load. The card keeps its header, hides the
   * switch, disables Copy, and shows `failedMessage` with a Try again button.
   */
  failed?: boolean;
  /** What a failed load says. Defaults to "Couldn't load the full result." */
  failedMessage?: string;
  /** The muted line shown when there is no payload. Defaults to "No payload". */
  emptyLabel?: string;
  /** The file name Download JSON saves a payload over `maxBytes` as. Defaults to "payload.json". */
  downloadFilename?: string;
  /**
   * Draws the payload without its card, for a pane that already is one: no border, no divider under
   * the header, and no count or Copy button, since the pane carries its own Copy. The Fields view is
   * always one label and value per row with a quiet rule between rows, never the inline or grid
   * layouts, so a person reads a record as a list. The Fields / JSON switch sits at the end of the
   * header row, across from the label.
   * @default false
   */
  bare?: boolean;
  /**
   * Shows a string `value` as it is, as text in a code block under the label, whatever it holds:
   * the Fields / JSON switch is not drawn, nothing is parsed and no invalid-JSON notice appears.
   * Use it for a value that is not JSON, or one too long to lay out as fields, and say so beside
   * it. A value that is not a string is shown as usual.
   * @default false
   */
  plain?: boolean;
  /** Additional CSS classes applied to the root element. */
  class?: string;
};

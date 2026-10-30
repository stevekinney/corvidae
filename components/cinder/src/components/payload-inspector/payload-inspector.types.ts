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
   * string values; strings that look like serialized JSON are parsed. Pass
   * `undefined` when no payload is available yet.
   */
  value?: unknown;
  /**
   * When true, the payload has been truncated by the producer (e.g. because it
   * exceeded a wire size limit). The inspector renders a truncation badge in
   * the header.
   */
  truncated?: boolean;
  /**
   * Maximum byte size before the tree view is replaced with an oversize
   * placeholder. Defaults to 1,048,576 (1 MB).
   */
  maxBytes?: number;
  /**
   * Initial collapse depth for the JSON tree. Nodes deeper than this start
   * collapsed. Defaults to 1.
   */
  initialDepth?: number;
  /**
   * Hard depth cap for the JSON tree. Nodes deeper than this never render
   * their children. Defaults to 50.
   */
  maxDepth?: number;
  /**
   * Custom parser applied when `value` is a string. Receives the raw string
   * and must return a parsed value or throw. Defaults to JSON.parse. Use this
   * to support alternative serialization formats.
   */
  parse?: (raw: string) => unknown;
  /**
   * Visible header label for the inspector. Defaults to "Payload inspector".
   */
  label?: string;
  /**
   * Which view a structured payload (an object or array) shows. `'fields'`
   * lists each property with a formatted label; `'json'` shows the collapsible
   * JSON tree. Bindable, and switched by the Fields / JSON control in the
   * heading row. A value that is not structured has one view and no control.
   * @default "fields"
   */
  view?: PayloadInspectorView;
  /**
   * Returns the address a value in the Fields view leads to, so a value that
   * names something (a run, a workflow, a user) can link to it. Return
   * `undefined` to leave the value as text. The JSON view is never linked.
   */
  linkFor?: (field: PayloadInspectorField) => string | undefined;
  /** Additional CSS classes applied to the root element. */
  class?: string;
};

/**
 * Cinder-specific schema surface for PayloadInspector.
 *
 * The parser callback is documented but marked unsupported because functions
 * cannot be represented as JSON Schema controls.
 */
export type PayloadInspectorSchemaProps = {
  /**
   * The payload value to inspect. Pass any JSON-serializable value — object,
   * array, string, number, boolean, or null. Plain strings are rendered as
   * string values; strings that look like serialized JSON are parsed. Pass
   * `undefined` when no payload is available yet.
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
   * Maximum byte size before the tree view is replaced with an oversize
   * placeholder. Defaults to 1,048,576 (1 MB).
   */
  maxBytes?: number;
  /**
   * Initial collapse depth for the JSON tree. Nodes deeper than this start
   * collapsed. Defaults to 1.
   */
  initialDepth?: number;
  /**
   * Hard depth cap for the JSON tree. Nodes deeper than this never render
   * their children. Defaults to 50.
   */
  maxDepth?: number;
  /**
   * Which view a structured payload (an object or array) shows. `'fields'`
   * lists each property with a formatted label; `'json'` shows the collapsible
   * JSON tree. Bindable, and switched by the Fields / JSON control in the
   * heading row.
   * @default "fields"
   */
  view?: PayloadInspectorView;
  /**
   * Visible header label for the inspector. Defaults to "Payload inspector".
   */
  label?: string;
  /** Additional CSS classes applied to the root element. */
  class?: string;
};

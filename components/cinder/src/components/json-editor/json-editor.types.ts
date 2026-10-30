import type { HTMLTextareaAttributes } from 'svelte/elements';

/**
 * The subset of JSON Schema that JsonEditor reads to offer completions.
 *
 * Completion follows `properties`, `additionalProperties`, `items`, local `$ref` pointers, and the
 * `allOf`, `anyOf`, and `oneOf` combinators, and offers property names, `enum` and `const` values,
 * and `true` or `false` for boolean properties. Keywords outside this subset are ignored, never
 * reported as an error, and the schema never rejects what the user types.
 */
export interface JsonEditorSchema {
  /** A local JSON pointer such as `#/$defs/connection`; remote references are not followed. */
  $ref?: string;
  /** Named schemas that a local `$ref` can point at. */
  $defs?: Record<string, JsonEditorSchema>;
  /** Legacy name for `$defs`. */
  definitions?: Record<string, JsonEditorSchema>;
  /** The JSON type or types the value may take. */
  type?: string | readonly string[];
  /** Text shown beside a suggestion. */
  description?: string;
  /** The schema for each named property of an object. */
  properties?: Record<string, JsonEditorSchema>;
  /** The schema for every property that `properties` does not name. */
  additionalProperties?: boolean | JsonEditorSchema;
  /** The schema for each array element. */
  items?: JsonEditorSchema;
  /** The values the schema allows. */
  enum?: readonly unknown[];
  /** The single value the schema allows. */
  const?: unknown;
  /** Schemas that all apply to the same value. */
  allOf?: readonly JsonEditorSchema[];
  /** Schemas of which at least one applies. */
  anyOf?: readonly JsonEditorSchema[];
  /** Schemas of which exactly one applies. */
  oneOf?: readonly JsonEditorSchema[];
}

export type JsonEditorProps = Omit<
  HTMLTextareaAttributes,
  'id' | 'value' | 'class' | 'onchange' | 'oninput'
> & {
  /** Unique identifier used for the label and feedback relationships. */
  id: string;
  /** Controlled JSON source text. */
  value: string;
  /** Visible label for the editor. */
  label: string;
  /** Supporting text announced with the editor. */
  description?: string;
  /** External validation error. Takes precedence over JSON parse feedback. */
  error?: string;
  /** The most lines the editor shows before it scrolls. It grows with its content up to this height, so a short value is not a large empty box. Defaults to 8. @default 8 */
  rows?: number;
  /** Disables the editor. A disabled field is not posted with its form. */
  disabled?: boolean;
  /** Marks the editor as required. An empty value is valid and reads "Not set" unless the field is required. */
  required?: boolean;
  /** Whether valid JSON should render an announced success message. Defaults to true. @default true */
  validFeedbackVisible?: boolean;
  /** A JSON Schema that drives property-name and value completion. Without one the editor offers no completions. */
  schema?: JsonEditorSchema;
  /** Called with the proposed JSON source whenever the user edits the field. */
  onValueChange?: (value: string) => void;
  /** Extra class names merged onto the field wrapper. */
  class?: string;
};

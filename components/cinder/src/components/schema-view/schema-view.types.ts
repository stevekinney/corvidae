import type { HTMLAttributes } from 'svelte/elements';

/**
 * Props for SchemaView.
 *
 * SchemaView is read-only: it shows what a JSON Schema describes, one line per
 * field, and offers the raw document behind a disclosure. To edit a schema, use
 * `JsonSchemaEditor`.
 */
export type SchemaViewProps = Omit<HTMLAttributes<HTMLElement>, 'class' | 'children'> & {
  /**
   * The JSON Schema to show, as a parsed object. Local `$ref`s into `$defs` or
   * `definitions` are followed and `allOf` members are merged. A schema that is
   * not an object with properties shows one `Value` line naming its type.
   */
  schema: unknown;
  /**
   * Accessible name of the view, for example "Workflow input". It is the
   * `aria-label` of the region, so name what the schema describes.
   * @default "Schema"
   */
  label?: string;
  /**
   * How many levels of nested objects are expanded. Deeper objects show their
   * line without their fields, and the raw document still holds them.
   * @default 8
   */
  maxDepth?: number;
  /**
   * Label of the disclosure that reveals the raw schema document.
   * @default "View JSON Schema"
   */
  rawLabel?: string;
  /**
   * Text shown when the schema declares no fields.
   * @default "This schema declares no fields."
   */
  emptyLabel?: string;
  /** Additional class merged onto the `.cinder-schema-view` root element. */
  class?: string;
};

import type { HTMLAttributes } from 'svelte/elements';

/**
 * Props for SchemaView.
 *
 * SchemaView is read-only: it shows what a JSON Schema describes as one aligned
 * grid of Field, Type and Description (or as unframed rows), one row per field,
 * and offers the raw document behind a disclosure or open beside the fields. To
 * edit a schema, use `JsonSchemaEditor`.
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
   * Label of the raw schema document: the disclosure's trigger, or the title over the code block.
   * @default "JSON schema"
   */
  rawLabel?: string;
  /**
   * How the fields are drawn. `table` is the framed grid of Field, Type and Description under a
   * header row. `rows` is one unframed row per field, its name flush with the text above it, then
   * the word "Required", then its type as plain words, with its description and rules on the line
   * below.
   * @default "table"
   */
  layout?: 'table' | 'rows';
  /**
   * Where the raw schema document is. `collapsed` puts it behind a closed disclosure after the
   * fields. `beside` shows it open in a JSON code block: beside the fields when the view is at
   * least 38rem wide, under them when it is narrower. `none` leaves it out.
   * @default "collapsed"
   */
  raw?: 'collapsed' | 'beside' | 'none';
  /**
   * Text shown, in a bordered box instead of an empty grid, when the schema
   * declares no fields.
   * @default "This schema takes no fields, so there is nothing to fill in."
   */
  emptyLabel?: string;
  /**
   * A note shown as the last line of the frame, below the rows. Use it to say
   * how to read the grid, for example how a choice's branches are labelled.
   */
  caption?: string;
  /** Additional class merged onto the `.cinder-schema-view` root element. */
  class?: string;
};

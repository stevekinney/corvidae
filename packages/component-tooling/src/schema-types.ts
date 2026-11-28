/**
 * The shape of every generated component schema, which the `metadata` task writes to
 * `.metadata/<name>/schema.json` and the package exports as `@lostgradient/cinder/<name>/schema`.
 *
 * This file is not exposed as a public package subpath; the generator and Cinder's own tests
 * type the JSON they read with it.
 *
 * Schema dialect: JSON Schema draft 2020-12. The `$schema` URI is included on
 * every emitted schema and validated by the generator.
 */

export type ComponentSchemaUnsupportedReason =
  | 'function-or-snippet'
  | 'generic-type-parameter'
  | 'mapped-type'
  | 'conditional-type'
  | 'index-signature'
  | 'unknown-shape';

export interface ComponentSchemaUnsupportedProp {
  readonly name: string;
  readonly reason: ComponentSchemaUnsupportedReason;
  /**
   * `true` when the prop is required on the component; omitted when it is
   * optional. Present for props that the JSON schema cannot express but that are
   * still part of the component's API (e.g. a required `onSelect: () => void`
   * callback), so tooling and docs can report them faithfully. An absent value
   * is treated as not-required.
   */
  readonly required?: boolean;
  /** The prop's authored JSDoc description, when one exists. */
  readonly description?: string;
}

export interface ComponentSchemaMetadata {
  readonly unsupportedProps?: readonly ComponentSchemaUnsupportedProp[];
}

export interface ComponentSchema {
  readonly $schema: 'https://json-schema.org/draft/2020-12/schema';
  readonly type: 'object';
  readonly properties: Readonly<Record<string, unknown>>;
  readonly required?: readonly string[];
  readonly allOf?: readonly Readonly<Record<string, unknown>>[];
  readonly additionalProperties?: boolean;
  readonly $defs?: Readonly<Record<string, unknown>>;
  readonly metadata?: ComponentSchemaMetadata;
}

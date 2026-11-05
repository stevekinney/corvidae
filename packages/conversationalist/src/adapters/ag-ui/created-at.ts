/**
 * Where an AG-UI message carries the time its row was written.
 *
 * An AG-UI 1.0 message has no time of its own, so a backend that records when each row was
 * written has nowhere standard to say so, and a client that imports its snapshot would stamp every
 * row with the moment of the import. Export writes a row's `createdAt` here when asked to
 * ({@link AGUIExportOptions.createdAt}); import always reads it back into the row's `createdAt` and
 * leaves the entry out of the row's metadata. A tool call's time travels in the call's own
 * `metadata`, so each call of a message keeps its own.
 */
export const CREATED_AT_METADATA_KEY = 'conversationalist:createdAt';

/** What {@link toAGUIMessages} can be asked to carry beyond the protocol's own fields. */
export interface AGUIExportOptions {
  /**
   * Writes each row's `createdAt` into its message's metadata (and each tool call's into the
   * call's), under {@link CREATED_AT_METADATA_KEY}, so an importer keeps the recorded time.
   * Off by default, so an export is the protocol's own shape unless the caller asks.
   */
  readonly createdAt?: boolean | undefined;
}

/**
 * The time `metadata` records under {@link CREATED_AT_METADATA_KEY}, when it holds a string that
 * parses as a date; anything else is no time.
 */
export function readCreatedAt(metadata: Record<string, unknown> | undefined): string | undefined {
  const value = metadata?.[CREATED_AT_METADATA_KEY];
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : undefined;
}

/** `metadata` without the {@link CREATED_AT_METADATA_KEY} entry. */
export function withoutCreatedAt(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (metadata === undefined || !Object.hasOwn(metadata, CREATED_AT_METADATA_KEY)) return metadata;
  const { [CREATED_AT_METADATA_KEY]: _createdAt, ...rest } = metadata;
  return rest;
}

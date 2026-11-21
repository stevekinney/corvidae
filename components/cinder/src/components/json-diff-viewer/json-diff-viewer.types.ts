/**
 * A structural comparison of two JSON values. Objects compare by key and arrays by index, to any
 * depth up to `maxDepth`; a value that changes type shows as one removed and one added entry.
 * Unchanged entries start collapsed behind a control, and a level shows its first 200 entries
 * before a control reveals more, so a large comparison renders a bounded number of elements.
 */
export type JsonDiffViewerProps = {
  /** The value to compare from. Any JSON-serializable structure. */
  before: unknown;
  /** The value to compare to. Any JSON-serializable structure. */
  after: unknown;
  /** The accessible name of the comparison. Default "JSON differences". */
  label?: string;
  /**
   * Hard depth cap. Collections nested deeper than this are compared whole and show as one
   * changed entry, never walked. Default 50.
   */
  maxDepth?: number;
  /** Additional class names merged with `.cinder-json-diff-viewer`. */
  class?: string;
};

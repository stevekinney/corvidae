/**
 * How a crash-scenario child hands its result to the test that spawned it, and how the test reads
 * it back (COR-1928).
 *
 * The children write a marker or report file, then die by SIGKILL, so the file is the only channel.
 * The parent learns the file exists by looking for it. `writeFileSync` creates the file empty
 * before it writes the first byte, so a parent that looks at the wrong instant sees a file that
 * exists and holds nothing, or half of what the child meant: `JSON.parse` then throws `Unexpected
 * EOF` on a loaded host and never on an idle one. {@link publishChildFile} closes that window at
 * the writer: it writes the whole text to a sibling file and renames it into place, and a rename is
 * atomic on one filesystem, so the path either does not exist or holds the complete text.
 * {@link readChildJson} is the reader's half: a file that is nevertheless empty or cut short is
 * reported as exactly that, never parsed in part.
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs';

/** The suffix of the sibling file {@link publishChildFile} writes before it renames. */
export const CHILD_FILE_STAGING_SUFFIX = '.partial';

/**
 * Writes `text` to `path` so that `path` never holds less than all of it: the text goes to
 * `<path>.partial` first and is renamed over `path` once written. Synchronous, so it is on disk
 * before a kill that follows. `beforePublish` runs after the text is staged and before the rename:
 * it is the moment a reader on another process would see the write under way, which a test cannot
 * otherwise stop at.
 */
export function publishChildFile(
  path: string,
  text: string,
  options: { readonly beforePublish?: () => void } = {},
): void {
  const staging = `${path}${CHILD_FILE_STAGING_SUFFIX}`;
  writeFileSync(staging, text, 'utf8');
  options.beforePublish?.();
  renameSync(staging, path);
}

/**
 * Reads the JSON a child published to `path`. An empty file, or one that does not parse, throws an
 * error that names the path and the byte count and says the child's output was incomplete, so a
 * truncated read reads as that and not as a bare `SyntaxError` from somewhere in a test.
 */
export function readChildJson<T>(path: string): T {
  const text = readFileSync(path, 'utf8');
  if (text.length === 0) {
    throw new Error(`the child's output file ${path} is empty: it was read before it was complete`);
  }
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `the child's output file ${path} (${Buffer.byteLength(text)} bytes) is not complete JSON: ${reason}`,
      { cause: error },
    );
  }
}

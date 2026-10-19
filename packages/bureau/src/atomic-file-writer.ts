/**
 * The write core agent files (COR-1524) and workflow files (COR-1527) share: serialized writes, a
 * temporary dotfile in the same directory that is renamed into place so a reader never sees half a
 * file, and a compare-against-the-hash-the-caller-read check that is repeated as late as possible.
 * It knows nothing about a file's format; the format's writer supplies the bytes and the checks.
 *
 * ## What is not guaranteed
 *
 * There is no cross-process file lock. A different process writing the same file in the instant
 * between a write's last check and its `rename` is not detected: `rename` replaces whatever is
 * there, and for a create it cannot refuse an existing target. The window is the time between two
 * system calls.
 *
 * @module atomic-file-writer
 */

import { join } from 'node:path';

import { hashAgentFileBytes } from './agent-file';
import type { AgentFileOperations } from './agent-file-operations';

export interface AtomicFileWriterOptions {
  readonly directory: string;
  readonly operations: AgentFileOperations;
  /** The extension a file carries, such as `.md`. */
  readonly extension: string;
  /** A name no other file in the directory has, for the temporary file. */
  readonly newTemporaryName: () => string;
  /** The error for a file that is not there. */
  readonly notFound: (id: string) => Error;
  /** The error for a create over a file that is there. */
  readonly exists: (id: string, currentHash: string) => Error;
  /** The error for a file that no longer holds the hash the caller read. */
  readonly changed: (id: string, currentHash: string) => Error;
}

export interface AtomicFileWriter {
  /** Run `work` after every earlier exclusive piece of work has settled. */
  readonly exclusive: <T>(work: () => Promise<T>) => Promise<T>;
  /** The file's bytes, or `undefined` when there is no such file. */
  readonly readBytes: (id: string) => Promise<Uint8Array | undefined>;
  /** The file's bytes and hash; throws `notFound` or `changed` when it is gone or differs. */
  readonly readExisting: (
    id: string,
    expectedHash: string,
  ) => Promise<{ readonly bytes: Uint8Array; readonly hash: string }>;
  /** Check, once more and as late as possible, that the file still holds `expectedHash`. */
  readonly recheck: (id: string, expectedHash: string) => Promise<void>;
  /** Throw `exists` when the file is there. */
  readonly assertAbsent: (id: string) => Promise<void>;
  /** Write `bytes` to a temporary file, run `beforeRename`, then rename it over the target. */
  readonly publish: (
    id: string,
    bytes: Uint8Array,
    beforeRename: () => Promise<void>,
  ) => Promise<void>;
  /** Delete the file. */
  readonly remove: (id: string) => Promise<void>;
}

export function createAtomicFileWriter(options: AtomicFileWriterOptions): AtomicFileWriter {
  const { directory, operations, extension } = options;
  let tail: Promise<unknown> = Promise.resolve();
  const pathOf = (id: string): string => join(directory, `${id}${extension}`);
  const temporaryPathOf = (id: string): string =>
    join(directory, `.${id}${extension}.${options.newTemporaryName()}.tmp`);

  async function check(id: string, expectedHash: string): Promise<Uint8Array> {
    const bytes = await operations.read(pathOf(id));
    if (bytes === undefined) throw options.notFound(id);
    const hash = hashAgentFileBytes(bytes);
    if (hash !== expectedHash) throw options.changed(id, hash);
    return bytes;
  }

  return {
    exclusive<T>(work: () => Promise<T>): Promise<T> {
      const result = tail.then(work, work);
      tail = result.catch(() => undefined);
      return result;
    },

    readBytes: (id) => operations.read(pathOf(id)),

    async readExisting(id, expectedHash) {
      const bytes = await check(id, expectedHash);
      return { bytes, hash: expectedHash };
    },

    async recheck(id, expectedHash) {
      await check(id, expectedHash);
    },

    async assertAbsent(id) {
      const current = await operations.read(pathOf(id));
      if (current !== undefined) throw options.exists(id, hashAgentFileBytes(current));
    },

    async publish(id, bytes, beforeRename) {
      const temporary = temporaryPathOf(id);
      await operations.makeDirectory(directory);
      await operations.writeTemporary(temporary, bytes);
      try {
        await beforeRename();
        await operations.rename(temporary, pathOf(id));
      } catch (error) {
        await operations.remove(temporary).catch(() => undefined);
        throw error;
      }
    },

    remove: (id) => operations.remove(pathOf(id)),
  };
}

/**
 * The directory-backed {@link DefinitionSource} that `agentFileDirectory` and
 * `workflowFileDirectory` are built on (COR-1702): one file per definition, the filename stem as
 * the identifier, loaded and watched through `watched-directory.ts` and written through
 * `atomic-file-writer.ts`.
 *
 * @module directory-source
 */

import { randomUUID } from 'node:crypto';
import type { FSWatcher } from 'node:fs';

import { createDefaultRuntimeServices, type RuntimeServices } from '@lostgradient/lifecycle';

import { type AgentFileOperations, nodeAgentFileOperations } from './agent-file-operations';
import { createAtomicFileWriter } from './atomic-file-writer';
import {
  type DefinitionEntry,
  type DefinitionSource,
  type DefinitionSourceHost,
  hashDefinitionBytes,
  SourceConflictError,
} from './definition-source';
import { assertSafeIdentifier } from './safe-identifier';
import { createWatchedDirectory } from './watched-directory';

/** The options both directory constructors take. */
export interface DirectorySourceOptions {
  /**
   * Watch the directory with `fs.watch` and a once-a-second rescan. Defaults to `true`; `false`
   * means no `fs.watch` and no poll, and a change is picked up by the next `load()`.
   */
  readonly watch?: boolean | undefined;
  /**
   * How a directory is watched. Defaults to `fs.watch` without keeping the process alive; a test
   * replaces it to observe the watchers the source opens.
   */
  readonly watchFactory?:
    | ((path: string, listener: (event: string, filename: string | null) => void) => FSWatcher)
    | undefined;
  /** The runtime whose timers drive the rescan. Defaults to the Bureau's, or the real clock. */
  readonly runtime?: RuntimeServices | undefined;
  /** Where watcher and scan failures are reported. Defaults to the Bureau's channel. */
  readonly diagnose?: ((message: string, cause: unknown) => void) | undefined;
  /** The file-system operations, behind one seam so a test can record or fail them. */
  readonly operations?: AgentFileOperations | undefined;
}

export interface DirectorySourceShape {
  readonly directory: string;
  /** What the directory holds, for diagnostics: `agent directory`. */
  readonly label: string;
  /** The extension a file must end in exactly, such as `.md`. */
  readonly extension: string;
  /** The largest file read, in bytes. */
  readonly sizeLimit: number;
}

/** A {@link DefinitionSource} over a directory of files. */
export function createDirectorySource(
  shape: DirectorySourceShape,
  options: DirectorySourceOptions = {},
): DefinitionSource {
  const operations = options.operations ?? nodeAgentFileOperations;
  let host: DefinitionSourceHost | undefined;
  let fallbackRuntime: RuntimeServices | undefined;
  const watched = createWatchedDirectory({
    directory: shape.directory,
    label: shape.label,
    extension: shape.extension,
    sizeLimit: shape.sizeLimit,
    operations,
    runtime: () =>
      options.runtime ?? host?.runtime ?? (fallbackRuntime ??= createDefaultRuntimeServices()),
    diagnose: (message: string, cause: unknown) => {
      const report = options.diagnose ?? host?.diagnose;
      if (report !== undefined) report(message, cause);
      else process.stderr.write(`[bureau] ${message} ${String(cause)}\n`);
    },
    ...(options.watch === undefined ? {} : { watch: options.watch }),
    ...(options.watchFactory === undefined ? {} : { openWatcher: options.watchFactory }),
  });

  /** The hash the call now running expects, for the error a check raises. */
  let expecting: string | null = null;
  const files = createAtomicFileWriter({
    directory: shape.directory,
    operations,
    extension: shape.extension,
    newTemporaryName: () => randomUUID(),
    notFound: (id) => new SourceConflictError(id, expecting, null),
    exists: (id, currentHash) => new SourceConflictError(id, null, currentHash),
    changed: (id, currentHash) => new SourceConflictError(id, expecting, currentHash),
  });

  let subscribers = 0;

  return {
    attach(lent) {
      host = lent;
    },

    async load(): Promise<readonly DefinitionEntry[]> {
      await watched.refresh();
      return [...watched.entries().values()];
    },

    watch(listener) {
      const unsubscribe = watched.onChange(listener);
      subscribers += 1;
      if (subscribers === 1) watched.startWatching();
      let stopped = false;
      return () => {
        if (stopped) return;
        stopped = true;
        unsubscribe();
        subscribers -= 1;
        if (subscribers === 0) watched.stopWatching();
      };
    },

    write(id, bytes, { expectedHash }) {
      assertSafeIdentifier(id);
      // The caller owns `bytes`; the write reads them after awaits, so it works from a copy.
      const owned = bytes.slice();
      return files.exclusive(async () => {
        expecting = expectedHash;
        if (expectedHash === null) {
          const absent = (): Promise<void> => files.assertAbsent(id);
          await absent();
          await files.publish(id, owned, absent);
        } else {
          await files.readExisting(id, expectedHash);
          await files.publish(id, owned, () => files.recheck(id, expectedHash));
        }
        return { id, bytes: owned, hash: hashDefinitionBytes(owned) };
      });
    },

    delete(id, { expectedHash }) {
      assertSafeIdentifier(id);
      return files.exclusive(async () => {
        expecting = expectedHash;
        await files.readExisting(id, expectedHash);
        await files.recheck(id, expectedHash);
        await files.remove(id);
      });
    },
  };
}

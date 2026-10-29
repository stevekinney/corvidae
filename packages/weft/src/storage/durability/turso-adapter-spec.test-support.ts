import {
  makeNullValueFailingBatch,
  type AdapterSpec,
  type CheckpointResult,
} from '@lostgradient/storage/testing';
import { TursoStorage } from '../turso.ts';

/** The durability suites' spec for the Turso adapter. */
export const tursoSpec: AdapterSpec = {
  name: 'TursoStorage',
  // libSQL local-file may or may not expose standard sidecars depending on
  // the bundled client. Treat as false by default; the sidecar test routes
  // Turso to a libSQL-shaped equivalent (write/close/reopen with a fresh
  // client against the same `file:` URL).
  exposesStandardSidecars: false,
  expectedCapabilities: {
    persistence: 'local',
    readAfterWrite: 'session',
    scanConsistency: 'snapshot',
    atomicBatch: true,
    conditionalBatch: true,
    boundedRangeDelete: true,
  },
  child: {
    moduleSpecifier: import.meta.resolve('../turso.ts'),
    exportName: 'TursoStorage',
    constructorArgument: "{ url: 'file:' + path }",
  },
  async open(databasePath: string) {
    const storage = new TursoStorage({ url: `file:${databasePath}` });
    return {
      storage,
      databasePath,
      async checkpoint(): Promise<CheckpointResult> {
        // Turso's local-file client controls its own checkpointing; we do
        // not have a stable passthrough. The sidecar test does not call
        // checkpoint() for Turso, so this is a no-op success.
        return { truncated: true, raw: { note: 'libsql local-file: no explicit pragma path' } };
      },
      async close(): Promise<void> {
        storage[Symbol.dispose]();
      },
      makeFailingBatch: makeNullValueFailingBatch,
    };
  },
};

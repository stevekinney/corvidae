import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from '@lostgradient/storage';
import { closeIfOpen, FixtureScope } from '@lostgradient/storage/testing';
import {
  availableAdapterSpecs,
  canLoadNodeSqliteWith,
  createNodeSqliteSpec,
  loadBetterSqlite3Locally,
} from './sqlite-adapter-specs.test-support.ts';

describe('Turso adapter spec', () => {
  it('reports a successful no-op checkpoint, since libSQL manages its own', async () => {
    const spec = availableAdapterSpecs().find((candidate) => candidate.name === 'TursoStorage');
    expect(spec).toBeDefined();
    const scope = new FixtureScope();
    const adapter = await spec!.open(`${scope.makeTempDirectory('turso')}/checkpoint.db`);

    try {
      const checkpoint = await adapter.checkpoint();
      expect(checkpoint.truncated).toBe(true);
    } finally {
      await closeIfOpen(adapter);
      scope.cleanup();
    }
  });
});

/** A stand-in for the `better-sqlite3` driver, which loads only under Node. */
function stubDriver(pragmaRow: { busy: number; log: number; checkpointed: number }) {
  const calls: string[] = [];
  class StubDriver {
    constructor(readonly databasePath: string) {
      calls.push(`open ${databasePath}`);
    }
    pragma(source: string): unknown {
      calls.push(`pragma ${source}`);
      return [pragmaRow];
    }
    close(): void {
      calls.push('close');
    }
  }
  return { Driver: StubDriver, calls };
}

describe('loadBetterSqlite3Locally', () => {
  const Constructor = (() => 'driver') as unknown as new (path: string) => never;

  it('takes the default export of a module that has one', () => {
    const requested: string[] = [];
    const driver = loadBetterSqlite3Locally((id) => {
      requested.push(id);
      return Object.assign(() => 'wrapper', { default: Constructor });
    });

    expect(driver).toBe(Constructor);
    expect(requested).toEqual(['better-sqlite3']);
  });

  it('takes the module itself when it is the constructor', () => {
    expect(loadBetterSqlite3Locally(() => Constructor)).toBe(Constructor);
  });
});

describe('Node SQLite adapter spec', () => {
  it('opens the adapter, checkpoints through the raw driver, and closes the adapter', async () => {
    const { Driver, calls } = stubDriver({ busy: 0, log: 3, checkpointed: 3 });
    const spec = createNodeSqliteSpec({
      storageConstructor: MemoryStorage,
      loadDriver: () => Driver,
    });
    expect(spec.name).toBe('NodeSQLiteStorage');
    expect(spec.exposesStandardSidecars).toBe(true);

    const scope = new FixtureScope();
    const databasePath = `${scope.makeTempDirectory('node-sqlite')}/checkpoint.db`;
    const adapter = await spec.open(databasePath);
    try {
      expect(adapter.databasePath).toBe(databasePath);
      expect(adapter.storage).toBeInstanceOf(MemoryStorage);
      const checkpoint = await adapter.checkpoint();
      expect(checkpoint.truncated).toBe(true);
      expect(calls).toEqual([`open ${databasePath}`, 'pragma wal_checkpoint(TRUNCATE)', 'close']);
      expect(adapter.makeFailingBatch(1, 3).map((operation) => operation.key)).toEqual([
        'mid:000000',
        'mid:000001',
        'mid:000002',
      ]);
    } finally {
      await closeIfOpen(adapter);
      scope.cleanup();
    }
  });

  it('reports a checkpoint the driver could not finish as not truncated, and still closes it', async () => {
    const { Driver, calls } = stubDriver({ busy: 1, log: 3, checkpointed: 1 });
    const spec = createNodeSqliteSpec({
      storageConstructor: MemoryStorage,
      loadDriver: () => Driver,
    });
    const scope = new FixtureScope();
    const adapter = await spec.open(`${scope.makeTempDirectory('node-sqlite-busy')}/busy.db`);

    try {
      const checkpoint = await adapter.checkpoint();
      expect(checkpoint.truncated).toBe(false);
      expect(calls.at(-1)).toBe('close');
    } finally {
      await closeIfOpen(adapter);
      scope.cleanup();
    }
  });
});

describe('canLoadNodeSqliteWith', () => {
  it('never tries to open the adapter under Bun', () => {
    let opened = false;
    class Adapter extends MemoryStorage {
      constructor() {
        super();
        opened = true;
      }
    }

    expect(canLoadNodeSqliteWith(true, Adapter as never)).toBe(false);
    expect(opened).toBe(false);
  });

  it('is available when an in-memory database opens and closes', () => {
    expect(canLoadNodeSqliteWith(false, MemoryStorage as never)).toBe(true);
  });

  it('is unavailable when the adapter cannot open', () => {
    const refusing = function (): never {
      throw new Error('the native binding is refused');
    };

    expect(canLoadNodeSqliteWith(false, refusing as never)).toBe(false);
  });
});

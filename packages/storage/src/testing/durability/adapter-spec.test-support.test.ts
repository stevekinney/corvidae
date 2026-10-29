import { afterAll, describe, expect, it, spyOn } from 'bun:test';
import * as nodeFileSystem from 'node:fs';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  closeIfOpen,
  FixtureScope,
  isFullyCheckpointed,
  makeNullValueFailingBatch,
  type OpenedAdapter,
} from './adapter-spec.test-support.ts';

describe('closeIfOpen', () => {
  it('ignores a missing handle', async () => {
    expect(await closeIfOpen(undefined)).toBeUndefined();
  });

  it('swallows a failing close so it cannot mask the assertion that led to cleanup', async () => {
    const handle = {
      close: async () => {
        throw new Error('close failed');
      },
    } as unknown as OpenedAdapter;

    expect(await closeIfOpen(handle)).toBeUndefined();
  });
});

describe('FixtureScope', () => {
  it('removes the directories it made when the test passed', () => {
    const scope = new FixtureScope();
    const directory = scope.makeTempDirectory('removal');
    expect(existsSync(directory)).toBe(true);

    scope.cleanup();

    expect(existsSync(directory)).toBe(false);
  });

  it('keeps the directories of a failed test for inspection', () => {
    const scope = new FixtureScope();
    const directory = scope.makeTempDirectory('failed');
    scope.markFailed();

    scope.cleanup();

    expect(existsSync(directory)).toBe(true);
    nodeFileSystem.rmSync(directory, { recursive: true, force: true });
  });

  it('keeps cleaning the remaining directories when one cannot be removed', () => {
    const scope = new FixtureScope();
    const first = scope.makeTempDirectory('first');
    const second = scope.makeTempDirectory('second');
    const real = nodeFileSystem.rmSync;
    const removeSpy = spyOn(nodeFileSystem, 'rmSync').mockImplementation(
      (...args: Parameters<typeof real>) => {
        if (String(args[0]) === second) throw new Error('directory is busy');
        return real(...args);
      },
    );

    try {
      expect(() => scope.cleanup()).not.toThrow();
      expect(existsSync(first)).toBe(false);
    } finally {
      removeSpy.mockRestore();
      nodeFileSystem.rmSync(second, { recursive: true, force: true });
    }
  });
});

describe('makeNullValueFailingBatch', () => {
  it('puts a NULL value at the failing index and bytes everywhere else', () => {
    const operations = makeNullValueFailingBatch(2, 4);
    expect(operations.map((operation) => operation.key)).toEqual([
      'mid:000000',
      'mid:000001',
      'mid:000002',
      'mid:000003',
    ]);
    expect(
      operations.map((operation) => (operation.type === 'put' ? operation.value : 'delete')),
    ).toEqual([new Uint8Array([0]), new Uint8Array([1]), null, new Uint8Array([3])] as never);
  });
});

describe('isFullyCheckpointed', () => {
  const scope = new FixtureScope();
  const databasePath = join(scope.makeTempDirectory('checkpoint'), 'weft.db');
  const complete = { busy: 0, log: 4, checkpointed: 4 };

  afterAll(() => {
    scope.cleanup();
  });

  it('is false without a row, while busy, or with frames left to copy', () => {
    expect(isFullyCheckpointed(undefined, databasePath)).toBe(false);
    expect(isFullyCheckpointed({ ...complete, busy: 1 }, databasePath)).toBe(false);
    expect(isFullyCheckpointed({ ...complete, checkpointed: 3 }, databasePath)).toBe(false);
  });

  it('is true when the WAL is absent or empty, and false while it still holds frames', () => {
    expect(isFullyCheckpointed(complete, databasePath)).toBe(true);
    writeFileSync(`${databasePath}-wal`, '');
    expect(isFullyCheckpointed(complete, databasePath)).toBe(true);
    writeFileSync(`${databasePath}-wal`, 'frames');
    expect(isFullyCheckpointed(complete, databasePath)).toBe(false);
  });
});

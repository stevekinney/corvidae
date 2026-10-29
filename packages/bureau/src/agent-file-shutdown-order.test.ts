/**
 * Shutdown order (COR-1669): an agent-directory scan in flight records file revisions in the
 * Bureau's storage, so the watcher stops and drains before storage closes under it. A scan that
 * outlived the storage wrote through finalized statements and failed.
 */
import { createDefaultRuntimeServices } from '@lostgradient/lifecycle';
import { afterEach, describe, expect, it } from 'bun:test';

import { createSqliteStorageFixture } from './test/storage-fixtures';
import { startFileBureau } from './testing/agent-file-bureau.test-support.ts';
import { agentFileText, KNOWN_MODEL } from './testing/agent-file-fixtures.test-support.ts';
import { quietFor } from '@lostgradient/testing/wait-until';

const failures: unknown[] = [];
const onRejection = (reason: unknown): void => {
  failures.push(reason);
};

afterEach(() => {
  process.off('unhandledRejection', onRejection);
  failures.length = 0;
});

describe('disposing a Bureau while the agent directory is being scanned', () => {
  it('lets the scan finish before storage closes, and fails nothing', async () => {
    process.on('unhandledRejection', onRejection);
    // The Bureau reports a revision it could not record through the console.
    const reported: string[] = [];
    const original = { error: console.error, warn: console.warn };
    const capture =
      (forward: (...values: unknown[]) => void) =>
      (...values: unknown[]): void => {
        reported.push(values.map(String).join(' '));
        forward.apply(console, values);
      };
    console.error = capture(original.error);
    console.warn = capture(original.warn);
    const fixture = createSqliteStorageFixture({ runtime: createDefaultRuntimeServices() });
    const harness = await startFileBureau({ overrides: { storage: fixture.storage } });
    try {
      for (let index = 0; index < 5; index += 1) {
        await harness.put(
          `agent-${index}.md`,
          agentFileText({ name: `Agent ${index}`, model: KNOWN_MODEL, published: 'true' }, 'Go.\n'),
        );
      }
      // A scan begins and is not awaited; the Bureau is disposed while it records revisions.
      let scanFailure = '';
      const scan = harness.bureau.agents.refresh().catch((error: unknown) => {
        scanFailure = error instanceof Error ? error.message : 'failed';
      });
      await harness.bureau.dispose();
      await scan;
      await quietFor(50);
      expect(failures).toEqual([]);
      expect(reported.filter((line) => /could not be recorded|finalized/i.test(line))).toEqual([]);
      expect(scanFailure).not.toMatch(/finalized|closed database/i);
    } finally {
      console.error = original.error;
      console.warn = original.warn;
      await harness.dispose();
      await fixture.dispose();
    }
  });
});

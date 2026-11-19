/**
 * COR-2526 — a stall the holder recorded does not outlive a cancel from a process that does not hold
 * the run, and the holder cannot write it back. Two Bureaus share one SQLite store on real timers:
 * A holds a run held at its second step, and B cancels it. The stall is the holder's own write
 * through its registry, since a real one needs the minutes of silence the manual-runtime tests
 * move through (a durable cancel on a runtime that moves only by hand does not settle).
 */
import { waitUntil } from '@lostgradient/testing/wait-until';
import { afterEach, describe, expect, it, spyOn } from 'bun:test';

import { createSqliteStorageFixture } from './test/storage-fixtures.ts';
import { agentFileText, KNOWN_MODEL } from './testing/agent-file-fixtures.test-support.ts';
import {
  type FileBureauHarness,
  startFileBureau,
} from './testing/agent-file-bureau.test-support.ts';

const OWNERSHIP = {
  ownership: 'workflow-lease',
  workflowClaimTtlMs: 30_000,
  workflowClaimRenewIntervalMs: 25,
} as const;

const harnesses: FileBureauHarness[] = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0).toReversed()) await harness.dispose();
});

describe('a stalled run cancelled from another process (COR-2526)', () => {
  it('(l) settles canceled with no stall on the record, and the holder’s later stall write is refused', async () => {
    const warnings: unknown[] = [];
    const emitWarning = spyOn(process, 'emitWarning').mockImplementation((warning) => {
      warnings.push(warning);
    });
    const fixture = createSqliteStorageFixture({});
    try {
      const reached = Promise.withResolvers<void>();
      const gate = Promise.withResolvers<void>();
      let generations = 0;
      const holder = await startFileBureau({
        scripts: {
          'claude-opus-5-5': (async () => {
            generations += 1;
            if (generations === 1) {
              return { content: '', toolCalls: [{ name: 'lookup-order', arguments: {} }] };
            }
            reached.resolve();
            await gate.promise;
            return { content: 'late' };
          }) as never,
        },
        overrides: { id: 'attention-peers', storage: fixture.storage, durableOwnership: OWNERSHIP },
      });
      harnesses.push(holder);
      const peer = await startFileBureau({
        directory: holder.directory,
        overrides: { id: 'attention-peers', storage: fixture.open(), durableOwnership: OWNERSHIP },
      });
      harnesses.push(peer);
      await holder.put('helper.md', agentFileText({ model: KNOWN_MODEL, tools: '[lookup-order]' }));
      await holder.bureau.agents.refresh();

      const task = await holder.bureau.tasks.start('helper', 'Go.');
      await reached.promise;
      const stalledAt = new Date().toISOString();
      expect(await holder.bureau.internals.taskRegistry.recordStall(task.id, stalledAt)).toBe(true);
      expect((await peer.bureau.tasks.get(task.id))?.attention).toEqual(['stalled']);

      await peer.bureau.tasks.cancel(task.id);
      await waitUntil(async () => (await peer.bureau.tasks.get(task.id))?.status === 'canceled');
      expect((await peer.bureau.tasks.get(task.id))?.attention).toEqual([]);
      expect((await peer.bureau.internals.taskRegistry.record(task.id))?.attention).toBeUndefined();

      // The holder, a moment behind, tries to write the stall back, and again after its step ends.
      expect(await holder.bureau.internals.taskRegistry.recordStall(task.id, stalledAt)).toBe(
        false,
      );
      gate.resolve();
      await waitUntil(() => holder.bureau.tasks.detail(task.id)?.status !== 'running');
      await holder.bureau.internals.taskRegistry.flush();
      expect(await holder.bureau.internals.taskRegistry.recordStall(task.id, stalledAt)).toBe(
        false,
      );
      const record = await peer.bureau.internals.taskRegistry.record(task.id);
      expect(record?.settled?.status).toBe('canceled');
      expect(record?.attention).toBeUndefined();
      expect((await peer.bureau.tasks.get(task.id))?.attention).toEqual([]);
    } finally {
      await Promise.all(
        harnesses
          .splice(0)
          .toReversed()
          .map((harness) => harness.dispose()),
      );
      await fixture.dispose();
      emitWarning.mockRestore();
    }
    for (const warning of warnings) {
      expect((warning as Error).name).toBe('WeftWorkflowClaimLostWarning');
    }
  });
});

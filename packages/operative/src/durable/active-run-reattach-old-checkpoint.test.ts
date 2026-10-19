/**
 * COR-713 — a reattached run whose checkpoint was written before records carried parts fails with
 * the typed error on the abort and timeout paths too, not with a silent empty state or a stuck
 * session. Both paths rebuild the run's state from the checkpoint to report usage and steps, and
 * the tolerant read they use rethrows an older record rather than reporting a zeroed run.
 */
import { Engine, MemoryStorage, textValueStore } from '@lostgradient/weft';
import { describe, expect, it, spyOn } from 'bun:test';

import { rejectionOf } from '../testing/promise-outcome.test-support.ts';
import { reattachDurableActiveRun } from './active-run-reattach';
import { createCheckpointStore } from './checkpoint-store';
import { UnsupportedCheckpointRecordVersionError } from './checkpoint-version';

/** A store whose cursor is the versionless record an older build wrote. */
async function contextWithVersionlessCursor(runId: string) {
  const storage = new MemoryStorage();
  const values = textValueStore(storage, { disposeUnderlyingStorage: false });
  const checkpointStore = createCheckpointStore(values);
  await values.set(
    `durable-run:${runId}:cursor`,
    JSON.stringify({
      step: 1,
      totalUsage: { prompt: 0, completion: 0, total: 0 },
      lastContent: 'old',
      schemaAttempts: 0,
      lastAppliedConfigVersion: 0,
    }),
  );
  const engine = await Engine.create({ storage, recover: false, workflows: {}, activities: {} });
  return { engine, checkpointStore };
}

describe('reattaching a run with an old-shape checkpoint (COR-713)', () => {
  it('fails with the typed error when the run timed out', async () => {
    const runId = 'old-checkpoint-timeout';
    const context = await contextWithVersionlessCursor(runId);
    try {
      const timeout = Object.assign(new Error('timed out'), { code: 'WorkflowTimeoutError' });
      const run = reattachDurableActiveRun(context, {
        runId,
        handle: { id: runId, result: () => Promise.reject(timeout) },
      });
      expect(await rejectionOf(run.result)).toBeInstanceOf(UnsupportedCheckpointRecordVersionError);
    } finally {
      context.engine[Symbol.dispose]();
    }
  });

  it('fails with the typed error when the run was aborted', async () => {
    const runId = 'old-checkpoint-abort';
    const context = await contextWithVersionlessCursor(runId);
    try {
      // The engine accepts the cancellation, so the rejection below is read as an abort.
      spyOn(context.engine, 'cancel').mockResolvedValue(undefined);
      const run = reattachDurableActiveRun(context, {
        runId,
        handle: {
          id: runId,
          result: () =>
            new Promise((_resolve, reject) => setTimeout(() => reject(new Error('cancelled')), 0)),
        },
      });
      run.abort();
      expect(await rejectionOf(run.result)).toBeInstanceOf(UnsupportedCheckpointRecordVersionError);
    } finally {
      context.engine[Symbol.dispose]();
    }
  });
});

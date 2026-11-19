import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from '@lostgradient/storage';
import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { KEYS } from '../../storage/keys.ts';
import {
  workflow,
  type BulkOperationDryRunResult,
  type PurgeResult,
  type WorkflowContext,
} from '../types.ts';
import { BulkOperationConfirmationError } from './errors.ts';
import { Engine } from './index.ts';

async function storeContents(storage: MemoryStorage): Promise<[string, string][]> {
  const entries: [string, string][] = [];
  for await (const [key, value] of storage.scan('')) {
    entries.push([key, Buffer.from(value).toString('base64')]);
  }
  return entries.toSorted(([left], [right]) => (left < right ? -1 : 1));
}

async function engineWithCompletedRuns(ids: readonly string[]) {
  const storage = new MemoryStorage();
  const engine = new Engine({ storage });
  engine.register(
    workflow({ name: 'echo' }).execute(async function* (_ctx: WorkflowContext, input: unknown) {
      yield* [];
      return input;
    }),
  );
  for (const id of ids) {
    const handle = await engine.start('echo', id, { id });
    await handle.result();
  }
  return { engine, storage };
}

describe('engine.purge with options (COR-2521)', () => {
  it('a dry run returns the bulk dry-run result and writes nothing', async () => {
    const { engine, storage } = await engineWithCompletedRuns(['a', 'b', 'c']);
    await using _engine = engine;
    const before = await storeContents(storage);

    const preview = await engine.purge({ status: 'completed' }, { dryRun: true });

    expect(preview).toMatchObject({
      dryRun: true,
      action: 'purge',
      matched: 3,
      sampleWorkflowIds: ['a', 'b', 'c'],
      confirmationTokenVersion: 1,
    });
    expect(preview.confirmationToken).toStartWith('bulk:');
    expect(preview.scope).toMatchObject({ matched: 3, statuses: ['completed'] });
    expect(await storeContents(storage)).toEqual(before);
  });

  it('commits exactly the previewed runs with the token, and reports an audit event', async () => {
    const { engine } = await engineWithCompletedRuns(['a', 'b']);
    await using _engine = engine;
    const preview = await engine.purge(undefined, { dryRun: true, requestId: 'purge-request' });

    const result = await engine.purge(undefined, {
      confirmationToken: preview.confirmationToken,
      requestId: 'purge-request',
    });

    expect(result.deleted).toBe(2);
    expect(result.auditEvent).toMatchObject({
      action: 'purge',
      requestId: 'purge-request',
      affectedCount: 2,
      confirmationToken: preview.confirmationToken,
    });
    expect(await engine.get('a')).toBeNull();
    expect(await engine.get('b')).toBeNull();
  });

  it('refuses a token the filter no longer produces, and deletes nothing', async () => {
    const { engine, storage } = await engineWithCompletedRuns(['a', 'b']);
    await using _engine = engine;
    const preview = await engine.purge({ status: 'completed' }, { dryRun: true });
    const late = await engine.start('echo', 'late', { id: 'late' });
    await late.result();
    const before = await storeContents(storage);

    const refusal = await rejectionOf(
      engine.purge({ status: 'completed' }, { confirmationToken: preview.confirmationToken }),
    );

    expect(refusal).toBeInstanceOf(BulkOperationConfirmationError);
    expect(await storeContents(storage)).toEqual(before);
  });

  it('a token from another filter is refused', async () => {
    const { engine } = await engineWithCompletedRuns(['a']);
    await using _engine = engine;
    const preview = await engine.purge({ type: 'echo' }, { dryRun: true });

    const refusal = await rejectionOf(
      engine.purge({ type: 'other' }, { confirmationToken: preview.confirmationToken }),
    );

    expect(refusal).toBeInstanceOf(BulkOperationConfirmationError);
    expect(await engine.get('a')).not.toBeNull();
  });

  it('previews what a purge would remove: terminal runs past the offset and within the limit', async () => {
    const { engine } = await engineWithCompletedRuns(['a', 'b', 'c', 'd']);
    await using _engine = engine;
    engine.register(
      workflow({ name: 'parked' }).execute(async function* (ctx: WorkflowContext) {
        return yield* ctx.waitForSignal('go');
      }),
    );
    await engine.start('parked', null, { id: 'still-running' });

    const everything = await engine.purge(undefined, { dryRun: true });
    expect(everything.matched).toBe(4);
    expect(everything.sampleWorkflowIds).not.toContain('still-running');

    const window = await engine.purge({ offset: 1, limit: 2 }, { dryRun: true });
    expect(window.matched).toBe(2);
    const committed = await engine.purge(
      { offset: 1, limit: 2 },
      { confirmationToken: window.confirmationToken },
    );
    expect(committed.deleted).toBe(2);
    // Not terminal, so no purge may take it: it is still starting or parked.
    const stillRunning = await engine.get('still-running');
    expect(['pending', 'running']).toContain(stillRunning?.status ?? 'gone');
    // The two the window named are gone, and the two outside it remain.
    const states = await Promise.all(['a', 'b', 'c', 'd'].map((id) => engine.get(id)));
    expect(states.filter((state) => state !== null)).toHaveLength(2);
  });

  it('skips a run that owes a finalizer, as the immediate purge does', async () => {
    const { engine, storage } = await engineWithCompletedRuns(['a', 'b']);
    await using _engine = engine;
    await storage.put(KEYS.teardownOwed('a'), new Uint8Array([1]));

    const preview: BulkOperationDryRunResult = await engine.purge(undefined, { dryRun: true });

    expect(preview.matched).toBe(1);
    expect(preview.sampleWorkflowIds).toEqual(['b']);
  });

  it('with no options purges at once, as before', async () => {
    const { engine } = await engineWithCompletedRuns(['a', 'b']);
    await using _engine = engine;

    const result: PurgeResult = await engine.purge({ status: 'completed' });

    expect(result).toEqual({ deleted: 2 });
  });
});

/**
 * COR-1909 — `bureau.contexts.rename` stores a title in the session's metadata, which every summary
 * then shows in place of the derived one until it is cleared. It is authorized as a delete is, and
 * it is not activity: the session keeps its `updatedAt` and its place in a listing.
 */
import { createAgent } from '@lostgradient/operative';
import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { describe, expect, it } from 'bun:test';

import { BureauShuttingDownError } from '../../create-bureau.ts';
import { waitForTaskState } from '../../test';
import { startTaskFrom } from '../../test/task-start-request.ts';
import { BUREAU_HANDLER_OPERATIONS } from '../create-bureau-handler.ts';
import { contextsRenameOperation } from './contexts-rename-operation.ts';
import {
  answering,
  openBureau,
  type OpenedBureau,
  OWNER,
  rpc,
} from './management-fixtures.test-support.ts';

const agent = createAgent({ name: 'agent', generate: answering() });

async function withBureau<T>(body: (opened: OpenedBureau) => Promise<T>): Promise<T> {
  const opened = await openBureau({ agents: { agent } });
  try {
    return await body(opened);
  } finally {
    await opened.dispose();
  }
}

async function finishedSession(opened: OpenedBureau, message: string, principal: string) {
  const run = await startTaskFrom(opened.bureau, { agentName: 'agent', input: message, principal });
  await waitForTaskState(opened.bureau, run.id);
  return run;
}

const rename = (opened: OpenedBureau, key: string, contextId: string, title: string | null) =>
  rpc(opened.handler, 'bureau.contexts.rename', { contextId, title }, key);

const getOf = (opened: OpenedBureau, key: string, contextId: string) =>
  rpc(opened.handler, 'bureau.contexts.get', { contextId }, key);

/** What `bureau.contexts.get` answers with. */
async function readContext(opened: OpenedBureau, key: string, contextId: string) {
  const body = await getOf(opened, key, contextId);
  return body.result;
}

describe('bureau.contexts.rename', () => {
  it('is served by the handler', () => {
    expect(BUREAU_HANDLER_OPERATIONS).toContain(contextsRenameOperation);
  });

  it('persists the title, shows it in list and get, and restores the derived one when cleared', async () => {
    await withBureau(async (opened) => {
      const run = await finishedSession(opened, 'the opening question', OWNER.alice);

      const renamed = await rename(opened, 'alice-key', run.contextId, '  Trip planning  ');

      expect(renamed.result).toMatchObject({ id: run.contextId, title: 'Trip planning' });
      const listed = await rpc(opened.handler, 'bureau.contexts.list', {}, 'alice-key');
      const contexts = (listed.result?.['contexts'] ?? []) as { title: string }[];
      const titles = contexts.map((context) => context.title);
      expect(titles).toEqual(['Trip planning']);
      expect(await readContext(opened, 'alice-key', run.contextId)).toMatchObject({
        title: 'Trip planning',
      });
      // Durable: the session store's own summary index holds it.
      const stored = await opened.bureau.internals.sessionStore!.list();
      expect(stored.map((row) => row.title)).toEqual(['Trip planning']);

      const cleared = await rename(opened, 'alice-key', run.contextId, null);

      expect(cleared.result).toMatchObject({ title: 'the opening question' });
      expect(await readContext(opened, 'alice-key', run.contextId)).toMatchObject({
        title: 'the opening question',
      });
      const storedAfter = await opened.bureau.internals.sessionStore!.list();
      expect(storedAfter.map((row) => row.title)).toEqual(['the opening question']);
    });
  });

  it('is not activity: updatedAt and the order of the listing do not move', async () => {
    await withBureau(async (opened) => {
      const older = await finishedSession(opened, 'older', OWNER.alice);
      const newer = await finishedSession(opened, 'newer', OWNER.alice);
      const before = await getOf(opened, 'alice-key', older.contextId);

      await rename(opened, 'alice-key', older.contextId, 'renamed but still older');

      const after = await getOf(opened, 'alice-key', older.contextId);
      expect(after.result?.['updatedAt']).toBe(before.result?.['updatedAt']);
      const listed = await rpc(opened.handler, 'bureau.contexts.list', {}, 'alice-key');
      const contexts = (listed.result?.['contexts'] ?? []) as { id: string }[];
      const ids = contexts.map((context) => context.id);
      expect(ids).toEqual([newer.contextId, older.contextId]);
    });
  });

  it('is safe to retry, and renaming to the title it already has is not an error', async () => {
    await withBureau(async (opened) => {
      const run = await finishedSession(opened, 'q', OWNER.alice);

      const first = await rename(opened, 'alice-key', run.contextId, 'Same');
      const second = await rename(opened, 'alice-key', run.contextId, 'Same');
      const clearedTwice = [
        await rename(opened, 'alice-key', run.contextId, null),
        await rename(opened, 'alice-key', run.contextId, null),
      ];

      expect(second.result).toEqual(first.result);
      for (const body of clearedTwice) expect(body.result).toMatchObject({ title: 'q' });
    });
  });

  it('refuses a blank title and one over the limit as invalid parameters, and changes nothing', async () => {
    await withBureau(async (opened) => {
      const run = await finishedSession(opened, 'q', OWNER.alice);

      for (const title of ['', '   ', 'x'.repeat(201), ` ${'x'.repeat(201)} `]) {
        const body = await rename(opened, 'alice-key', run.contextId, title);
        expect(body.error?.data).toMatchObject({ weftCode: 'InvalidParams' });
      }
      expect(await readContext(opened, 'alice-key', run.contextId)).toMatchObject({
        title: 'q',
      });
      const longest = await rename(opened, 'alice-key', run.contextId, 'x'.repeat(200));
      expect(longest.result).toMatchObject({ title: 'x'.repeat(200) });
      // Trimmed before the length is judged on the wire, as `Bureau.contexts.rename` does.
      const padded = await rename(opened, 'alice-key', run.contextId, `  ${'y'.repeat(200)}  `);
      expect(padded.result).toMatchObject({ title: 'y'.repeat(200) });
    });
  });

  it('answers another owner’s context, and a write-less scope, exactly as a missing one, and renames nothing', async () => {
    await withBureau(async (opened) => {
      const run = await finishedSession(opened, 'private', OWNER.alice);

      const stranger = await rename(opened, 'bob-key', run.contextId, 'stolen');
      const readOnly = await rename(opened, 'tasks-reader-key', run.contextId, 'stolen');
      const missing = await rename(opened, 'bob-key', 'no-such-context', 'stolen');

      expect(stranger.error?.data?.httpStatus).toBe(404);
      expect(readOnly.error?.data?.httpStatus).toBe(404);
      expect(JSON.stringify(stranger).replaceAll(run.contextId, '<id>')).toBe(
        JSON.stringify(missing).replaceAll('no-such-context', '<id>'),
      );
      expect(await readContext(opened, 'alice-key', run.contextId)).toMatchObject({
        title: 'private',
      });
    });
  });

  it('lets a caller holding bureau.contexts:write rename any owner’s context', async () => {
    await withBureau(async (opened) => {
      const run = await finishedSession(opened, 'alice’s', OWNER.alice);

      const renamed = await rename(opened, 'contexts-writer-key', run.contextId, 'by an operator');

      expect(renamed.result).toMatchObject({ id: run.contextId, owner: OWNER.alice });
      expect(renamed.result?.['title']).toBe('by an operator');
    });
  });

  it('keeps working for a session whose metadata predates the title key', async () => {
    await withBureau(async (opened) => {
      const run = await finishedSession(opened, 'old session', OWNER.alice);
      const session = await opened.bureau.contexts.get(run.contextId);

      expect(Object.keys(session!.metadata)).not.toContain('sessionTitle');
      expect(await readContext(opened, 'alice-key', run.contextId)).toMatchObject({
        title: 'old session',
      });
    });
  });
});

describe('Bureau.contexts.rename', () => {
  it('resolves undefined for a session it does not hold, or of another incarnation', async () => {
    await withBureau(async (opened) => {
      const run = await finishedSession(opened, 'q', OWNER.alice);

      expect(await opened.bureau.contexts.rename('no-such-context', 'x')).toBeUndefined();
      expect(
        await opened.bureau.contexts.rename(run.contextId, 'x', { incarnation: 'another' }),
      ).toBeUndefined();
      const session = await opened.bureau.contexts.get(run.contextId);
      expect(session?.metadata['sessionTitle']).toBeUndefined();
    });
  });

  it('refuses a rename once the Bureau is shutting down', async () => {
    const opened = await openBureau({ agents: { agent } });
    try {
      const run = await finishedSession(opened, 'q', OWNER.alice);
      await opened.bureau.shutdown();

      const refusal = await rejectionOf(opened.bureau.contexts.rename(run.contextId, 'x'));

      expect(refusal).toBeInstanceOf(BureauShuttingDownError);
      expect(refusal).toMatchObject({ code: 'CONFLICT' });
    } finally {
      await opened.dispose();
    }
  });
});

/**
 * COR-2285 — `bureau.contexts.archive` and `bureau.contexts.unarchive` record when a person archived
 * a context in its metadata. An archived context shows `archivedAt`, filters by it, and accepts no
 * new work; a context with a live task cannot be archived. Neither is activity: the context keeps
 * its `updatedAt` and its place in a listing.
 */
import { createAgent, SESSION_ARCHIVED_AT_METADATA_KEY } from '@lostgradient/operative';
import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { describe, expect, it } from 'bun:test';

import {
  BureauShuttingDownError,
  ContextArchivedError,
  ContextBusyError,
} from '../../bureau-errors.ts';
import { waitForCondition, waitForTaskState } from '../../test';
import { createMemoryStorageFixture } from '../../test/storage-fixtures.ts';
import { startTaskFrom } from '../../test/task-start-request.ts';
import { BUREAU_HANDLER_OPERATIONS } from '../create-bureau-handler.ts';
import { contextsArchiveOperation } from './contexts-archive-operation.ts';
import { contextsUnarchiveOperation } from './contexts-unarchive-operation.ts';
import {
  answering,
  approvalToolbox,
  chargesOnce,
  createStorageInterleaver,
  openBureau,
  type OpenedBureau,
  OWNER,
  parkingUntilAborted,
  rpc,
  type RpcBody,
} from './management-fixtures.test-support.ts';

const agent = createAgent({ name: 'agent', generate: answering() });

async function withBureau<T>(
  body: (opened: OpenedBureau) => Promise<T>,
  options: Parameters<typeof openBureau>[0] = {},
): Promise<T> {
  const opened = await openBureau({ agents: { agent }, ...options });
  try {
    return await body(opened);
  } finally {
    await opened.dispose();
  }
}

async function finishedSession(opened: OpenedBureau, message: string, principal = OWNER.alice) {
  const run = await startTaskFrom(opened.bureau, { agentName: 'agent', input: message, principal });
  await waitForTaskState(opened.bureau, run.id);
  return run;
}

const archive = (opened: OpenedBureau, contextId: string, key = 'alice-key') =>
  rpc(opened.handler, 'bureau.contexts.archive', { contextId }, key);

const unarchive = (opened: OpenedBureau, contextId: string, key = 'alice-key') =>
  rpc(opened.handler, 'bureau.contexts.unarchive', { contextId }, key);

const getOf = (opened: OpenedBureau, contextId: string, key = 'alice-key') =>
  rpc(opened.handler, 'bureau.contexts.get', { contextId }, key);

const listOf = async (
  opened: OpenedBureau,
  params: Record<string, unknown> = {},
  key = 'alice-key',
) => {
  const body = await rpc(opened.handler, 'bureau.contexts.list', params, key);
  return body.result as {
    contexts: { id: string; archivedAt: string | null }[];
    nextOffset: number | null;
  };
};

/** The fault an archived context answers new work with. */
function expectArchivedFault(body: RpcBody): void {
  expect(body.result).toBeUndefined();
  expect(body.error?.data).toMatchObject({ weftCode: 'Conflict', reason: 'context-archived' });
  expect(body.error?.data?.httpStatus).not.toBe(404);
}

describe('bureau.contexts.archive and bureau.contexts.unarchive', () => {
  it('are served by the handler', () => {
    expect(BUREAU_HANDLER_OPERATIONS).toContain(contextsArchiveOperation);
    expect(BUREAU_HANDLER_OPERATIONS).toContain(contextsUnarchiveOperation);
  });

  it('records when the context was archived, shows it in get and list, and takes it away again', async () => {
    await withBureau(async (opened) => {
      const run = await finishedSession(opened, 'the opening question');
      expect((await getOf(opened, run.contextId)).result?.['archivedAt']).toBeNull();

      const archived = await archive(opened, run.contextId);

      expect(archived.result).toEqual({
        id: run.contextId,
        changed: true,
        archivedAt: expect.any(String),
      });
      const archivedAt = archived.result?.['archivedAt'] as string;
      expect(Number.isNaN(Date.parse(archivedAt))).toBe(false);
      expect((await getOf(opened, run.contextId)).result?.['archivedAt']).toBe(archivedAt);
      expect((await listOf(opened)).contexts).toEqual([
        expect.objectContaining({ id: run.contextId, archivedAt }),
      ]);
      // Durable: the session's own metadata holds it.
      const stored = await opened.bureau.contexts.get(run.contextId);
      expect(stored?.metadata[SESSION_ARCHIVED_AT_METADATA_KEY]).toBe(archivedAt);

      const unarchived = await unarchive(opened, run.contextId);

      expect(unarchived.result).toEqual({ id: run.contextId, changed: true, archivedAt: null });
      expect((await getOf(opened, run.contextId)).result?.['archivedAt']).toBeNull();
      const after = await opened.bureau.contexts.get(run.contextId);
      expect(Object.keys(after!.metadata)).not.toContain(SESSION_ARCHIVED_AT_METADATA_KEY);
    });
  });

  it('is safe to retry both ways: an archived context keeps the time it was first archived', async () => {
    await withBureau(async (opened) => {
      const run = await finishedSession(opened, 'q');

      const notArchived = await unarchive(opened, run.contextId);
      const first = await archive(opened, run.contextId);
      const second = await archive(opened, run.contextId);
      const unarchived = await unarchive(opened, run.contextId);
      const again = await unarchive(opened, run.contextId);

      expect(notArchived.result).toEqual({ id: run.contextId, changed: false, archivedAt: null });
      expect(second.result).toEqual({
        id: run.contextId,
        changed: false,
        archivedAt: first.result?.['archivedAt'],
      });
      expect(unarchived.result).toEqual({ id: run.contextId, changed: true, archivedAt: null });
      expect(again.result).toEqual({ id: run.contextId, changed: false, archivedAt: null });
    });
  });

  it('is not activity: updatedAt and the order of the listing do not move', async () => {
    await withBureau(async (opened) => {
      const older = await finishedSession(opened, 'older');
      const newer = await finishedSession(opened, 'newer');
      const before = await getOf(opened, older.contextId);

      await archive(opened, older.contextId);
      const archived = await getOf(opened, older.contextId);
      await unarchive(opened, older.contextId);
      const unarchived = await getOf(opened, older.contextId);

      expect(archived.result?.['updatedAt']).toBe(before.result?.['updatedAt']);
      expect(unarchived.result?.['updatedAt']).toBe(before.result?.['updatedAt']);
      await archive(opened, older.contextId);
      const ids = (await listOf(opened)).contexts.map((context) => context.id);
      expect(ids).toEqual([newer.contextId, older.contextId]);
    });
  });

  it('lists every context by default and for include, filters for exclude and only, and pages after filtering', async () => {
    await withBureau(async (opened) => {
      const runs = [];
      for (const message of ['one', 'two', 'three', 'four', 'five'])
        runs.push(await finishedSession(opened, message));
      // Newest first: five, four, three, two, one. Archive four and two.
      const [one, two, three, four, five] = runs.map((run) => run.contextId) as [
        string,
        string,
        string,
        string,
        string,
      ];
      await archive(opened, four);
      await archive(opened, two);
      const idsOf = (page: { contexts: { id: string }[] }) => page.contexts.map((row) => row.id);

      expect(idsOf(await listOf(opened))).toEqual([five, four, three, two, one]);
      expect(idsOf(await listOf(opened, { archived: 'include' }))).toEqual([
        five,
        four,
        three,
        two,
        one,
      ]);
      const firstKept = await listOf(opened, { archived: 'exclude', limit: 2 });
      const secondKept = await listOf(opened, { archived: 'exclude', limit: 2, offset: 2 });
      expect(idsOf(firstKept)).toEqual([five, three]);
      expect(firstKept.nextOffset).toBe(2);
      expect(idsOf(secondKept)).toEqual([one]);
      expect(secondKept.nextOffset).toBeNull();
      const firstArchived = await listOf(opened, { archived: 'only', limit: 1 });
      const secondArchived = await listOf(opened, { archived: 'only', limit: 1, offset: 1 });
      expect(idsOf(firstArchived)).toEqual([four]);
      expect(firstArchived.nextOffset).toBe(1);
      expect(idsOf(secondArchived)).toEqual([two]);
      expect(secondArchived.nextOffset).toBeNull();
      // The activity filter reads the same filtered index.
      expect(idsOf(await listOf(opened, { archived: 'only', activity: 'idle' }))).toEqual([
        four,
        two,
      ]);
      const refused = await rpc(
        opened.handler,
        'bureau.contexts.list',
        { archived: 'some' },
        'alice-key',
      );
      expect(refused.error?.data).toMatchObject({ weftCode: 'InvalidParams' });
    });
  });

  it('keeps the archive across a restart of the Bureau', async () => {
    const fixture = createMemoryStorageFixture();
    try {
      const first = await openBureau({ agents: { agent }, storage: fixture.storage });
      let contextId: string;
      let archivedAt: unknown;
      try {
        const run = await finishedSession(first, 'before the restart');
        contextId = run.contextId;
        archivedAt = (await archive(first, contextId)).result?.['archivedAt'];
      } finally {
        await first.dispose();
      }

      const second = await openBureau({ agents: { agent }, storage: fixture.storage });
      try {
        expect((await getOf(second, contextId)).result?.['archivedAt']).toBe(archivedAt);
        expect((await listOf(second, { archived: 'only' })).contexts.map((row) => row.id)).toEqual([
          contextId,
        ]);
        expect(
          await rejectionOf(
            second.bureau.tasks.start('agent', 'after the restart', {
              contextId,
              principal: OWNER.alice,
            }),
          ),
        ).toBeInstanceOf(ContextArchivedError);
      } finally {
        await second.dispose();
      }
    } finally {
      await fixture.dispose();
    }
  });

  it('answers another owner’s context, and a write-less scope, exactly as a missing one, and changes nothing', async () => {
    await withBureau(async (opened) => {
      const run = await finishedSession(opened, 'private');

      for (const operation of ['bureau.contexts.archive', 'bureau.contexts.unarchive']) {
        const stranger = await rpc(
          opened.handler,
          operation,
          { contextId: run.contextId },
          'bob-key',
        );
        const readOnly = await rpc(
          opened.handler,
          operation,
          { contextId: run.contextId },
          'tasks-reader-key',
        );
        const missing = await rpc(
          opened.handler,
          operation,
          { contextId: 'no-such-context' },
          'bob-key',
        );

        expect(stranger.error?.data?.httpStatus).toBe(404);
        expect(readOnly.error?.data?.httpStatus).toBe(404);
        expect(JSON.stringify(stranger).replaceAll(run.contextId, '<id>')).toBe(
          JSON.stringify(missing).replaceAll('no-such-context', '<id>'),
        );
      }
      expect((await getOf(opened, run.contextId)).result?.['archivedAt']).toBeNull();
    });
  });

  it('lets a caller holding bureau.contexts:write archive any owner’s context, and shows it only a receipt', async () => {
    await withBureau(async (opened) => {
      const run = await finishedSession(opened, 'alice’s');

      const archived = await archive(opened, run.contextId, 'contexts-writer-key');

      expect(Object.keys(archived.result ?? {}).toSorted()).toEqual([
        'archivedAt',
        'changed',
        'id',
      ]);
      expect(JSON.stringify(archived)).not.toContain('alice’s');
      expect((await getOf(opened, run.contextId)).result?.['archivedAt']).toBe(
        archived.result?.['archivedAt'],
      );
      expect((await unarchive(opened, run.contextId, 'contexts-writer-key')).result).toMatchObject({
        changed: true,
      });
    });
  });

  it('reads a malformed archive value as not archived, and takes work in that context', async () => {
    await withBureau(async (opened) => {
      const run = await finishedSession(opened, 'q');
      await opened.bureau.internals.sessionStore!.update(run.contextId, (session) =>
        session === undefined
          ? undefined
          : {
              ...session,
              metadata: { ...session.metadata, [SESSION_ARCHIVED_AT_METADATA_KEY]: 'not a time' },
            },
      );

      expect((await getOf(opened, run.contextId)).result?.['archivedAt']).toBeNull();
      expect((await listOf(opened, { archived: 'only' })).contexts).toEqual([]);
      const next = await opened.bureau.tasks.start('agent', 'still open', {
        contextId: run.contextId,
        principal: OWNER.alice,
      });
      await waitForTaskState(opened.bureau, next.id);
      // An unarchive clears the malformed value, and says nothing was archived.
      expect((await unarchive(opened, run.contextId)).result).toEqual({
        id: run.contextId,
        changed: false,
        archivedAt: null,
      });
      const session = await opened.bureau.contexts.get(run.contextId);
      expect(Object.keys(session!.metadata)).not.toContain(SESSION_ARCHIVED_AT_METADATA_KEY);
    });
  });
});

describe('an archived context', () => {
  it('starts no task, in process, and is let through again once unarchived', async () => {
    await withBureau(async (opened) => {
      const run = await finishedSession(opened, 'first');
      await archive(opened, run.contextId);
      const before = await opened.bureau.contexts.get(run.contextId);

      const refusal = await rejectionOf(
        opened.bureau.tasks.start('agent', 'second', {
          contextId: run.contextId,
          principal: OWNER.alice,
        }),
      );

      expect(refusal).toBeInstanceOf(ContextArchivedError);
      expect(refusal).toMatchObject({ code: 'CONFLICT', reason: 'context-archived' });
      const after = await opened.bureau.contexts.get(run.contextId);
      expect(after?.revision).toBe(before?.revision);
      expect(after?.conversationHistory.ids).toEqual(before?.conversationHistory.ids);

      await unarchive(opened, run.contextId);
      const resumed = await opened.bureau.tasks.start('agent', 'second', {
        contextId: run.contextId,
        principal: OWNER.alice,
      });
      await waitForTaskState(opened.bureau, resumed.id);
      expect((await opened.bureau.tasks.detail(resumed.id))?.status).toBe('completed');
    });
  });

  it('answers another owner’s start as a missing context, not as an archived one', async () => {
    await withBureau(async (opened) => {
      const run = await finishedSession(opened, 'first');
      await archive(opened, run.contextId);

      const refusal = await rejectionOf(
        opened.bureau.tasks.start('agent', 'intrude', {
          contextId: run.contextId,
          principal: OWNER.bob,
        }),
      );

      expect(refusal).not.toBeInstanceOf(ContextArchivedError);
      expect(refusal).toMatchObject({ code: 'NOT_FOUND' });
    });
  });

  it('still replays a task started before the archive, by its command id', async () => {
    await withBureau(async (opened) => {
      const run = await opened.bureau.tasks.start('agent', 'first', {
        principal: OWNER.alice,
        commandId: 'command-1',
      });
      await waitForTaskState(opened.bureau, run.id);
      await archive(opened, run.contextId);

      const replay = await opened.bureau.tasks.start('agent', 'first', {
        principal: OWNER.alice,
        commandId: 'command-1',
      });

      expect(replay.id).toBe(run.id);
    });
  });

  it('refuses input, steering and a regenerated answer as context-archived, before anything is stored', async () => {
    await withBureau(async (opened) => {
      const run = await finishedSession(opened, 'first');
      await archive(opened, run.contextId);
      const before = await opened.bureau.contexts.get(run.contextId);

      expectArchivedFault(
        await rpc(
          opened.handler,
          'bureau.contexts.input',
          { contextId: run.contextId, input: { id: 'input-1', payload: 'more' } },
          'alice-key',
        ),
      );
      expectArchivedFault(
        await rpc(
          opened.handler,
          'bureau.contexts.steer',
          { contextId: run.contextId, commandId: 'steer-1', permissionMode: 'read-only' },
          'alice-key',
        ),
      );
      expectArchivedFault(
        await rpc(
          opened.handler,
          'bureau.contexts.regenerate',
          {
            contextId: run.contextId,
            commandId: 'regenerate-1',
            messageId: before!.conversationHistory.ids.at(-1),
          },
          'alice-key',
        ),
      );
      const after = await opened.bureau.contexts.get(run.contextId);
      expect(after?.revision).toBe(before?.revision);
      expect((await getOf(opened, run.contextId)).result?.['configVersion']).toBe(0);
    });
  });

  it('answers another owner’s input exactly as a missing context, not as an archived one', async () => {
    await withBureau(async (opened) => {
      const run = await finishedSession(opened, 'first');
      await archive(opened, run.contextId);

      const send = (contextId: string) =>
        rpc(
          opened.handler,
          'bureau.contexts.input',
          { contextId, input: { id: 'input-1', payload: 'more' } },
          'bob-key',
        );
      const stranger = await send(run.contextId);
      const missing = await send('no-such-context');

      expect(stranger.error?.data?.httpStatus).toBe(404);
      expect(JSON.stringify(stranger).replaceAll(run.contextId, '<id>')).toBe(
        JSON.stringify(missing).replaceAll('no-such-context', '<id>'),
      );
    });
  });

  it('can still be read, renamed, forked, measured, have its grants forgotten, and be deleted', async () => {
    await withBureau(async (opened) => {
      const run = await finishedSession(opened, 'first');
      await archive(opened, run.contextId);
      const call = (method: string, params: Record<string, unknown>) =>
        rpc(opened.handler, method, { contextId: run.contextId, ...params }, 'alice-key');

      expect((await call('bureau.contexts.get', {})).error).toBeUndefined();
      expect((await call('bureau.contexts.window', {})).error).toBeUndefined();
      expect((await call('bureau.contexts.rename', { title: 'Old trip' })).result).toMatchObject({
        title: 'Old trip',
      });
      expect(
        (await call('bureau.contexts.forgetgrants', { tools: ['charge-card'] })).result,
      ).toEqual({ forgotten: [] });
      const fork = await call('bureau.contexts.fork', {
        commandId: 'fork-1',
        throughMessageId: null,
      });
      expect(fork.error).toBeUndefined();
      // The fork is a new context, and is not born archived.
      const forkId = fork.result?.['contextId'] as string;
      expect((await getOf(opened, forkId)).result?.['archivedAt']).toBeNull();
      expect((await call('bureau.contexts.get', {})).result?.['archivedAt']).toEqual(
        expect.any(String),
      );
      expect((await call('bureau.contexts.delete', {})).result).toMatchObject({
        receipt: 'applied',
      });
    });
  });
});

describe('archiving a context with a live task', () => {
  it('is refused as context-busy while a task is running, and stores nothing', async () => {
    await withBureau(
      async (opened) => {
        const run = await opened.bureau.tasks.start('default', 'work', { principal: OWNER.alice });
        await waitForCondition(
          () => opened.bureau.tasks.detail(run.id)?.status === 'running',
          'the run started',
        );

        const body = await archive(opened, run.contextId);

        expect(body.error?.data).toMatchObject({ weftCode: 'Conflict', reason: 'context-busy' });
        expect((await getOf(opened, run.contextId)).result?.['archivedAt']).toBeNull();
        expect(await rejectionOf(opened.bureau.contexts.archive(run.contextId))).toBeInstanceOf(
          ContextBusyError,
        );
      },
      { generate: parkingUntilAborted },
    );
  });

  it('is refused as context-busy while a task waits on an approval, and goes through once it is stopped', async () => {
    const charges: number[] = [];
    await withBureau(
      async (opened) => {
        const run = await opened.bureau.tasks.start('default', 'charge', {
          principal: OWNER.alice,
        });
        await waitForCondition(
          () => opened.bureau.reviews.list().some((review) => review.runId === run.id),
          'the approval became pending',
        );

        const body = await archive(opened, run.contextId);

        expect(body.error?.data).toMatchObject({ weftCode: 'Conflict', reason: 'context-busy' });
        expect((await getOf(opened, run.contextId)).result?.['archivedAt']).toBeNull();

        const denied = await rpc(
          opened.handler,
          'bureau.tasks.respond',
          { taskId: run.id, messageId: 'deny-1', decision: 'deny' },
          'alice-key',
        );
        expect(denied.error).toBeUndefined();
        await waitForCondition(async () => {
          const attempt = await opened.bureau.contexts
            .archive(run.contextId)
            .catch((error: unknown) => {
              if (error instanceof ContextBusyError) return undefined;
              throw error;
            });
          return attempt !== undefined;
        }, 'the context could be archived once the approval was answered');
        expect((await getOf(opened, run.contextId)).result?.['archivedAt']).toEqual(
          expect.any(String),
        );
      },
      { generate: chargesOnce, toolbox: approvalToolbox(charges), stopAtApproval: true },
    );
  });

  it('is refused as context-busy while a task waits on a person’s answer', async () => {
    let calls = 0;
    await withBureau(
      async (opened) => {
        const run = await opened.bureau.tasks.start('default', 'ask', { principal: OWNER.alice });
        await waitForCondition(
          () => opened.bureau.reviews.list().some((review) => review.runId === run.id),
          'the question was put to a person',
        );

        const body = await archive(opened, run.contextId);

        expect(body.error?.data).toMatchObject({ weftCode: 'Conflict', reason: 'context-busy' });
        expect((await getOf(opened, run.contextId)).result?.['archivedAt']).toBeNull();
      },
      {
        generate: async () => {
          calls += 1;
          return calls === 1
            ? {
                content: '',
                toolCalls: [
                  {
                    id: 'wait-1',
                    name: 'requestHumanInput',
                    arguments: { signalName: 'human-response', prompt: 'Which?' },
                  },
                ],
              }
            : { content: 'resolved', toolCalls: [] };
        },
      },
    );
  });
});

describe('an archive and a start racing on one context', () => {
  it('refuses a start whose context was archived after the start read it, inside the write that would start the run', async () => {
    let opened: OpenedBureau | undefined;
    let contextId = '';
    const bodyKey = 'agent-session-v2:body:';
    const interleaver = createStorageInterleaver(
      (verb, args) => verb === 'get' && String(args[0]).startsWith(bodyKey),
      async () => {
        expect(await opened!.bureau.contexts.archive(contextId)).toMatchObject({ changed: true });
      },
    );
    const fixture = createMemoryStorageFixture({ wrapStorage: (raw) => interleaver.wrap(raw) });
    try {
      opened = await openBureau({ agents: { agent }, storage: fixture.storage });
      const run = await finishedSession(opened, 'first');
      contextId = run.contextId;
      const before = await opened.bureau.contexts.get(contextId);
      interleaver.arm();

      const refusal = await rejectionOf(
        opened.bureau.tasks.start('agent', 'second', { contextId, principal: OWNER.alice }),
      );

      expect(refusal).toBeInstanceOf(ContextArchivedError);
      const after = await opened.bureau.contexts.get(contextId);
      expect(after?.conversationHistory.ids).toEqual(before?.conversationHistory.ids);
      expect(after?.metadata['lastRunId']).toBe(run.id);
      expect((await getOf(opened, contextId)).result?.['archivedAt']).toEqual(expect.any(String));
    } finally {
      await opened?.dispose();
      await fixture.dispose();
    }
  });

  it('refuses an archive as context-busy when a start commits after the archive decided the context was idle', async () => {
    let opened: OpenedBureau | undefined;
    let contextId = '';
    let started: { id: string } | undefined;
    const bodyKey = 'agent-session-v2:body:';
    let bodyReads = 0;
    // The archive reads the body once to decide, then again inside its update: the start lands
    // between the two, after the decision and before the write.
    const interleaver = createStorageInterleaver(
      (verb, args) =>
        verb === 'get' && String(args[0]).startsWith(bodyKey) && (bodyReads += 1) === 2,
      async () => {
        started = await opened!.bureau.tasks.start('default', 'second', {
          contextId,
          principal: OWNER.alice,
        });
      },
    );
    const fixture = createMemoryStorageFixture({ wrapStorage: (raw) => interleaver.wrap(raw) });
    try {
      opened = await openBureau({
        agents: { agent },
        storage: fixture.storage,
        generate: parkingUntilAborted,
      });
      const first = await opened.bureau.tasks.start('default', 'first', {
        principal: OWNER.alice,
        commandId: 'first',
      });
      contextId = first.contextId;
      await waitForCondition(
        () => opened!.bureau.tasks.detail(first.id)?.status === 'running',
        'the first run started',
      );
      first.abort('done');
      await waitForTaskState(opened.bureau, first.id);
      await waitForCondition(async () => {
        const session = await opened!.bureau.contexts.get(contextId);
        return session?.metadata['lastRunStatus'] !== 'running';
      }, 'the first run’s end was saved');
      interleaver.arm();

      const refusal = await rejectionOf(opened.bureau.contexts.archive(contextId));

      expect(refusal).toBeInstanceOf(ContextBusyError);
      expect(started).toBeDefined();
      expect(opened.bureau.tasks.detail(started!.id)?.status).toBe('running');
      expect((await getOf(opened, contextId)).result?.['archivedAt']).toBeNull();
    } finally {
      await opened?.dispose();
      await fixture.dispose();
    }
  });
});

describe('Bureau.contexts.archive and unarchive', () => {
  it('resolve undefined for a context this Bureau does not hold, or of another incarnation', async () => {
    await withBureau(async (opened) => {
      const run = await finishedSession(opened, 'q');

      expect(await opened.bureau.contexts.archive('no-such-context')).toBeUndefined();
      expect(await opened.bureau.contexts.unarchive('no-such-context')).toBeUndefined();
      expect(
        await opened.bureau.contexts.archive(run.contextId, { incarnation: 'another' }),
      ).toBeUndefined();
      expect(
        await opened.bureau.contexts.unarchive(run.contextId, { incarnation: 'another' }),
      ).toBeUndefined();
      const session = await opened.bureau.contexts.get(run.contextId);
      expect(session?.metadata[SESSION_ARCHIVED_AT_METADATA_KEY]).toBeUndefined();
    });
  });

  it('refuse once the Bureau is shutting down', async () => {
    const opened = await openBureau({ agents: { agent } });
    try {
      const run = await finishedSession(opened, 'q');
      await opened.bureau.shutdown();

      expect(await rejectionOf(opened.bureau.contexts.archive(run.contextId))).toBeInstanceOf(
        BureauShuttingDownError,
      );
      expect(await rejectionOf(opened.bureau.contexts.unarchive(run.contextId))).toBeInstanceOf(
        BureauShuttingDownError,
      );
    } finally {
      await opened.dispose();
    }
  });
});

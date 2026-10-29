/**
 * COR-1670 part 2 — a durable peer call survives a restart of the Bureau that made it. The caller's
 * agent calls a peer (another Bureau's A2A mount) through `createPeerCallTool({ durable })`; the
 * process dies while the peer works; the restarted Bureau replays the tool call and follows the
 * peer task it already started, so the peer receives the message once.
 */
import { createAgent, createPeerCallTool, stopWhen } from '@lostgradient/operative';
import { createA2APeerClient } from '@lostgradient/weft/a2a';
import { createTool, createToolbox } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import type { AgentDefinitions } from './agent-catalog';
import { createBureau } from './create-bureau';
import { PEER_CALL_KEY_PREFIX } from './child-topology-store';
import {
  type OpenedBureau,
  openBureau,
} from './http/management/management-fixtures.test-support.ts';
import { waitForCondition } from './test';
import {
  IMMEDIATE_TASK_RETENTION,
  retireSettledTasksOnRealClock,
} from './testing/run-retirement.test-support';
import type { Bureau } from './types';
import {
  createSqliteStorageFixture,
  type PersistentBureauStorageFixture,
} from './test/storage-fixtures';

const ORIGIN = 'https://agents.example.test';
const databases: PersistentBureauStorageFixture[] = [];
const bureaus: Bureau<AgentDefinitions>[] = [];
const peers: OpenedBureau[] = [];
/** `waitForCondition`, which waits on the hang guard: these waits cross sqlite, HTTP and a restart. */
const eventually = (condition: () => boolean | Promise<boolean>, failureMessage: string) =>
  waitForCondition(condition, failureMessage);
/** Writes held open to stand in for a process dying inside them; released so teardown can finish. */
const heldWrites: Array<() => void> = [];

afterEach(async () => {
  for (const release of heldWrites.splice(0)) release();
  for (const bureau of bureaus.splice(0)) await bureau.dispose();
  for (const peer of peers.splice(0)) await peer.dispose();
  for (const database of databases.splice(0)) await database.dispose();
});

/** The remote Bureau: its `asker` agent works until the test lets it answer. */
async function openPeer() {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  const received: string[] = [];
  const opened = await openBureau({
    agents: {
      asker: createAgent({
        name: 'asker',
        description: 'Answers.',
        generate: async () => {
          received.push('run');
          await gate;
          return { content: 'peer answer', toolCalls: [] };
        },
      }),
    },
    publish: ['asker'],
    handlerOptions: { publicUrl: ORIGIN },
  });
  peers.push(opened);
  const rpcMethods: string[] = [];
  const messageIds: string[] = [];
  const fetchPeer = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.method === 'POST') {
      const body = (await request.clone().json()) as {
        method?: string;
        params?: { message?: { messageId?: string } };
      };
      rpcMethods.push(body.method ?? '');
      if (body.params?.message?.messageId !== undefined) {
        messageIds.push(body.params.message.messageId);
      }
    }
    return opened.handler(request);
  }) as typeof fetch;
  return { opened, release, received, rpcMethods, messageIds, fetchPeer };
}

/**
 * A fetch that stops answering once `dead()` is true, like a process that has died: new requests
 * fail and an open response stream delivers nothing more.
 */
function mortalFetch(base: typeof fetch, dead: () => boolean): typeof fetch {
  const forever = (): Promise<void> => new Promise<void>(() => {});
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (dead()) throw new TypeError('fetch failed: the process is gone');
    const response = await base(input, init);
    if (response.body === null) return response;
    const reader = response.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const chunk = await reader.read();
        if (dead()) return forever();
        if (chunk.done) controller.close();
        else controller.enqueue(chunk.value);
      },
      cancel: (reason) => reader.cancel(reason),
    });
    return new Response(body, { status: response.status, headers: response.headers });
  }) as typeof fetch;
}

/** A Bureau over a new handle on `database` whose `caller` agent asks the peer on its first step. */
async function callerBureau(
  database: PersistentBureauStorageFixture,
  peerFetch: typeof fetch,
  holder: {
    journal?: Bureau<AgentDefinitions>;
    writes: string[];
    /** Called as a write starts; the write then never finishes, like a process dying inside it. */
    dieInWrite?: () => void;
  },
): Promise<Bureau<AgentDefinitions>> {
  const peerTool = createPeerCallTool({
    name: 'askPeer',
    description: 'Ask the peer.',
    peer: createA2APeerClient({
      url: `${ORIGIN}/a2a/asker`,
      fetch: peerFetch,
      authenticate: async () => ({ 'X-API-Key': 'alice-key' }),
      attempts: 1,
      pollIntervalMs: 5,
      taskTimeoutMs: 20_000,
    }),
    // The agent is built before the Bureau, so the journal is reached through a reference.
    durable: {
      read: (key) => holder.journal!.peerCalls.read(key),
      write: async (key, entry) => {
        if (holder.dieInWrite !== undefined) {
          holder.dieInWrite();
          return new Promise<void>((resolve) => heldWrites.push(resolve));
        }
        await holder.journal!.peerCalls.write(key, entry);
        holder.writes.push(key.operationKey);
      },
    },
  });
  const agent = createAgent({
    generate: async ({ step }) =>
      step === 0
        ? { content: '', toolCalls: [{ name: 'askPeer', arguments: { message: 'question' } }] }
        : { content: 'the peer replied', toolCalls: [] },
    toolbox: createToolbox([
      peerTool,
      createTool({ name: 'noop', description: 'x', input: z.object({}), execute: async () => '' }),
    ]),
    stopWhen: stopWhen.noToolCalls(),
  });
  const bureau = await createBureau<AgentDefinitions>({
    agents: { caller: agent },
    storage: database.open(),
    durable: true,
    durableOwnership: { ownership: 'none' },
  });
  bureaus.push(bureau);
  holder.journal = bureau;
  return bureau;
}

describe('a durable peer call across a restart', () => {
  it('follows the peer task it already started instead of sending again', async () => {
    const peer = await openPeer();
    const database = createSqliteStorageFixture();
    databases.push(database);
    let dead = false;
    const firstHolder = { writes: [] as string[] };

    const first = await callerBureau(
      database,
      mortalFetch(peer.fetchPeer, () => dead),
      firstHolder,
    );
    const run = await first.tasks.start('caller', 'go');
    await eventually(
      () => firstHolder.writes.length === 1,
      'the call never recorded its peer task',
    );
    // The process dies here, mid-call, with the peer still working. It is not disposed: a graceful
    // shutdown would cancel the run and leave nothing to recover.
    dead = true;
    await eventually(() => peer.received.length === 1, 'the peer never started working');

    const secondHolder = { writes: [] as string[] };
    const second = await callerBureau(database, peer.fetchPeer, secondHolder);
    peer.release();
    await eventually(async () => {
      const session = await second.contexts.get(run.contextId);
      return session?.metadata['lastRunStatus'] === 'completed';
    }, 'the restarted run never completed');

    // One message reached the peer: the replay attached, it did not send.
    expect(peer.received).toEqual(['run']);
    expect(peer.rpcMethods.filter((method) => method.startsWith('SendMessage'))).toHaveLength(0);
    expect(
      peer.rpcMethods.filter(
        (method) => method === 'SendStreamingMessage' || method === 'SendMessage',
      ),
    ).toHaveLength(1);
    // The replay found the record and so wrote nothing new.
    expect(secondHolder.writes).toEqual([]);
    const session = await second.contexts.get(run.contextId);
    const history = JSON.stringify(session?.conversationHistory);
    expect(history).toContain('peer answer');
    expect(PEER_CALL_KEY_PREFIX).toBeTruthy();
  });

  it('resends with the same message id when the process died before the record was written', async () => {
    const peer = await openPeer();
    const database = createSqliteStorageFixture();
    databases.push(database);
    let dead = false;
    let diedInWrite = false;
    const firstHolder = {
      writes: [] as string[],
      dieInWrite: () => {
        diedInWrite = true;
      },
    };

    const first = await callerBureau(
      database,
      mortalFetch(peer.fetchPeer, () => dead),
      firstHolder,
    );
    const run = await first.tasks.start('caller', 'go');
    await eventually(() => diedInWrite, 'the call never reached its journal write');
    await eventually(() => peer.received.length === 1, 'the peer never started working');
    dead = true;

    const second = await callerBureau(database, peer.fetchPeer, { writes: [] });
    peer.release();
    await eventually(async () => {
      const session = await second.contexts.get(run.contextId);
      return session?.metadata['lastRunStatus'] === 'completed';
    }, 'the restarted run never completed');

    // The replay found no record and sent again, with the id the first send carried; the peer
    // answered with the task that send created instead of starting another.
    expect(peer.messageIds).toHaveLength(2);
    expect(peer.messageIds[1]).toBe(peer.messageIds[0]);
    expect(peer.received).toEqual(['run']);
    const session = await second.contexts.get(run.contextId);
    expect(JSON.stringify(session?.conversationHistory)).toContain('peer answer');
  });
});

describe('the Bureau peer call journal', () => {
  async function bureauWithRun() {
    const database = createSqliteStorageFixture();
    databases.push(database);
    const bureau = await createBureau<AgentDefinitions>({
      agents: {
        caller: createAgent({ generate: async () => ({ content: 'done', toolCalls: [] }) }),
      },
      storage: database.open(),
      ...IMMEDIATE_TASK_RETENTION,
    });
    bureaus.push(bureau);
    const run = await bureau.tasks.start('caller', 'go');
    await eventually(async () => {
      const session = await bureau.contexts.get(run.contextId);
      return session?.metadata['lastRunStatus'] === 'completed';
    }, 'the run never completed');
    return { bureau, run };
  }

  const entry = { taskId: 'task-1', contextId: 'context-1', requestDigest: 'digest-1' };

  it('records a call for a run it knows and reads it back, once', async () => {
    const { bureau, run } = await bureauWithRun();
    const key = { parentRunId: run.id, operationKey: 'op-1' };

    await bureau.peerCalls.write(key, entry);
    await bureau.peerCalls.write(key, entry);

    expect(await bureau.peerCalls.read(key)).toEqual(entry);
    expect(await bureau.peerCalls.read({ ...key, operationKey: 'op-2' })).toBeUndefined();
  });

  it('refuses a second task for the same operation', async () => {
    const { bureau, run } = await bureauWithRun();
    const key = { parentRunId: run.id, operationKey: 'op-1' };
    await bureau.peerCalls.write(key, entry);

    expect(
      await rejectionOf(bureau.peerCalls.write(key, { ...entry, taskId: 'task-2' })),
    ).toMatchObject({ code: 'CONFLICT' });
    expect(await bureau.peerCalls.read(key)).toEqual(entry);
  });

  it('deletes a run’s records with the run, and no other run’s', async () => {
    const { bureau, run } = await bureauWithRun();
    const key = { parentRunId: run.id, operationKey: 'op-1' };
    await bureau.peerCalls.write(key, entry);

    await retireSettledTasksOnRealClock(bureau);
    await eventually(
      async () => (await bureau.peerCalls.read(key)) === undefined,
      'the run’s peer call records were not deleted with it',
    );
  });

  it('refuses a record that names no task or no operation', async () => {
    const { bureau, run } = await bureauWithRun();

    const noTask = await rejectionOf(
      bureau.peerCalls.write(
        { parentRunId: run.id, operationKey: 'op-1' },
        { ...entry, taskId: '' },
      ),
    );
    const noOperation = await rejectionOf(
      bureau.peerCalls.write({ parentRunId: run.id, operationKey: '' }, entry),
    );
    expect(noTask).toMatchObject({ code: 'BAD_REQUEST' });
    expect(noOperation).toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('refuses a write for a run it never knew', async () => {
    const { bureau } = await bureauWithRun();
    const key = { parentRunId: 'run-that-never-was', operationKey: 'op-1' };

    expect(await rejectionOf(bureau.peerCalls.write(key, entry))).toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(await bureau.peerCalls.read(key)).toBeUndefined();
  });
});

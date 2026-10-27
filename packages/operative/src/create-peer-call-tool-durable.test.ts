/**
 * COR-1670 part 2: a peer call with a `durable` journal survives a restart. The first run of a tool
 * call sends and records the task it started; a replay of the same call follows that task.
 */
import { CompletableEventTarget } from '@lostgradient/lifecycle';
import {
  A2APeerError,
  type A2APeerAttachRequest,
  type A2APeerCard,
  type A2APeerClient,
  type A2APeerOutcome,
  type A2APeerSendRequest,
  type A2APeerTask,
} from '@lostgradient/weft/a2a';
import { describe, expect, it } from 'bun:test';

import { waitUntil } from '@lostgradient/testing/wait-until';
import { createChildRunRegistry } from './child-run';
import {
  createPeerCallTool,
  PeerCallJournalError,
  PeerCallMismatchError,
  type PeerCallJournal,
  type PeerCallJournalEntry,
  type PeerCallJournalKey,
} from './create-peer-call-tool';
import type { CombinedOperativeEventMap } from './events';

const CARD: A2APeerCard = {
  name: 'Researcher',
  version: '2.0.0',
  description: 'Finds things.',
  cardUrl: 'https://peer.example/.well-known/agent-card.json',
  interfaceUrl: 'https://peer.example/a2a',
  streaming: true,
  activeExtensions: [],
};

function outcome(taskId = 'task-1'): A2APeerOutcome {
  return {
    untrusted: true,
    state: 'completed',
    taskId,
    contextId: 'context-1',
    provenance: {
      agentName: CARD.name,
      agentVersion: CARD.version,
      cardUrl: CARD.cardUrl,
      taskId,
    },
    message: 'found it',
    artifacts: [],
  };
}

/** What the fake peer does with the call that reaches it. */
interface PeerScript {
  /** The task id the peer names; empty answers with a bare message. */
  taskId?: string;
  /** Makes `attach` fail like a peer that forgot the task. */
  attachError?: A2APeerError;
}

function fakePeer(script: PeerScript = {}) {
  const sends: A2APeerSendRequest[] = [];
  const attaches: A2APeerAttachRequest[] = [];
  const cancels: (string | undefined)[] = [];
  const task = (taskId: string): A2APeerTask => ({
    taskId,
    contextId: 'context-1',
    provenance: outcome(taskId).provenance,
    state: () => 'completed',
    result: async () => outcome(taskId),
    cancel: async (reason) => {
      cancels.push(reason);
      return { ...outcome(taskId), state: 'canceled' };
    },
  });
  const client: A2APeerClient = {
    card: async () => CARD,
    send: async (request) => {
      sends.push(request);
      return task(script.taskId ?? 'task-1');
    },
    attach: async (request) => {
      attaches.push(request);
      if (script.attachError !== undefined) throw script.attachError;
      return task(request.taskId);
    },
  };
  return { client, sends, attaches, cancels };
}

/** A journal in a map, which a "restarted" tool can share with the one that wrote it. */
function memoryJournal(
  faults: { read?: Error; write?: Error } = {},
): PeerCallJournal & { entries: Map<string, PeerCallJournalEntry> } {
  const entries = new Map<string, PeerCallJournalEntry>();
  const id = (key: PeerCallJournalKey): string =>
    JSON.stringify([key.parentRunId, key.operationKey]);
  return {
    entries,
    read: async (key) => {
      if (faults.read !== undefined) throw faults.read;
      return entries.get(id(key));
    },
    write: async (key, entry) => {
      if (faults.write !== undefined) throw faults.write;
      entries.set(id(key), entry);
    },
  };
}

function toolOver(client: A2APeerClient, journal: PeerCallJournal | undefined) {
  const registry = createChildRunRegistry();
  const emitter = new CompletableEventTarget<CombinedOperativeEventMap>();
  const tool = createPeerCallTool({
    name: 'ask_researcher',
    description: 'Ask the researcher agent.',
    peer: client,
    durable: journal,
    parentContext: { emitter, parentAgentName: 'orchestrator', parentRunId: 'run-1', registry },
  });
  const call = (
    params: Record<string, unknown>,
    context: { durableOperationKey?: string; signal?: AbortSignal } = {},
  ): Promise<unknown> =>
    (tool as unknown as { rawExecute: (p: unknown, c: unknown) => Promise<unknown> }).rawExecute(
      params,
      context,
    );
  return { registry, call };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the promise to reject');
}

const KEY = 'schedule-safe:run-1:step-0:tool-0:ask_researcher';

describe('a durable peer call', () => {
  it('sends with a message id derived from its operation key, then records the task', async () => {
    const peer = fakePeer();
    const journal = memoryJournal();
    const { call } = toolOver(peer.client, journal);

    const result = await call({ message: 'find it' }, { durableOperationKey: KEY });

    expect(result).toMatchObject({ taskId: 'task-1', message: 'found it' });
    expect(peer.attaches).toEqual([]);
    expect(peer.sends).toHaveLength(1);
    const messageId = peer.sends[0]?.messageId ?? '';
    expect(messageId).toMatch(/^peer-call:[0-9a-f]{64}$/);
    expect(messageId).not.toContain('run-1');
    expect([...journal.entries.values()]).toEqual([
      {
        taskId: 'task-1',
        contextId: 'context-1',
        requestDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    ]);
  });

  it('derives a different message id for a different operation key', async () => {
    const peer = fakePeer();
    const { call } = toolOver(peer.client, memoryJournal());

    await call({ message: 'a' }, { durableOperationKey: KEY });
    await call({ message: 'a' }, { durableOperationKey: `${KEY}-other` });

    expect(peer.sends[0]?.messageId).not.toBe(peer.sends[1]?.messageId);
  });

  it('after a restart attaches to the recorded task and sends nothing', async () => {
    const journal = memoryJournal();
    await toolOver(fakePeer().client, journal).call(
      { message: 'find it' },
      { durableOperationKey: KEY },
    );

    // A new process: a new tool and a new client over the same journal.
    const restarted = fakePeer();
    const result = await toolOver(restarted.client, journal).call(
      { message: 'find it' },
      { durableOperationKey: KEY },
    );

    expect(result).toMatchObject({ taskId: 'task-1', message: 'found it' });
    expect(restarted.sends).toEqual([]);
    expect(restarted.attaches).toHaveLength(1);
    expect(restarted.attaches[0]).toMatchObject({ taskId: 'task-1', contextId: 'context-1' });
  });

  it('resends with the same message id when the crash came before the record was written', async () => {
    // The first process sent, then died inside `write`: the journal holds nothing.
    const first = fakePeer();
    const hanging: PeerCallJournal = {
      read: async () => undefined,
      write: () => new Promise<never>(() => {}),
    };
    void toolOver(first.client, hanging).call({ message: 'find it' }, { durableOperationKey: KEY });
    await waitUntil(() => first.sends.length >= 1, { message: 'the first process to send' });

    const restarted = fakePeer();
    await toolOver(restarted.client, memoryJournal()).call(
      { message: 'find it' },
      { durableOperationKey: KEY },
    );

    expect(first.sends).toHaveLength(1);
    expect(restarted.attaches).toEqual([]);
    expect(restarted.sends[0]?.messageId).toBe(first.sends[0]?.messageId);
  });

  it('cancels the task and fails the call when the record cannot be written', async () => {
    const peer = fakePeer();
    const failure = new Error('disk full');
    const { call, registry } = toolOver(peer.client, memoryJournal({ write: failure }));

    const error = await rejection(call({ message: 'find it' }, { durableOperationKey: KEY }));

    expect(error).toBeInstanceOf(PeerCallJournalError);
    expect((error as PeerCallJournalError).cause).toBe(failure);
    expect((error as PeerCallJournalError).taskId).toBe('task-1');
    expect(peer.cancels).toHaveLength(1);
    expect(registry.children()[0]?.status).toBe('failed');
  });

  it('sends nothing when the journal cannot be read', async () => {
    const peer = fakePeer();
    const failure = new Error('unreadable');
    const { call, registry } = toolOver(peer.client, memoryJournal({ read: failure }));

    expect(await rejection(call({ message: 'find it' }, { durableOperationKey: KEY }))).toBe(
      failure,
    );

    expect(peer.sends).toEqual([]);
    expect(peer.attaches).toEqual([]);
    expect(registry.children()).toEqual([]);
  });

  it('refuses to follow a task recorded for a different request at the same position', async () => {
    // Two parallel calls to one peer tool, then a crash. The replayed step emits them in swapped
    // order, so each position now holds the other call's request.
    const journal = memoryJournal();
    const first = fakePeer({ taskId: 'task-for-a' });
    await toolOver(first.client, journal).call(
      { message: 'question A' },
      { durableOperationKey: `${KEY}-0` },
    );
    await toolOver(fakePeer({ taskId: 'task-for-b' }).client, journal).call(
      { message: 'question B' },
      { durableOperationKey: `${KEY}-1` },
    );
    const restarted = fakePeer();

    const swapped = toolOver(restarted.client, journal);
    const atZero = await rejection(
      swapped.call({ message: 'question B' }, { durableOperationKey: `${KEY}-0` }),
    );
    const atOne = await rejection(
      swapped.call({ message: 'question A' }, { durableOperationKey: `${KEY}-1` }),
    );

    expect(atZero).toBeInstanceOf(PeerCallMismatchError);
    expect((atZero as PeerCallMismatchError).recordedTaskId).toBe('task-for-a');
    expect((atOne as PeerCallMismatchError).recordedTaskId).toBe('task-for-b');
    expect(restarted.attaches).toEqual([]);
    expect(restarted.sends).toEqual([]);
    expect(swapped.registry.children()).toEqual([]);
    expect(journal.entries.size).toBe(2);
  });

  it.each([
    ['a different task id', { message: 'q', taskId: 'other-task' }],
    ['a different context id', { message: 'q', contextId: 'other-context' }],
  ])('treats %s as a different request', async (_label, replayed) => {
    const journal = memoryJournal();
    await toolOver(fakePeer().client, journal).call({ message: 'q' }, { durableOperationKey: KEY });
    const restarted = fakePeer();

    const error = await rejection(
      toolOver(restarted.client, journal).call(replayed, { durableOperationKey: KEY }),
    );

    expect(error).toBeInstanceOf(PeerCallMismatchError);
    expect(restarted.attaches).toEqual([]);
  });

  it('fails when the peer forgot the recorded task, and does not send again', async () => {
    const journal = memoryJournal();
    await toolOver(fakePeer().client, journal).call(
      { message: 'find it' },
      { durableOperationKey: KEY },
    );
    const forgetful = fakePeer({ attachError: new A2APeerError('task-not-found', 'no such task') });
    const { call, registry } = toolOver(forgetful.client, journal);

    const error = await rejection(call({ message: 'find it' }, { durableOperationKey: KEY }));

    expect(error).toMatchObject({ code: 'task-not-found' });
    expect(forgetful.sends).toEqual([]);
    expect(registry.children()[0]?.status).toBe('failed');
    expect(journal.entries.size).toBe(1);
  });

  it('hands the attach the call’s abort signal, so aborting a replay reaches the peer', async () => {
    const journal = memoryJournal();
    await toolOver(fakePeer().client, journal).call(
      { message: 'find it' },
      { durableOperationKey: KEY },
    );
    const restarted = fakePeer();
    const controller = new AbortController();
    controller.abort('stop');
    const { call } = toolOver(restarted.client, journal);

    await call(
      { message: 'find it' },
      { durableOperationKey: KEY, signal: controller.signal },
    ).catch(() => undefined);

    expect(restarted.attaches[0]?.signal?.aborted).toBe(true);
  });

  it('does not journal a call without an operation key, or without a parent run', async () => {
    const peer = fakePeer();
    const journal = memoryJournal();
    const { call } = toolOver(peer.client, journal);
    await call({ message: 'find it' });

    const bare = createPeerCallTool({
      name: 'ask',
      description: 'Ask.',
      peer: peer.client,
      durable: journal,
    });
    await (
      bare as unknown as { rawExecute: (p: unknown, c: unknown) => Promise<unknown> }
    ).rawExecute({ message: 'find it' }, { durableOperationKey: KEY });

    expect(peer.sends.map((send) => send.messageId)).toEqual([undefined, undefined]);
    expect(journal.entries.size).toBe(0);
  });

  it('records nothing for a peer that answered with a bare message', async () => {
    const peer = fakePeer({ taskId: '' });
    const journal = memoryJournal();
    const { call } = toolOver(peer.client, journal);

    await call({ message: 'find it' }, { durableOperationKey: KEY });

    expect(journal.entries.size).toBe(0);
    expect(peer.cancels).toEqual([]);
  });

  it('takes the run from the execution context when there is one', async () => {
    const peer = fakePeer();
    const journal = memoryJournal();
    const tool = createPeerCallTool({
      name: 'ask',
      description: 'Ask.',
      peer: peer.client,
      durable: journal,
    });

    await (
      tool as unknown as { rawExecute: (p: unknown, c: unknown) => Promise<unknown> }
    ).rawExecute(
      { message: 'find it' },
      { durableOperationKey: KEY, executionContext: { parentRunId: 'run-9' } },
    );

    expect([...journal.entries.keys()]).toEqual([JSON.stringify(['run-9', KEY])]);
  });
});

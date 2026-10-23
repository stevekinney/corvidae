import { CompletableEventTarget } from '@lostgradient/lifecycle';
import type {
  A2APeerCard,
  A2APeerClient,
  A2APeerOutcome,
  A2APeerSendRequest,
  A2APeerStopState,
  A2APeerTask,
} from '@lostgradient/weft/a2a';
import { describe, expect, it } from 'bun:test';

import { createChildRunRegistry } from './child-run';
import {
  createPeerCallTool,
  PeerAuthRequiredError,
  PeerInputRequiredError,
  PeerTaskError,
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

function outcome(state: A2APeerStopState, extra: Partial<A2APeerOutcome> = {}): A2APeerOutcome {
  return {
    untrusted: true,
    state,
    taskId: 'task-1',
    contextId: 'context-1',
    provenance: {
      agentName: CARD.name,
      agentVersion: CARD.version,
      cardUrl: CARD.cardUrl,
      taskId: 'task-1',
    },
    message: `peer says ${state}`,
    artifacts: [],
    ...extra,
  };
}

interface FakePeer {
  readonly client: A2APeerClient;
  readonly requests: A2APeerSendRequest[];
  readonly cancels: (string | undefined)[];
  /** Resolves the pending `result()` with `value`. */
  finish(value: A2APeerOutcome): void;
}

/** A peer whose task stays `working` until the test finishes it or the send signal aborts. */
function fakePeer(
  options: { immediate?: A2APeerOutcome; cancelConfirms?: boolean } = {},
): FakePeer {
  const requests: A2APeerSendRequest[] = [];
  const cancels: (string | undefined)[] = [];
  let finish!: (value: A2APeerOutcome) => void;
  const done = new Promise<A2APeerOutcome>((resolve) => (finish = resolve));
  const client: A2APeerClient = {
    card: async () => CARD,
    send: async (request) => {
      requests.push(request);
      request.onUpdate?.({
        state: 'working',
        taskId: 'task-1',
        contextId: 'context-1',
        message: '',
      });
      const cancel = async (reason?: string): Promise<A2APeerOutcome> => {
        cancels.push(reason);
        const canceled = outcome('canceled', { cancelConfirmed: options.cancelConfirms ?? true });
        finish(canceled);
        return canceled;
      };
      const onAbort = (): void =>
        void cancel(typeof request.signal?.reason === 'string' ? request.signal.reason : undefined);
      if (request.signal?.aborted === true) onAbort();
      else request.signal?.addEventListener('abort', onAbort, { once: true });
      if (options.immediate !== undefined) {
        request.onUpdate?.({
          state: options.immediate.state,
          taskId: 'task-1',
          contextId: 'context-1',
          message: options.immediate.message,
        });
      }
      const task: A2APeerTask = {
        taskId: 'task-1',
        contextId: 'context-1',
        provenance: outcome('completed').provenance,
        state: () => 'working',
        result: () => (options.immediate === undefined ? done : Promise.resolve(options.immediate)),
        cancel,
      };
      return task;
    },
  };
  return { client, requests, cancels, finish };
}

function setup(peer: FakePeer) {
  const registry = createChildRunRegistry();
  const emitter = new CompletableEventTarget<CombinedOperativeEventMap>();
  const events: string[] = [];
  for (const type of [
    'multiagent.child-workflow.started',
    'multiagent.child-workflow.completed',
    'multiagent.child-workflow.failed',
    'multiagent.child-workflow.aborted',
  ] as const) {
    emitter.addEventListener(type, () => events.push(type.split('.').at(-1) ?? type));
  }
  const tool = createPeerCallTool({
    name: 'ask_researcher',
    description: 'Ask the researcher agent.',
    peer: peer.client,
    parentContext: { emitter, parentAgentName: 'orchestrator', parentRunId: 'run-1', registry },
  });
  const call = (params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> =>
    (tool as unknown as { rawExecute: (p: unknown, c: unknown) => Promise<unknown> }).rawExecute(
      params,
      { signal },
    );
  return { registry, events, call };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the promise to reject');
}

describe('createPeerCallTool', () => {
  it('keeps the remote task visible on the child and returns untrusted, attributed output', async () => {
    const peer = fakePeer();
    const { registry, events, call } = setup(peer);

    const pending = call({ message: 'find it' });
    await Promise.resolve();
    await Promise.resolve();
    const [running] = registry.children();
    expect(running).toMatchObject({
      status: 'running',
      parentId: 'run-1',
      durable: false,
      remote: { protocol: 'a2a', peerName: 'Researcher', taskId: 'task-1', state: 'working' },
    });

    peer.finish(outcome('completed', { message: 'found it' }));
    expect(await pending).toMatchObject({
      untrusted: true,
      message: 'found it',
      taskId: 'task-1',
      provenance: { agentName: 'Researcher', agentVersion: '2.0.0' },
    });
    expect(registry.children()[0]?.status).toBe('completed');
    expect(events).toEqual(['started', 'completed']);
  });

  it('aborting the call cancels the remote task and ends the child aborted', async () => {
    const peer = fakePeer();
    const { registry, events, call } = setup(peer);
    const controller = new AbortController();

    const pending = rejection(call({ message: 'find it' }, controller.signal));
    await Promise.resolve();
    controller.abort('stop');

    expect(await pending).toMatchObject({ name: 'AbortError' });
    expect(peer.cancels).toEqual(['stop']);
    expect(registry.children()[0]?.status).toBe('aborted');
    expect(events).toEqual(['started', 'aborted']);
  });

  it('abortChild cancels the remote task too', async () => {
    const peer = fakePeer();
    const { registry, call } = setup(peer);

    const pending = rejection(call({ message: 'find it' }));
    await Promise.resolve();
    await Promise.resolve();
    registry.abortChild(registry.children()[0]?.id ?? '', 'operator');

    await pending;
    expect(peer.cancels).toEqual(['operator']);
    expect(registry.children()[0]?.status).toBe('aborted');
  });

  it('ends the child aborted even when the peer does not confirm the cancel', async () => {
    const peer = fakePeer({ cancelConfirms: false });
    const { registry, call } = setup(peer);
    const controller = new AbortController();

    const pending = rejection(call({ message: 'find it' }, controller.signal));
    await Promise.resolve();
    controller.abort('stop');
    await pending;

    expect(registry.children()[0]?.status).toBe('aborted');
  });

  it.each([
    ['failed', PeerTaskError],
    ['rejected', PeerTaskError],
    ['input-required', PeerInputRequiredError],
    ['auth-required', PeerAuthRequiredError],
  ] as const)('maps a %s peer task to its own error', async (state, errorClass) => {
    const peer = fakePeer({ immediate: outcome(state) });
    const { registry, events, call } = setup(peer);

    const error = await rejection(call({ message: 'find it' }));

    expect(error).toBeInstanceOf(errorClass);
    expect(error).toMatchObject({
      details: { taskId: 'task-1', peerMessage: `peer says ${state}` },
    });
    const [child] = registry.children();
    expect(child).toMatchObject({ status: 'failed', remote: { state } });
    expect(events).toEqual(['started', 'failed']);
  });

  it('continues an existing peer task when given its id', async () => {
    const peer = fakePeer({ immediate: outcome('completed') });
    const { call } = setup(peer);

    await call({ message: 'the blue one', taskId: 'task-1', contextId: 'context-1' });

    expect(peer.requests[0]).toMatchObject({ taskId: 'task-1', contextId: 'context-1' });
  });

  it('does not start a child when the peer cannot be called', async () => {
    const refusal = new Error('card refused');
    const registry = createChildRunRegistry();
    const tool = createPeerCallTool({
      name: 'ask',
      description: 'Ask.',
      peer: {
        card: async () => Promise.reject(refusal),
        send: async () => Promise.reject(refusal),
      },
      parentContext: {
        emitter: new CompletableEventTarget<CombinedOperativeEventMap>(),
        parentAgentName: 'o',
        parentRunId: 'r',
        registry,
      },
    });

    const error = await rejection(
      (tool as unknown as { rawExecute: (p: unknown, c: unknown) => Promise<unknown> }).rawExecute(
        { message: 'hi' },
        {},
      ),
    );

    expect(error).toBe(refusal);
    expect(registry.children()).toHaveLength(0);
  });
});

/**
 * COR-2097 — the four `multiagent.child-workflow.*` kinds and `multiagent.handoff.occurred` reach
 * the feed from what a run records, once each, carrying identifiers and a finish reason from a
 * closed list, and no prompt, no rejection message and no abort reason.
 *
 * A child dispatched through `bureau.children` is announced on its parent's run, which is on the
 * store, so it reaches the feed through the store's action stream. A child, a goal attempt or a
 * workflow step that dispatches a child through a tool raises the event on its own emitter, which
 * the observer reads (`recorded-run-events.test.ts`).
 */
import { createAgent, type GenerateFunction, stopWhen } from '@lostgradient/operative';
import { MemoryStorage } from '@lostgradient/storage';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { afterEach, describe, expect, it } from 'bun:test';

import type { AgentDefinitions } from './agent-catalog';
import type { Bureau } from './bureau-types/facade';
import { createBureau } from './create-bureau';

const CANARY = 'CANARY-2097-CHILD-81c4';

const parked: GenerateFunction = ({ signal }) =>
  new Promise((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(new Error(`aborted ${CANARY}`)), { once: true });
  });
const answers: GenerateFunction = async () => ({ content: 'done', toolCalls: [] });
const fails: GenerateFunction = async () => {
  throw new Error(`the provider failed: ${CANARY}`);
};

const bureaus: Bureau[] = [];
afterEach(async () => {
  for (const bureau of bureaus.splice(0)) await bureau.dispose();
});

async function open(child: GenerateFunction) {
  const bureau = await createBureau<AgentDefinitions>({
    agents: {
      planner: createAgent({ name: 'planner', generate: parked, stopWhen: stopWhen.noToolCalls() }),
      worker: createAgent({ name: 'worker', generate: child, stopWhen: stopWhen.noToolCalls() }),
    },
    storage: new MemoryStorage(),
    onDiagnostic: () => undefined,
  });
  bureaus.push(bureau);
  const parent = await bureau.tasks.start('planner', `plan ${CANARY}`, { principal: 'alice' });
  return { bureau, parent };
}

interface Envelope {
  readonly kind: string;
  readonly payload: Record<string, unknown>;
}

async function childEvents(bureau: Bureau): Promise<Envelope[]> {
  await bureau.internals.taskRegistry.flush();
  const found: Envelope[] = [];
  for await (const envelope of bureau.internals.eventFeed.feed.replay()) {
    const entry = envelope as unknown as Envelope;
    if (entry.kind.startsWith('multiagent.')) found.push(entry);
  }
  return found;
}

async function eventsOfKind(bureau: Bureau, kind: string): Promise<Envelope[]> {
  const events = await childEvents(bureau);
  return events.filter((entry) => entry.kind === kind);
}

async function untilKind(bureau: Bureau, kind: string): Promise<void> {
  await waitUntil(
    async () => {
      const found = await eventsOfKind(bureau, kind);
      return found.length > 0;
    },
    { message: `${kind} is on the feed` },
  );
}

const CHILD = (parentRunId: string) => ({
  parentRunId,
  childRunId: 'child-1',
  childAgentName: 'worker',
});

describe('a child run on the feed (COR-2097)', () => {
  it('publishes started and completed once each, naming the parent, the child and its agent', async () => {
    const { bureau, parent } = await open(answers);
    const dispatched = await bureau.children.dispatch({
      parentRunId: parent.id,
      agentName: 'worker',
      input: `the prompt ${CANARY}`,
      principal: 'alice',
      childRunId: 'child-1',
    });
    expect(dispatched).toMatchObject({ outcome: 'started' });
    await untilKind(bureau, 'multiagent.child-workflow.completed');

    const events = await childEvents(bureau);
    expect(events.map((entry) => entry.kind)).toEqual([
      'multiagent.child-workflow.started',
      'multiagent.child-workflow.completed',
    ]);
    for (const entry of events) expect(entry.payload).toEqual(CHILD(parent.id));
    expect(JSON.stringify(events)).not.toContain(CANARY);
  });

  it('publishes failed once with the finish reason `error`, never the child’s error text', async () => {
    const { bureau, parent } = await open(fails);
    await bureau.children.dispatch({
      parentRunId: parent.id,
      agentName: 'worker',
      input: 'go',
      principal: 'alice',
      childRunId: 'child-1',
    });
    await untilKind(bureau, 'multiagent.child-workflow.failed');

    const events = await childEvents(bureau);
    expect(events.map((entry) => entry.kind)).toEqual([
      'multiagent.child-workflow.started',
      'multiagent.child-workflow.failed',
    ]);
    expect(events[1]?.payload).toEqual({ ...CHILD(parent.id), finishReason: 'error' });
    expect(JSON.stringify(events)).not.toContain(CANARY);
  });

  it('publishes aborted once for a cancelled child, never the reason it was cancelled with', async () => {
    const { bureau, parent } = await open(parked);
    await bureau.children.dispatch({
      parentRunId: parent.id,
      agentName: 'worker',
      input: 'go',
      principal: 'alice',
      childRunId: 'child-1',
    });
    await untilKind(bureau, 'multiagent.child-workflow.started');
    await bureau.children.cancel({
      parentRunId: parent.id,
      childRunId: 'child-1',
      principal: 'alice',
      reason: `stop ${CANARY}`,
    });
    await untilKind(bureau, 'multiagent.child-workflow.aborted');

    const events = await childEvents(bureau);
    expect(events.map((entry) => entry.kind)).toEqual([
      'multiagent.child-workflow.started',
      'multiagent.child-workflow.aborted',
    ]);
    expect(events[1]?.payload).toEqual(CHILD(parent.id));
    expect(JSON.stringify(events)).not.toContain(CANARY);
  });

  it('publishes a child dispatched under another child, which is not on the run store, with that child as its parent', async () => {
    const { bureau, parent } = await open(parked);
    await bureau.children.dispatch({
      parentRunId: parent.id,
      agentName: 'worker',
      input: 'go',
      principal: 'alice',
      childRunId: 'child-1',
    });
    expect(bureau.internals.store.getRun('child-1')).toBeUndefined();
    const nested = await bureau.children.dispatch({
      parentRunId: 'child-1',
      agentName: 'worker',
      input: `go ${CANARY}`,
      principal: 'alice',
      childRunId: 'child-2',
    });
    expect(nested).toMatchObject({ outcome: 'started' });
    await waitUntil(
      async () => {
        const started = await eventsOfKind(bureau, 'multiagent.child-workflow.started');
        return started.length === 2;
      },
      { message: 'both children are announced' },
    );

    const started = await eventsOfKind(bureau, 'multiagent.child-workflow.started');
    expect(started.map((entry) => entry.payload)).toEqual([
      { parentRunId: parent.id, childRunId: 'child-1', childAgentName: 'worker' },
      { parentRunId: 'child-1', childRunId: 'child-2', childAgentName: 'worker' },
    ]);
    expect(JSON.stringify(started)).not.toContain(CANARY);
  });

  it('names the run the event was recorded on as the parent, whatever the event itself carries', async () => {
    const { bureau, parent } = await open(answers);
    bureau.internals.store.recordAction(parent.id, 'multiagent.child-workflow.started', {
      parentAgentName: 'planner',
      parentRunId: 'a-run-the-tool-invented',
      childAgentName: 'worker',
      childRunId: 'child-9',
      input: `the prompt ${CANARY}`,
      durable: false,
    });
    await untilKind(bureau, 'multiagent.child-workflow.started');

    const [event] = await childEvents(bureau);
    expect(event?.payload).toEqual({
      parentRunId: parent.id,
      childRunId: 'child-9',
      childAgentName: 'worker',
    });
  });

  it.each([
    ['error', 'error'],
    ['tripwire', 'tripwire'],
    ['maximum-steps', 'maximum-steps'],
    ['budget-exceeded', 'budget-exceeded'],
    ['elicitation-denied', 'elicitation-denied'],
    [`provider said no ${CANARY}`, 'error'],
    ['', 'error'],
  ])('publishes a child’s recorded reason %j as the finish reason %j', async (reason, expected) => {
    const { bureau, parent } = await open(answers);
    bureau.internals.store.recordAction(parent.id, 'multiagent.child-workflow.failed', {
      parentAgentName: 'planner',
      parentRunId: parent.id,
      childAgentName: 'worker',
      childRunId: 'child-2',
      reason,
    });
    await untilKind(bureau, 'multiagent.child-workflow.failed');

    const [event] = await childEvents(bureau);
    expect(event?.payload).toEqual({
      parentRunId: parent.id,
      childRunId: 'child-2',
      childAgentName: 'worker',
      finishReason: expected,
    });
    expect(JSON.stringify(event)).not.toContain(CANARY);
  });
});

describe('a handoff on the feed (COR-2097)', () => {
  it('publishes the run and the two agents, once, and never the session', async () => {
    const { bureau, parent } = await open(answers);
    bureau.internals.store.recordAction(parent.id, 'multiagent.handoff.occurred', {
      sourceAgentName: 'planner',
      targetAgentName: 'worker',
      sessionId: `session-${CANARY}`,
    });
    await untilKind(bureau, 'multiagent.handoff.occurred');

    const handoffs = await eventsOfKind(bureau, 'multiagent.handoff.occurred');
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]?.payload).toEqual({
      runId: parent.id,
      sourceAgentName: 'planner',
      targetAgentName: 'worker',
    });
    expect(JSON.stringify(handoffs)).not.toContain(CANARY);
  });
});

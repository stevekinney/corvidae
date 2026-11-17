/**
 * COR-2097, with COR-2095 Revision 2026-11-16 — a pushed event carries no free text. A canary is
 * planted in every free-text input that reaches the code these kinds publish from: a child's
 * prompt, its error message and the reason it was cancelled with, a hook's error message and cause,
 * a steering command's requested value, and a goal validator's feedback and evidence. It appears in
 * no envelope the feed holds, in no body a hook's webhook receives, and in no delivery record the
 * Bureau keeps, while the events themselves were published (the receiver got each kind).
 */
import { HookRegistry } from '@lostgradient/lifecycle';
import {
  createAgent,
  type GenerateFunction,
  type OperativeHookMap,
  stopWhen,
  type Validator,
} from '@lostgradient/operative';
import { MemoryStorage } from '@lostgradient/storage';
import { quietFor, waitUntil } from '@lostgradient/testing/wait-until';
import { afterEach, describe, expect, it } from 'bun:test';

import type { AgentDefinitions } from './agent-catalog';
import type { Bureau } from './bureau-types/facade';
import { createBureau } from './create-bureau';
import { createReceiver, deliveriesOf, newEncryptionKey } from './hooks/hooks.test-support';
import { goalRequest, scriptedGenerate, workerAgent } from './testing/goal-fixtures.test-support';

const CANARY = {
  prompt: 'CANARY-PROMPT-2f6a',
  childError: 'CANARY-CHILD-ERROR-b310',
  cancelReason: 'CANARY-CANCEL-REASON-77d2',
  hookMessage: 'CANARY-HOOK-MESSAGE-0c9e',
  hookCause: 'CANARY-HOOK-CAUSE-a54b',
  steering: 'CANARY-STEERING-VALUE-e8f1',
  feedback: 'CANARY-FEEDBACK-31ad',
  evidence: 'CANARY-EVIDENCE-96c0',
} as const;
const CANARIES = Object.values(CANARY);

const KINDS = [
  'multiagent.child-workflow.started',
  'multiagent.child-workflow.completed',
  'multiagent.child-workflow.failed',
  'multiagent.child-workflow.aborted',
  'multiagent.handoff.occurred',
  'steering.applied',
  'steering.rejected',
  'steering.superseded',
  'steering.failed',
  'goal.feedback.recorded',
  'goal.retrying',
  'hook-plan.failed',
  'workflow.version-mismatch',
];

const parked: GenerateFunction = ({ signal }) =>
  new Promise((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(new Error(CANARY.cancelReason)), {
      once: true,
    });
  });
const failsWithCanary: GenerateFunction = async () => {
  throw new Error(`provider failed ${CANARY.childError}`, {
    cause: new Error(`inner ${CANARY.childError}`),
  });
};

/** A validator whose feedback and evidence both carry text a model wrote. */
const canaryValidator: Validator = {
  identity: { name: 'check', version: '1' },
  determinism: 'deterministic',
  async validate(input) {
    return input.result.content.includes('done')
      ? { kind: 'pass', evidence: [{ source: 'check', detail: { content: 'ok' } }] }
      : {
          kind: 'fail',
          feedback: `fix it: ${CANARY.feedback}`,
          evidence: [{ source: 'check', detail: CANARY.evidence }],
          retryable: true,
        };
  },
};

function hookedWorker() {
  const hooks = new HookRegistry<OperativeHookMap>({ source: 'agent', onError: () => 'continue' });
  hooks.on(
    'onStep',
    async () => {
      throw new Error(`hook failed ${CANARY.hookMessage}`, {
        cause: new Error(`inner ${CANARY.hookCause}`),
      });
    },
    { id: 'agent:boom', replay: 'safe' },
  );
  return createAgent({
    name: 'worker',
    generate: async () => ({ content: 'done', toolCalls: [] }),
    stopWhen: stopWhen.noToolCalls(),
    hooks,
  });
}

const bureaus: Bureau[] = [];
afterEach(async () => {
  for (const bureau of bureaus.splice(0)) await bureau.dispose();
});

async function open(agents: AgentDefinitions, goals = false) {
  const receiver = createReceiver();
  const bureau = await createBureau<AgentDefinitions>({
    id: 'canary-bureau',
    agents,
    storage: new MemoryStorage(),
    ...(goals ? { durable: true, validators: [canaryValidator] } : {}),
    answerEncryption: { current: await newEncryptionKey() },
    onDiagnostic: () => undefined,
    hooks: {},
    webhooks: { targets: [], fetch: receiver.fetch, sleep: () => Promise.resolve() },
  });
  bureaus.push(bureau);
  const hook = await bureau.hooks!.create({
    action: { type: 'webhook', url: 'https://receiver.example/canary' },
    events: [...KINDS, 'run.settled'],
  });
  return { bureau, receiver, hook };
}

interface Envelope {
  readonly kind: string;
  readonly payload: Record<string, unknown>;
}

async function everyEnvelope(bureau: Bureau): Promise<Envelope[]> {
  await bureau.internals.taskRegistry.flush();
  const found: Envelope[] = [];
  for await (const envelope of bureau.internals.eventFeed.feed.replay()) {
    found.push(envelope);
  }
  return found;
}

/** Waits for the hook to have delivered everything it is going to, then reads all three places. */
async function settled(
  bureau: Bureau,
  receiver: ReturnType<typeof createReceiver>,
  hookId: string,
) {
  await waitUntil(
    async () => {
      const deliveries = await deliveriesOf(bureau, hookId);
      return deliveries.length > 0 && deliveries.every((delivery) => delivery.status !== 'pending');
    },
    { message: 'the hook delivered what it was sent' },
  );
  await quietFor(50);
  return {
    feed: JSON.stringify(await everyEnvelope(bureau)),
    sent: receiver.calls.map((call) => call.body).join('\n'),
    kept: JSON.stringify(await deliveriesOf(bureau, hookId)),
    kinds: new Set(receiver.calls.map((call) => (JSON.parse(call.body) as Envelope).kind)),
  };
}

function expectNoCanary(where: Record<string, string>) {
  for (const [place, text] of Object.entries(where)) {
    for (const canary of CANARIES) {
      expect(`${place}: ${text.includes(canary)}`).toBe(`${place}: false`);
    }
  }
}

describe('what a child, a hook and a steering command publish carries no free text (COR-2097)', () => {
  it('holds for a child that fails, a child that is cancelled, a failed hook and a refused command', async () => {
    const { bureau, receiver, hook } = await open({
      planner: createAgent({ name: 'planner', generate: parked, stopWhen: stopWhen.noToolCalls() }),
      failing: createAgent({
        name: 'failing',
        generate: failsWithCanary,
        stopWhen: stopWhen.noToolCalls(),
      }),
      hung: createAgent({ name: 'hung', generate: parked, stopWhen: stopWhen.noToolCalls() }),
      worker: hookedWorker(),
    });
    const parent = await bureau.tasks.start('planner', `plan ${CANARY.prompt}`, {
      principal: 'alice',
    });

    await bureau.children.dispatch({
      parentRunId: parent.id,
      agentName: 'failing',
      input: `go ${CANARY.prompt}`,
      principal: 'alice',
      childRunId: 'child-failing',
    });
    await bureau.children.dispatch({
      parentRunId: parent.id,
      agentName: 'hung',
      input: `go ${CANARY.prompt}`,
      principal: 'alice',
      childRunId: 'child-hung',
    });
    await waitUntil(
      async () => {
        const task = await bureau.tasks.get('child-failing');
        return task?.status === 'failed';
      },
      { message: 'the child failed' },
    );
    await bureau.children.cancel({
      parentRunId: parent.id,
      childRunId: 'child-hung',
      principal: 'alice',
      reason: `stop ${CANARY.cancelReason}`,
    });
    // A hook of a worker run throws a message and a cause.
    const worker = await bureau.tasks.start('worker', 'go', { principal: 'alice' });
    await waitUntil(
      async () => {
        const task = await bureau.tasks.get(worker.id);
        return task?.status === 'completed';
      },
      { message: 'the worker run completed' },
    );
    // A steering command whose requested value is text, refused before the gate.
    const refused = await bureau.contexts.steer(parent.contextId, {
      id: 'refused',
      principal: 'alice',
      requestedValue: { target: 'agent-identity', override: CANARY.steering },
    });
    expect(refused.outcome).toBe('rejected');

    const seen = await settled(bureau, receiver, hook.id);

    for (const kind of [
      'multiagent.child-workflow.started',
      'multiagent.child-workflow.failed',
      'multiagent.child-workflow.aborted',
      'hook-plan.failed',
      'steering.rejected',
    ]) {
      expect(`${kind}: ${seen.kinds.has(kind)}`).toBe(`${kind}: true`);
    }
    expectNoCanary({ feed: seen.feed, webhook: seen.sent, deliveries: seen.kept });
    // The text is where an authorized reader finds it: the hook's error, on the audit record.
    const audited = await bureau.internals.auditTrail!.query({ runId: worker.id });
    expect(JSON.stringify(audited)).toContain(CANARY.hookMessage);
  });

  it('holds for a goal whose validator fails with feedback and evidence', async () => {
    const { bureau, receiver, hook } = await open(
      { worker: workerAgent(scriptedGenerate(['no', 'done'])) },
      true,
    );
    await bureau.goals.create(goalRequest({ goalRunId: 'g1', prompt: `work ${CANARY.prompt}` }));
    await waitUntil(
      async () => {
        const goal = await bureau.goals.get('g1');
        return goal?.status === 'succeeded';
      },
      { message: 'the goal succeeded after one retry' },
    );

    const seen = await settled(bureau, receiver, hook.id);

    expect(seen.kinds.has('goal.feedback.recorded')).toBe(true);
    expect(seen.kinds.has('goal.retrying')).toBe(true);
    expectNoCanary({ feed: seen.feed, webhook: seen.sent, deliveries: seen.kept });
  });
});

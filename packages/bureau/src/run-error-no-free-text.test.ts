/**
 * COR-2095, Revision 2026-11-16 — a pushed event carries no free error text. A canary is planted in
 * a failed run's error message, in a nested cause's message, and as a malformed `code` and a
 * malformed `kind` (free text with spaces), and it appears in no envelope the feed holds and in no
 * body a hook's webhook receives, on the in-process, durable and goal-attempt paths. `run.error`
 * carries at most `runId`, `finishReason`, `step`, `errorKind` and `errorCode`.
 *
 * The `action` envelope is checked with the rest, not exempted: its projection carries only the
 * log entry's shape (`sequence`, `runId`, `actionType`, `timestamp`), so a failed run's raw error
 * is never in it (`bureau-event-feed.ts`, the `ActionEvent` projection).
 */
import {
  AgentRunError,
  createAgent,
  type GenerateFunction,
  stopWhen,
} from '@lostgradient/operative';
import { MemoryStorage } from '@lostgradient/storage';
import { quietFor, waitUntil } from '@lostgradient/testing/wait-until';
import { afterEach, describe, expect, it } from 'bun:test';

import type { AgentDefinitions } from './agent-catalog';
import type { Bureau } from './bureau-types/facade';
import { createBureau } from './create-bureau';
import { createReceiver, deliveriesOf, newEncryptionKey } from './hooks/hooks.test-support';
import {
  createCheckValidator,
  goalRequest,
  workerAgent,
} from './testing/goal-fixtures.test-support';

const CANARY = {
  message: 'CANARY-MESSAGE-7f3a',
  cause: 'CANARY-CAUSE-91bc',
  code: 'CANARY-CODE with spaces 5d2e',
  kind: 'CANARY-KIND with spaces 0a8f',
} as const;
const CANARIES = Object.values(CANARY);

/** What `run.error` may carry. */
const RUN_ERROR_KEYS = ['errorCode', 'errorKind', 'finishReason', 'runId', 'step'];

/** An error whose message, cause, code and kind are all text a hostile or careless provider could write. */
const failsWithCanaries: GenerateFunction = async () => {
  const error = new AgentRunError(`provider failed ${CANARY.message}`, {
    kind: 'generate',
    code: 'UNKNOWN',
    cause: new Error(`inner ${CANARY.cause}`),
  });
  Object.assign(error, { code: CANARY.code, kind: CANARY.kind });
  throw error;
};

interface Envelope {
  readonly kind: string;
  readonly payload: Record<string, unknown>;
}

const bureaus: Bureau<AgentDefinitions>[] = [];
afterEach(async () => {
  for (const bureau of bureaus.splice(0)) await bureau.dispose();
});

/** A Bureau whose hook sends every kind this change publishes to a receiver we read. */
async function open(durable: boolean, goals: boolean) {
  const receiver = createReceiver();
  const bureau = await createBureau<AgentDefinitions>({
    id: 'canary-bureau',
    agents: {
      default: createAgent({
        name: 'default',
        generate: failsWithCanaries,
        stopWhen: stopWhen.noToolCalls(),
      }),
      worker: workerAgent(failsWithCanaries),
    },
    storage: new MemoryStorage(),
    durable,
    ...(durable ? { durableOwnership: { ownership: 'none' as const } } : {}),
    ...(goals ? { validators: [createCheckValidator()] } : {}),
    answerEncryption: { current: await newEncryptionKey() },
    onDiagnostic: () => undefined,
    hooks: {},
    webhooks: { targets: [], fetch: receiver.fetch, sleep: () => Promise.resolve() },
  });
  bureaus.push(bureau);
  const hook = await bureau.hooks!.create({
    action: { type: 'webhook', url: 'https://receiver.example/canary' },
    events: [
      'action',
      'run.registered',
      'run.error',
      'run.settled',
      'run.completed',
      'run.aborted',
      'run.tripwire',
      'tool.error',
    ],
  });
  return { bureau, receiver, hook };
}

async function everyEnvelope(bureau: Bureau): Promise<Envelope[]> {
  await bureau.internals.taskRegistry.flush();
  const found: Envelope[] = [];
  for await (const envelope of bureau.internals.eventFeed.feed.replay()) {
    found.push(envelope);
  }
  return found;
}

const PATHS = [
  ['in process', { durable: false, goals: false }],
  ['durably', { durable: true, goals: false }],
  ['as a goal attempt', { durable: true, goals: true }],
] as const;

describe('a failed run’s pushed events carry no free error text (COR-2095)', () => {
  it.each(PATHS)('%s', async (_name, path) => {
    const { bureau, receiver, hook } = await open(path.durable, path.goals);
    let runId: string;
    if (path.goals) {
      await bureau.goals.create(goalRequest({ goalRunId: 'g1' }));
      runId = 'goal-g1-a0';
    } else {
      const started = await bureau.tasks.start('default', 'go', { principal: 'api-key:alice' });
      runId = started.id;
    }
    await waitUntil(
      async () => {
        const task = await bureau.tasks.get(runId);
        return task?.status === 'failed';
      },
      { message: 'the run failed' },
    );
    await bureau.internals.taskRegistry.flush();
    await waitUntil(
      async () => {
        const deliveries = await deliveriesOf(bureau, hook.id);
        return (
          deliveries.some((delivery) => delivery.kind === 'run.settled') &&
          deliveries.every((delivery) => delivery.status !== 'pending')
        );
      },
      { message: 'the hook delivered the run’s events' },
    );
    await quietFor(50);

    const feed = await everyEnvelope(bureau);
    const failure = feed.find(
      (entry) => entry.kind === 'run.error' && entry.payload['runId'] === runId,
    );
    expect(failure).toBeDefined();
    // At most the five keys, and the malformed code and kind are not among their values.
    for (const key of Object.keys(failure!.payload)) expect(RUN_ERROR_KEYS).toContain(key);
    expect(failure!.payload).toMatchObject({ runId, finishReason: 'error', errorCode: 'UNKNOWN' });
    expect(failure!.payload).not.toHaveProperty('errorKind');
    expect(failure!.payload).not.toHaveProperty('message');

    // No envelope the feed holds, the `action` ones included, carries any canary.
    const published = JSON.stringify(feed);
    for (const canary of CANARIES) expect(published).not.toContain(canary);
    // Nor does any body the hook's webhook received, or any delivery record the Bureau kept.
    expect(receiver.calls.length).toBeGreaterThan(0);
    const sent = receiver.calls.map((call) => call.body).join('\n');
    const kept = JSON.stringify(await deliveriesOf(bureau, hook.id));
    for (const canary of CANARIES) {
      expect(sent).not.toContain(canary);
      expect(kept).not.toContain(canary);
    }
    expect(receiver.calls.map((call) => JSON.parse(call.body).kind)).toContain('run.error');

    // The failed run's `action` envelope is its log entry's shape and nothing more.
    const actions = feed.filter(
      (entry) => entry.kind === 'action' && entry.payload['runId'] === runId,
    );
    // A goal attempt is not on the run store, so its actions never reach the `'action'` stream.
    if (path.goals) {
      expect(actions).toEqual([]);
    } else {
      for (const action of actions) {
        expect(Object.keys(action.payload).toSorted()).toEqual([
          'actionType',
          'runId',
          'sequence',
          'timestamp',
        ]);
      }
      expect(actions.map((action) => action.payload['actionType'])).toContain('run.error');
    }

    // The text is read through the authorized task read, by `runId`.
    const task = await bureau.tasks.get(runId);
    expect(task?.statusMessage).toContain(CANARY.message);
  });
});

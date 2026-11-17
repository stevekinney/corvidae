/**
 * COR-2097 — a goal whose first attempt fails its validator publishes `goal.feedback.recorded` and
 * `goal.retrying` on the Bureau's feed, between the verdict and the next attempt, and neither is in
 * the goal's recorded history. Neither carries the feedback itself.
 */
import { afterEach, describe, expect, it } from 'bun:test';

import type { AgentDefinitions } from './agent-catalog';
import type { Bureau } from './bureau-types/facade';
import { createBureau } from './create-bureau';
import {
  createCheckValidator,
  createTestDatabase,
  createUnsetTestDatabase,
  goalRequest,
  goalStatus,
  pollUntil,
  scriptedGenerate,
  workerAgent,
} from './testing/goal-fixtures.test-support';

const bureaus: Bureau[] = [];
let database = createUnsetTestDatabase();
afterEach(async () => {
  for (const bureau of bureaus.splice(0)) await bureau.dispose();
  await database.remove();
});

interface Envelope {
  readonly kind: string;
  readonly payload: Record<string, unknown>;
}

describe('goal.feedback.recorded and goal.retrying on the feed (COR-2097)', () => {
  it('publishes each once, in order, for a goal that fails once and then passes', async () => {
    database = createTestDatabase('goal-retry-events');
    const bureau = await createBureau<AgentDefinitions>({
      agents: { worker: workerAgent(scriptedGenerate(['no', 'done'])) },
      storage: database.open(),
      durable: true,
      validators: [createCheckValidator()],
      onDiagnostic: () => undefined,
    });
    bureaus.push(bureau);
    await bureau.goals.create(goalRequest({ goalRunId: 'g1' }));
    await pollUntil(async () => (await goalStatus(bureau)) === 'succeeded');
    await bureau.internals.taskRegistry.flush();

    const goalEvents: Envelope[] = [];
    for await (const envelope of bureau.internals.eventFeed.feed.replay()) {
      const entry = envelope as unknown as Envelope;
      if (entry.kind.startsWith('goal.'))
        goalEvents.push({ kind: entry.kind, payload: entry.payload });
    }

    expect(goalEvents.map((entry) => entry.kind)).toEqual([
      'goal.started',
      'goal.attempt.started',
      'goal.attempt.evaluating',
      'goal.attempt.validated',
      'goal.feedback.recorded',
      'goal.retrying',
      'goal.attempt.started',
      'goal.attempt.evaluating',
      'goal.attempt.validated',
      'goal.succeeded',
    ]);
    const validated = goalEvents.find((entry) => entry.kind === 'goal.attempt.validated');
    const feedback = goalEvents.find((entry) => entry.kind === 'goal.feedback.recorded');
    const retrying = goalEvents.find((entry) => entry.kind === 'goal.retrying');
    expect(feedback?.payload).toEqual({
      goalRunId: 'g1',
      attemptId: validated?.payload['attemptId'],
      feedbackDigest: validated?.payload['feedbackDigest'],
    });
    expect(retrying?.payload).toEqual({ goalRunId: 'g1', attemptIndex: 0, retryReason: 'failed' });
    // The validator's feedback was "say done"; only its digest is published.
    expect(JSON.stringify(goalEvents)).not.toContain('say done');

    // Live only: the goal's recorded history has neither.
    const history = await bureau.goals.events('g1');
    if (!('events' in history)) throw new Error(`no history: ${JSON.stringify(history)}`);
    const recorded = history.events.map((event) => event.kind);
    expect(recorded).toContain('goal.attempt.validated');
    expect(recorded).not.toContain('goal.feedback.recorded');
    expect(recorded).not.toContain('goal.retrying');
  });
});

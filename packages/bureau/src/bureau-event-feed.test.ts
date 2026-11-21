import { createDefaultRuntimeServices } from '@lostgradient/lifecycle';
import {
  AgentScheduledEvent,
  createAgent,
  type GenerateFunction,
  type InputDetector,
  stopWhen,
  ScheduleAttemptedEvent,
  ScheduleCancelledEvent,
  ScheduleCompletedEvent,
  ScheduleFailedEvent,
  SchedulePausedEvent,
  ScheduleResumedEvent,
  ScheduleSkippedEvent,
  SessionCreatedEvent,
  SessionDeletedEvent,
  SessionSavedEvent,
  SteeringAcceptedEvent,
} from '@lostgradient/operative';
import { MemoryStorage } from '@lostgradient/storage';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { createTool, createToolbox } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import type { AgentDefinitions } from './agent-catalog.ts';
import type { Bureau } from './bureau-types/facade.ts';
import { createBureau } from './create-bureau.ts';
import { createCheckValidator, goalRequest } from './testing/goal-fixtures.test-support.ts';
import { startWorkflowBureau } from './testing/workflow-bureau.test-support.ts';
import {
  type BureauEventEnvelope,
  createBureauEventFeed,
  projectBureauEvent,
  PUBLISHED_BUREAU_EVENT_KINDS,
  publishedBureauEventKinds,
} from './bureau-event-feed.ts';
import { bureauEventEnvelopeSchema } from './bureau-events-operation.ts';
import { markEventSource } from './event-source.ts';
import { PluginPublishedEvent } from './plugin-published-event.ts';
import {
  ActionEvent,
  AssetLifecycleEvent,
  BureauDisposedEvent,
  DefinitionsChangedEvent,
  DiagnosticEvent,
  GoalLifecycleEvent,
  ScheduleMissedEvent,
  TaskCleanupAcknowledgedEvent,
  RunAbortSettledEvent,
  RecoveryRejectedEvent,
  ReviewApprovedEvent,
  RunRegisteredEvent,
  BudgetThresholdRecordedEvent,
  RunGuardrailRecordedEvent,
  RunTripwireRecordedEvent,
  ToolErrorRecordedEvent,
  ToolPolicyDeniedRecordedEvent,
} from './events.ts';
import {
  SkillActivatedEvent,
  SkillDeactivatedEvent,
  SkillFailedEvent,
  SkillLoadedEvent,
  SkillRejectedEvent,
} from './skills/events.ts';

const CANARY = 'CallerSuppliedDetailCanary';

describe('the source of an event', () => {
  it('is the plugin a contribution marked it with, on the envelope and not in the payload', () => {
    const feed = createBureauEventFeed({ bureauId: 'bureau-1' });
    const envelope = feed.publish(markEventSource(new DiagnosticEvent('warn', 'slack'), 'slack'))!;
    expect(envelope.source).toBe('slack');
    expect(envelope.payload).toEqual({ level: 'warn', scope: 'slack' });
    expect(bureauEventEnvelopeSchema.parse(envelope)).toMatchObject({ source: 'slack' });
  });

  it('is absent, not undefined, on an event from Bureau core', () => {
    const feed = createBureauEventFeed({ bureauId: 'bureau-1' });
    const envelope = feed.publish(new DiagnosticEvent('warn', 'hooks'))!;
    expect(Object.hasOwn(envelope, 'source')).toBe(false);
    expect(Object.hasOwn(bureauEventEnvelopeSchema.parse(envelope) as object, 'source')).toBe(
      false,
    );
  });

  it('is never read from a field of the event itself', () => {
    const feed = createBureauEventFeed({ bureauId: 'bureau-1' });
    const changed = new DefinitionsChangedEvent('agents', {
      added: [],
      changed: [],
      removed: [],
      rejected: [],
    });
    const envelope = feed.publish(changed)!;
    expect(envelope.payload).toMatchObject({ catalog: 'agents' });
    expect(Object.hasOwn(envelope.payload, 'source')).toBe(false);
    expect(Object.hasOwn(envelope, 'source')).toBe(false);
  });

  it('must be a plugin name, and an event cannot be marked as two plugins', () => {
    const event = new DiagnosticEvent('warn', 'slack');
    expect(() => markEventSource(event, 'Not A Plugin')).toThrow(TypeError);
    markEventSource(event, 'slack');
    expect(() => markEventSource(event, 'calendar')).toThrow(TypeError);
    expect(markEventSource(event, 'slack')).toBe(event);
  });
});

describe('a plugin event on the feed (COR-2224)', () => {
  it('replays after a reconnect from the last cursor seen, like a core event', async () => {
    const feed = createBureauEventFeed({ bureauId: 'bureau-1' });
    const first = feed.publish(new RunRegisteredEvent('before'))!;
    feed.publish(
      markEventSource(new PluginPublishedEvent('demo:greeted', { greetingId: 'g-1' }), 'demo'),
    );
    feed.publish(new RunRegisteredEvent('after'));

    const replay: BureauEventEnvelope[] = [];
    for await (const event of feed.feed.replay({ fromCursor: first.cursor })) replay.push(event);

    expect(replay.map(({ kind }) => kind)).toEqual(['demo:greeted', 'run.registered']);
    expect(replay[0]).toMatchObject({
      kind: 'demo:greeted',
      source: 'demo',
      payload: { greetingId: 'g-1' },
    });
    expect(bureauEventEnvelopeSchema.parse(replay[0])).toMatchObject({ kind: 'demo:greeted' });
    feed.dispose();
  });
});

describe('the bureau event feed', () => {
  it('opens a gap when reconnecting with a previous incarnation cursor', async () => {
    const previous = createBureauEventFeed({ bureauId: 'bureau-1' });
    const old = previous.publish(new RunRegisteredEvent('old'))!;
    const current = createBureauEventFeed({ bureauId: 'bureau-1' });
    current.publish(new RunRegisteredEvent('current'));
    const replay: BureauEventEnvelope[] = [];
    for await (const event of current.feed.replay({ fromCursor: old.cursor })) replay.push(event);
    expect(replay[0]).toMatchObject({
      kind: 'feed.gap',
      payload: { requestedCursor: old.cursor, firstRetainedSequence: 0 },
    });
    expect(replay[1]?.kind).toBe('run.registered');
    previous.dispose();
    current.dispose();
  });

  it('numbers envelopes from zero and stamps the bureau', () => {
    const feed = createBureauEventFeed({ bureauId: 'bureau-1', now: () => 500 });

    const first = feed.publish(new RunRegisteredEvent('run-1'));
    const second = feed.publish(new RunRegisteredEvent('run-2'));

    expect(first).toMatchObject({
      sequence: 0,
      bureauId: 'bureau-1',
      kind: 'run.registered',
      emittedAtMs: 500,
    });
    expect(first?.payload).toEqual({ runId: 'run-1' });
    expect(second?.sequence).toBe(1);
    feed.dispose();
  });

  it('stamps each envelope from the default runtime clock when no clock is injected', () => {
    // The `now` option is optional. Without it the feed reads the default
    // runtime services' wall clock, so `emittedAtMs` must lie between two
    // readings of an equivalent clock taken around the publish. A fixed,
    // missing, or non-numeric default fails the bounds.
    const clock = createDefaultRuntimeServices().clock;
    const feed = createBureauEventFeed({ bureauId: 'bureau-1' });

    const before = clock.now();
    const envelope = feed.publish(new RunRegisteredEvent('run-1'));
    const after = clock.now();

    const emittedAtMs = envelope?.emittedAtMs ?? Number.NaN;
    expect(emittedAtMs).toBeGreaterThanOrEqual(before);
    expect(emittedAtMs).toBeLessThanOrEqual(after);
    feed.dispose();
  });

  it('drops an event it has no projection for', () => {
    const feed = createBureauEventFeed({ bureauId: 'bureau-1' });

    expect(feed.publish(new Event('task.routed'))).toBeUndefined();
    // A dropped event consumes no sequence number.
    expect(feed.publish(new BureauDisposedEvent())?.sequence).toBe(0);
    feed.dispose();
  });

  it('carries an action log entry’s shape but never its detail', () => {
    // `Action.detail` is `unknown` and caller-supplied — exactly the field a
    // generic projection would ship without anyone deciding to.
    const event = new ActionEvent({
      sequence: 7,
      runId: 'run-1',
      type: 'tool.invoked',
      detail: { secret: CANARY },
      timestamp: 1234,
    });

    const envelope = createBureauEventFeed({ bureauId: 'bureau-1' }).publish(event);

    expect(envelope?.payload).toEqual({
      sequence: 7,
      runId: 'run-1',
      actionType: 'tool.invoked',
      timestamp: 1234,
    });
    expect(JSON.stringify(envelope)).not.toContain(CANARY);
  });

  it('renames a review’s own kind so it cannot be confused with the envelope’s', () => {
    const event = new ReviewApprovedEvent(
      'review-1',
      'run-1',
      'user@example.test',
      'tool-approval',
    );

    const envelope = createBureauEventFeed({ bureauId: 'bureau-1' }).publish(event);

    // `envelope.kind` is the event type; `payload.reviewKind` is which sort
    // of review settled. Two meanings under one name would be misread.
    expect(envelope?.kind).toBe('review.approved');
    expect(envelope?.payload).toEqual({
      reviewId: 'review-1',
      runId: 'run-1',
      principal: 'user@example.test',
      reviewKind: 'tool-approval',
    });
  });

  it('projects a recovery rejection with its reason', () => {
    const event = new RecoveryRejectedEvent('run-1', 'session-absent');

    const envelope = createBureauEventFeed({ bureauId: 'bureau-1' }).publish(event);

    expect(envelope?.payload).toEqual({ runId: 'run-1', reason: 'session-absent' });
  });

  it('lets a late subscriber replay, then follow live', async () => {
    const bureauFeed = createBureauEventFeed({ bureauId: 'bureau-1' });
    bureauFeed.publish(new RunRegisteredEvent('run-1'));

    const seen: BureauEventEnvelope[] = [];
    const reading = (async () => {
      for await (const envelope of bureauFeed.feed.subscribe()) {
        seen.push(envelope);
        if (seen.length >= 2) break;
      }
    })();
    await Promise.resolve();
    bureauFeed.publish(new BureauDisposedEvent());
    await reading;

    expect(seen.map((envelope) => envelope.kind)).toEqual(['run.registered', 'bureau.disposed']);
    bureauFeed.dispose();
  });
});

describe('the bureau event feed live buffer size', () => {
  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5])(
    'rejects %p, which would stop the overflow check from ever firing',
    (liveBufferSize) => {
      expect(() => createBureauEventFeed({ bureauId: 'bureau-1', liveBufferSize })).toThrow(
        RangeError,
      );
    },
  );

  it('accepts a non-negative integer', () => {
    const feed = createBureauEventFeed({ bureauId: 'bureau-1', liveBufferSize: 0 });
    feed.dispose();
  });
});

describe('bureau event projection coverage', () => {
  it('keeps the filterable tuple and the projection registry in agreement', () => {
    expect([...publishedBureauEventKinds].toSorted()).toEqual(
      [...PUBLISHED_BUREAU_EVENT_KINDS].toSorted(),
    );
  });

  it('does not publish the supervisor task and synthesis events', () => {
    // They carry the task text, a whole `RunResult`, a raw error, and the
    // synthesized output. Omitting them is a decision, and this records it.
    for (const kind of ['task.routed', 'task.completed', 'task.failed', 'synthesis.completed']) {
      expect(publishedBureauEventKinds).not.toContain(kind);
    }
  });

  it('returns undefined for an event outside the published set', () => {
    expect(projectBureauEvent(new Event('bureau.nonexistent'))).toBeUndefined();
    expect(projectBureauEvent(undefined)).toBeUndefined();
    expect(projectBureauEvent({ type: 'run.registered' })).toBeUndefined();
  });

  it('projects the newly published event families through identifier-only payloads', () => {
    const events = [
      new SessionCreatedEvent('session-1', 'agent', 'incarnation-1', 3, 100),
      new SessionSavedEvent('session-1', 'agent', 'incarnation-1', 4, 101),
      new SessionDeletedEvent('session-1', 'incarnation-1', 5, 102),
      new AgentScheduledEvent({
        agentName: 'agent',
        scheduleId: 'schedule-1',
        spec: { cron: '* * * * *' },
      }),
      new SchedulePausedEvent('schedule-1', { dedupeKey: 'pause-1', committedAtMs: 103 }),
      new ScheduleResumedEvent('schedule-1', { dedupeKey: 'resume-1', committedAtMs: 104 }),
      new ScheduleCancelledEvent('schedule-1', { dedupeKey: 'cancel-1', committedAtMs: 105 }),
      new ScheduleFailedEvent('schedule-1', 'run-1'),
      new ScheduleCompletedEvent('schedule-1', 'run-1'),
      new ScheduleAttemptedEvent('schedule-1', 200),
      new ScheduleSkippedEvent('schedule-1', 'skip', 200, 'run-1'),
      new SkillLoadedEvent('skill', {
        runId: 'run-1',
        sessionId: 'session-1',
        artifactDigest: 'sha',
      }),
      new SkillActivatedEvent('skill', { runId: 'run-1' }),
      new SkillDeactivatedEvent('skill', { runId: 'run-1' }),
      new SkillRejectedEvent('skill', 'guardrail-blocked', { sessionId: 'session-1' }),
      new SkillFailedEvent('skill', { runId: 'run-1' }),
      new SteeringAcceptedEvent('session-1', 'command-1', 4),
      new RunAbortSettledEvent('run-1'),
    ];
    const allowed = new Set([
      'agentName',
      'scheduleId',
      'sessionId',
      'occurrence',
      'blockingRunId',
      'policy',
      'skillName',
      'runId',
      'traceId',
      'sourceId',
      'artifactDigest',
      'agentName',
      'target',
      'status',
      'reason',
      'rule',
      'commandId',
      'configVersion',
      'incarnation',
      'ordinal',
      'committedAtMs',
      'dedupeKey',
    ]);
    for (const event of events) {
      const projection = projectBureauEvent(event);
      expect(projection).toBeDefined();
      expect(Object.keys(projection?.payload ?? []).every((key) => allowed.has(key))).toBe(true);
    }
  });
});

describe('bureau feed disposal', () => {
  it('ends a live subscriber instead of leaving it parked', async () => {
    // Same hazard as the run feed: disposal unhooks a subscriber without
    // waking it, so the lifetime signal is what lets the generator finish.
    const bureauFeed = createBureauEventFeed({ bureauId: 'bureau-1' });
    let ended = false;
    const reading = (async () => {
      for await (const envelope of bureauFeed.feed.subscribe()) {
        expect(envelope.bureauId).toBe('bureau-1');
      }
      ended = true;
    })();

    await Promise.resolve();
    bureauFeed.dispose();
    await reading;

    expect(ended).toBe(true);
    expect(bureauFeed.signal.aborted).toBe(true);
  });
});

describe('the COR-1721 event families on the feed', () => {
  const payloadOf = (event: Event) => projectBureauEvent(event)?.payload;

  it('projects every goal kind with the fields it records', () => {
    expect(
      payloadOf(
        new GoalLifecycleEvent('goal.started', {
          goalRunId: 'goal-1',
          goalIdentity: { name: 'ship', version: '1' },
        }),
      ),
    ).toEqual({ goalRunId: 'goal-1', goalIdentity: { name: 'ship', version: '1' } });
    expect(
      payloadOf(
        new GoalLifecycleEvent('goal.attempt.started', {
          goalRunId: 'goal-1',
          attemptId: 'attempt-0',
          attemptIndex: 0,
          runId: 'run-0',
        }),
      ),
    ).toEqual({ goalRunId: 'goal-1', attemptId: 'attempt-0', attemptIndex: 0, runId: 'run-0' });
    expect(
      payloadOf(
        new GoalLifecycleEvent('goal.attempt.validated', {
          goalRunId: 'goal-1',
          attemptId: 'attempt-0',
          validatorIdentity: { name: 'check', version: '1' },
          outcomeKind: 'fail',
          feedbackDigest: 'abc',
        }),
      ),
    ).toEqual({
      goalRunId: 'goal-1',
      attemptId: 'attempt-0',
      validatorIdentity: { name: 'check', version: '1' },
      outcomeKind: 'fail',
      feedbackDigest: 'abc',
    });
    for (const kind of ['goal.succeeded', 'goal.exhausted', 'goal.canceled'] as const) {
      expect(
        projectBureauEvent(
          new GoalLifecycleEvent(kind, { goalRunId: 'goal-1', terminalReason: 'reason' }),
        ),
      ).toEqual({ kind, payload: { goalRunId: 'goal-1', terminalReason: 'reason' } });
    }
    expect(
      payloadOf(
        new GoalLifecycleEvent('goal.recovered', {
          goalRunId: 'goal-1',
          controllerRestarts: 2,
          status: 'running',
          transitionSeq: 4,
        }),
      ),
    ).toEqual({ goalRunId: 'goal-1', controllerRestarts: 2, status: 'running', transitionSeq: 4 });
  });

  it('keeps a failed goal’s validator error kind and code and never its message', () => {
    const event = new GoalLifecycleEvent('goal.failed', {
      goalRunId: 'goal-1',
      terminalReason: 'validator-infrastructure-error',
      validatorError: { kind: 'execute', code: 'VALIDATOR_THREW', message: CANARY },
      unexpected: CANARY,
    });

    expect(projectBureauEvent(event)).toEqual({
      kind: 'goal.failed',
      payload: {
        goalRunId: 'goal-1',
        terminalReason: 'validator-infrastructure-error',
        validatorError: { kind: 'execute', code: 'VALIDATOR_THREW' },
      },
    });
    expect(JSON.stringify(event.payload)).not.toContain(CANARY);
  });

  it('projects the forwarded asset kinds with the fields the asset event set', () => {
    expect(
      projectBureauEvent(
        new AssetLifecycleEvent('asset.upload.started', {
          sequence: 1,
          at: '2026-10-28T00:00:00.000Z',
          uploadId: 'upload-1',
          principal: 'alice',
        }),
      ),
    ).toEqual({
      kind: 'asset.upload.started',
      payload: {
        sequence: 1,
        at: '2026-10-28T00:00:00.000Z',
        uploadId: 'upload-1',
        principal: 'alice',
      },
    });
    expect(
      payloadOf(
        new AssetLifecycleEvent('asset.blob.purged', { sequence: 2, at: 'a', digest: 'd' }),
      ),
    ).toEqual({ sequence: 2, at: 'a', digest: 'd' });
    expect(
      payloadOf(
        new AssetLifecycleEvent('asset.upload.purged', { sequence: 3, at: 'a', uploadId: 'u' }),
      ),
    ).toEqual({ sequence: 3, at: 'a', uploadId: 'u' });
    expect(
      payloadOf(
        new AssetLifecycleEvent('asset.expired', {
          sequence: 4,
          at: 'a',
          assetId: 'asset-1',
          revision: 2,
          state: 'expired',
          principal: 'alice',
        }),
      ),
    ).toEqual({
      sequence: 4,
      at: 'a',
      assetId: 'asset-1',
      revision: 2,
      state: 'expired',
      principal: 'alice',
    });
  });

  it('projects definitions, missed fires, cleanup acknowledgements, and diagnostics', () => {
    expect(
      projectBureauEvent(
        new DefinitionsChangedEvent('agents', {
          added: ['a'],
          changed: ['b'],
          removed: ['c'],
          rejected: ['b'],
        }),
      ),
    ).toEqual({
      kind: 'definitions.changed',
      payload: { catalog: 'agents', added: ['a'], changed: ['b'], removed: ['c'], rejected: ['b'] },
    });
    expect(
      projectBureauEvent(new ScheduleMissedEvent('schedule-1', 3, 100, 400, 'dst-gap')),
    ).toEqual({
      kind: 'schedule.missed',
      payload: {
        scheduleId: 'schedule-1',
        missedCount: 3,
        windowStart: 100,
        windowEnd: 400,
        reason: 'dst-gap',
      },
    });
    expect(projectBureauEvent(new TaskCleanupAcknowledgedEvent('run-1', 'cleanup-failed'))).toEqual(
      {
        kind: 'task.cleanup-acknowledged',
        payload: { taskId: 'run-1', cleanup: 'cleanup-failed' },
      },
    );
    expect(projectBureauEvent(new DiagnosticEvent('error', 'event-feed'))).toEqual({
      kind: 'diagnostic',
      payload: { level: 'error', scope: 'event-feed' },
    });
  });
});

describe('the bureau event feed subscriber count (COR-1731)', () => {
  it('counts a live subscription until it ends, and a replay holds none', async () => {
    const eventFeed = createBureauEventFeed({ bureauId: 'bureau-1' });
    eventFeed.publish(new RunRegisteredEvent('one'));
    expect(eventFeed.subscriberCount()).toBe(0);

    for await (const _ of eventFeed.feed.replay()) void _;
    expect(eventFeed.subscriberCount()).toBe(0);

    const first = eventFeed.feed.subscribe()[Symbol.asyncIterator]();
    const second = eventFeed.feed.subscribe()[Symbol.asyncIterator]();
    await first.next();
    await second.next();
    expect(eventFeed.subscriberCount()).toBe(2);

    await first.return?.();
    expect(eventFeed.subscriberCount()).toBe(1);
    await second.return?.();
    expect(eventFeed.subscriberCount()).toBe(0);
  });

  it('releases a subscription when its own signal aborts', async () => {
    const eventFeed = createBureauEventFeed({ bureauId: 'bureau-1' });
    eventFeed.publish(new RunRegisteredEvent('one'));
    const controller = new AbortController();
    const subscription = eventFeed.feed.subscribe({ signal: controller.signal });
    const iterator = subscription[Symbol.asyncIterator]();
    await iterator.next();
    expect(eventFeed.subscriberCount()).toBe(1);

    controller.abort();
    expect(eventFeed.subscriberCount()).toBe(0);
  });

  it('holds none once the feed is disposed', async () => {
    const eventFeed = createBureauEventFeed({ bureauId: 'bureau-1' });
    const iterator = eventFeed.feed.subscribe()[Symbol.asyncIterator]();
    const pending = iterator.next();
    expect(eventFeed.subscriberCount()).toBe(1);

    eventFeed.dispose();
    await pending;
    expect(eventFeed.subscriberCount()).toBe(0);
  });
});

/**
 * COR-2096 — each of the five kinds, triggered in a real chat run and in a real goal attempt, is
 * published exactly once with exactly its fields. A goal attempt is not on the run store, so its
 * events reach the feed through the observer the catalog dispatcher hands every such run.
 */
describe('a run’s guardrail, budget and tool events on the feed (COR-2096)', () => {
  const SENTINEL = 'SENTINEL-INPUT';
  const sentinel: InputDetector = {
    name: 'sentinel',
    detect: async (input) =>
      input.includes(SENTINEL)
        ? { triggered: true, category: 'prompt-injection', confidence: 0.9 }
        : { triggered: false, category: 'prompt-injection', confidence: 0 },
  };
  const PRICING = {
    customPricing: { cheap: { promptCostPerMillionTokens: 1, completionCostPerMillionTokens: 2 } },
  };
  const refund = (execute: () => Promise<string>, policyDenies = false) =>
    createTool({
      name: 'refund',
      description: 'Refunds an order',
      input: z.object({}),
      ...(policyDenies
        ? { policy: { beforeExecute: () => ({ allow: false, reason: `denied: ${CANARY}` }) } }
        : {}),
      execute,
    });
  /** Step 0 calls the tool, and the step after it answers. */
  const callsRefund: GenerateFunction = async (context) =>
    context.step === 0
      ? { content: '', toolCalls: [{ id: 'call-1', name: 'refund', arguments: {} }] }
      : { content: 'done', toolCalls: [] };
  const answers: GenerateFunction = async () => ({
    content: 'done',
    toolCalls: [],
    usage: { prompt: 100_000, completion: 0, total: 100_000 },
  });

  interface Scenario {
    readonly kind: string;
    readonly agent: () => ReturnType<typeof createAgent>;
    /** The payload's fields other than `runId`. */
    readonly payload: Record<string, unknown>;
  }
  const SCENARIOS: readonly Scenario[] = [
    {
      kind: 'run.tripwire',
      agent: () =>
        createAgent({
          name: 'worker',
          generate: answers,
          stopWhen: stopWhen.noToolCalls(),
          guardrails: { mode: 'tripwire', input: { detectors: [sentinel] } },
        }),
      payload: {
        step: 0,
        guardrailName: 'sentinel',
        category: 'prompt-injection',
        phase: 'input',
        confidence: 0.9,
      },
    },
    {
      kind: 'run.guardrail',
      agent: () =>
        createAgent({
          name: 'worker',
          generate: answers,
          stopWhen: stopWhen.noToolCalls(),
          guardrails: { mode: 'validate', input: { action: 'warn', detectors: [sentinel] } },
        }),
      payload: {
        step: 0,
        guardrailName: 'sentinel',
        category: 'prompt-injection',
        phase: 'input',
        confidence: 0.9,
        action: 'warn',
      },
    },
    {
      kind: 'budget.threshold',
      agent: () =>
        createAgent({
          name: 'worker',
          generate: answers,
          stopWhen: stopWhen.noToolCalls(),
          costEstimation: { model: 'cheap', pricing: PRICING },
          costBudget: { perRunUsd: 0.15, warnAt: [0.5] },
        }),
      payload: { step: 0, threshold: 0.5, currentCost: 0.1, budget: 0.15, model: 'cheap' },
    },
    {
      kind: 'tool.policy-denied',
      agent: () =>
        createAgent({
          name: 'worker',
          generate: callsRefund,
          stopWhen: stopWhen.noToolCalls(),
          toolbox: createToolbox([refund(async () => 'ok', true)]),
        }),
      payload: { step: 0, toolName: 'refund', toolCallId: 'call-1' },
    },
    {
      kind: 'tool.error',
      agent: () =>
        createAgent({
          name: 'worker',
          generate: callsRefund,
          stopWhen: stopWhen.noToolCalls(),
          toolbox: createToolbox([
            refund(async () => {
              throw new Error(`the tool failed: ${CANARY}`);
            }),
          ]),
        }),
      payload: { step: 0, toolName: 'refund', toolCallId: 'call-1', errorCode: expect.any(String) },
    },
  ];

  const bureaus: Bureau[] = [];
  afterEach(async () => {
    for (const bureau of bureaus.splice(0)) await bureau.dispose();
  });

  async function openWorker(agent: ReturnType<typeof createAgent>, goals: boolean) {
    const bureau = await createBureau<AgentDefinitions>({
      agents: { worker: agent },
      storage: new MemoryStorage(),
      ...(goals ? { durable: true, validators: [createCheckValidator()] } : {}),
      onDiagnostic: () => undefined,
    });
    bureaus.push(bureau);
    return bureau;
  }

  async function published(bureau: Bureau, kind: string, runId: string) {
    await bureau.internals.taskRegistry.flush();
    const found: Array<{ kind: string; payload: Record<string, unknown> }> = [];
    for await (const envelope of bureau.internals.eventFeed.feed.replay()) {
      const entry = envelope as unknown as (typeof found)[number];
      if (entry.kind === kind && entry.payload['runId'] === runId) found.push(entry);
    }
    return found;
  }

  async function terminal(bureau: Bureau, taskId: string): Promise<void> {
    await waitUntil(
      async () => {
        const task = await bureau.tasks.get(taskId);
        return task !== undefined && ['completed', 'failed', 'canceled'].includes(task.status);
      },
      { message: `task ${taskId} is terminal` },
    );
  }

  describe.each(SCENARIOS.map((scenario) => [scenario.kind, scenario] as const))(
    '%s',
    (kind, scenario) => {
      it('is published once, with exactly its fields, for a chat run', async () => {
        const bureau = await openWorker(scenario.agent(), false);
        const run = await bureau.tasks.start('worker', `go ${SENTINEL}`, { principal: 'alice' });
        await terminal(bureau, run.id);

        const events = await published(bureau, kind, run.id);
        expect(events).toHaveLength(1);
        expect(events[0]?.payload).toEqual({ runId: run.id, ...scenario.payload });
        expect(JSON.stringify(events)).not.toContain(CANARY);
        expect(JSON.stringify(events)).not.toContain(SENTINEL);
      });

      it('is published once, with exactly its fields, for a goal attempt', async () => {
        const bureau = await openWorker(scenario.agent(), true);
        await bureau.goals.create(goalRequest({ goalRunId: 'g1', prompt: `go ${SENTINEL}` }));
        await terminal(bureau, 'goal-g1-a0');

        const events = await published(bureau, kind, 'goal-g1-a0');
        expect(events).toHaveLength(1);
        expect(events[0]?.payload).toEqual({ runId: 'goal-g1-a0', ...scenario.payload });
        expect(JSON.stringify(events)).not.toContain(CANARY);
        expect(JSON.stringify(events)).not.toContain(SENTINEL);
      });
    },
  );

  /**
   * The other kinds of run that raise a guardrail's trip: a child run (durable or not) and a
   * workflow `agent` step. The tripwire stands for the five kinds, which each of these routes alike.
   */
  describe('run.tripwire for every other kind of run', () => {
    const tripwireAgent = () =>
      SCENARIOS.find((scenario) => scenario.kind === 'run.tripwire')!.agent();
    const TRIPWIRE_PAYLOAD = SCENARIOS.find(
      (scenario) => scenario.kind === 'run.tripwire',
    )!.payload;
    const parked: GenerateFunction = ({ signal }) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });

    it.each([
      ['durable', { durable: true }],
      ['not durable', { durable: false }],
    ] as const)('is published once for a child run (%s)', async (_name, mode) => {
      const bureau = await createBureau<AgentDefinitions>({
        agents: {
          planner: createAgent({
            name: 'planner',
            generate: parked,
            stopWhen: stopWhen.noToolCalls(),
          }),
          worker: tripwireAgent(),
        },
        storage: new MemoryStorage(),
        onDiagnostic: () => undefined,
        ...mode,
      });
      bureaus.push(bureau);
      const parent = await bureau.tasks.start('planner', 'plan', { principal: 'alice' });
      const dispatched = await bureau.children.dispatch({
        parentRunId: parent.id,
        agentName: 'worker',
        input: `go ${SENTINEL}`,
        principal: 'alice',
        childRunId: 'child-1',
      });
      expect(dispatched).toMatchObject({ outcome: 'started' });
      await terminal(bureau, 'child-1');

      const events = await published(bureau, 'run.tripwire', 'child-1');
      expect(events).toHaveLength(1);
      expect(events[0]?.payload).toEqual({ runId: 'child-1', ...TRIPWIRE_PAYLOAD });
    });

    it('is published once for a workflow agent step', async () => {
      const harness = await startWorkflowBureau({
        agentNames: [],
        overrides: { agents: { writer: tripwireAgent() } },
      });
      bureaus.push(harness.bureau);
      await harness.putWorkflow('digest', {
        trigger: { kind: 'schedule', spec: '1h' },
        steps: [
          {
            kind: 'activity',
            handler: 'agent',
            input: { agent: 'writer', message: `Write ${SENTINEL}` },
          },
        ],
      });
      const run = await harness.bureau.durableEngine()?.start('digest', null, { id: 'instance-1' });
      let stepId = '';
      await waitUntil(
        async () => {
          const runs = await harness.bureau.durableEngine()?.list({ type: 'agentRun' });
          stepId = runs?.items[0]?.id ?? '';
          return stepId !== '' && (await harness.bureau.tasks.get(stepId)) !== undefined;
        },
        { message: 'the step run is a task' },
      );
      await run?.result().catch(() => undefined);
      await terminal(harness.bureau, stepId);

      const events = await published(harness.bureau, 'run.tripwire', stepId);
      expect(events).toHaveLength(1);
      expect(events[0]?.payload).toEqual({ runId: stepId, ...TRIPWIRE_PAYLOAD });
    });

    // A schedule fire and a catalog run resumed after a restart are not here: nothing attaches the
    // observer to either, so none of the five kinds is published for them (see the README). Their
    // outcome kinds (`run.completed`, `run.error`, `run.aborted`) are published, from the task
    // registry's settlement (`run-outcome-events.test.ts`).
  });
});

describe('the events a run records (COR-2096), projected', () => {
  const recorded = (type: string, detail: Record<string, unknown>) => ({
    sequence: 4,
    runId: 'run-1',
    type,
    detail: { step: 2, ...detail },
    timestamp: 1_800_000_000_000,
  });
  const GUARDRAIL = {
    guardrailName: 'sentinel',
    category: 'prompt-injection',
    phase: 'input',
    confidence: 0.9,
  };

  it('publishes a tripwire by the guardrail’s identity, never the flagged text or its detail', () => {
    const projected = projectBureauEvent(
      new RunTripwireRecordedEvent(
        recorded('run.tripwire', { ...GUARDRAIL, detail: `quotes ${CANARY}`, error: CANARY }),
      ),
    );

    expect(projected).toEqual({
      kind: 'run.tripwire',
      payload: { runId: 'run-1', step: 2, ...GUARDRAIL },
    });
    expect(JSON.stringify(projected)).not.toContain(CANARY);
  });

  it('adds only the action to a validate-mode guardrail’s', () => {
    const projected = projectBureauEvent(
      new RunGuardrailRecordedEvent(recorded('run.guardrail', { ...GUARDRAIL, action: 'redact' })),
    );

    expect(projected?.payload).toEqual({ runId: 'run-1', step: 2, ...GUARDRAIL, action: 'redact' });
  });

  it('publishes a budget threshold without a step when a monitor reported it', () => {
    const fields = { threshold: 0.5, currentCost: 0.1, budget: 0.15, model: 'cheap' };
    const withStep = projectBureauEvent(
      new BudgetThresholdRecordedEvent(recorded('budget.threshold', fields)),
    );
    const monitor = projectBureauEvent(
      new BudgetThresholdRecordedEvent({
        ...recorded('budget.threshold', fields),
        detail: fields,
      }),
    );

    expect(withStep?.payload).toEqual({ runId: 'run-1', step: 2, ...fields });
    expect(monitor?.payload).toEqual({ runId: 'run-1', ...fields });
  });

  it('publishes a refused tool call without the policy’s reason or the call’s arguments', () => {
    const projected = projectBureauEvent(
      new ToolPolicyDeniedRecordedEvent(
        recorded('tool.policy-denied', {
          toolName: 'refund',
          toolCallId: 'call-1',
          reason: CANARY,
          agentName: 'worker',
          arguments: { secret: CANARY },
        }),
      ),
    );

    expect(projected?.payload).toEqual({
      runId: 'run-1',
      step: 2,
      toolName: 'refund',
      toolCallId: 'call-1',
    });
    expect(JSON.stringify(projected)).not.toContain(CANARY);
  });

  it.each([
    ['a string code', { code: 'RATE_LIMITED', message: CANARY }, 'RATE_LIMITED'],
    ['a code that is not a string', { code: 429, message: CANARY }, 'INTERNAL_ERROR'],
    [
      'a code with spaces, which is free text',
      { code: `rate limited ${CANARY}` },
      'INTERNAL_ERROR',
    ],
    ['a lower-case code', { code: 'rate_limited' }, 'INTERNAL_ERROR'],
    ['a code longer than 64 characters', { code: 'A'.repeat(65) }, 'INTERNAL_ERROR'],
    ['a code of 64 characters', { code: 'A'.repeat(64) }, 'A'.repeat(64)],
    ['an error with no code', new Error(CANARY), 'INTERNAL_ERROR'],
    ['a thrown string', CANARY, 'INTERNAL_ERROR'],
    ['no error at all', undefined, 'INTERNAL_ERROR'],
  ])(
    'publishes a failed tool call with %s as its error code, never its message',
    (_name, error, code) => {
      const projected = projectBureauEvent(
        new ToolErrorRecordedEvent(
          recorded('tool.error', { toolName: 'refund', toolCallId: 'call-1', error }),
        ),
      );

      expect(projected?.payload).toEqual({
        runId: 'run-1',
        step: 2,
        toolName: 'refund',
        toolCallId: 'call-1',
        errorCode: code,
      });
      expect(JSON.stringify(projected)).not.toContain(CANARY);
    },
  );

  it('drops a field whose type is not the one the catalog names, and never throws on a malformed detail', () => {
    const projected = projectBureauEvent(
      new RunTripwireRecordedEvent({
        sequence: 0,
        runId: 'run-1',
        type: 'run.tripwire',
        detail: { step: '2', guardrailName: 7, confidence: Number.NaN },
        timestamp: 1,
      }),
    );
    const nothing = projectBureauEvent(
      new ToolErrorRecordedEvent({
        sequence: 0,
        runId: 'run-1',
        type: 'tool.error',
        detail: null,
        timestamp: 1,
      }),
    );

    expect(projected?.payload).toEqual({ runId: 'run-1' });
    expect(nothing?.payload).toEqual({ runId: 'run-1', errorCode: 'INTERNAL_ERROR' });
  });
});

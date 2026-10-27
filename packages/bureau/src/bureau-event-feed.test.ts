import { createDefaultRuntimeServices } from '@lostgradient/lifecycle';
import {
  AgentScheduledEvent,
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
import { describe, expect, it } from 'bun:test';

import {
  type BureauEventEnvelope,
  createBureauEventFeed,
  projectBureauEvent,
  PUBLISHED_BUREAU_EVENT_KINDS,
  publishedBureauEventKinds,
} from './bureau-event-feed.ts';
import {
  ActionEvent,
  BureauDisposedEvent,
  RunAbortSettledEvent,
  RecoveryRejectedEvent,
  ReviewApprovedEvent,
  RunRegisteredEvent,
} from './events.ts';
import {
  SkillActivatedEvent,
  SkillDeactivatedEvent,
  SkillFailedEvent,
  SkillLoadedEvent,
  SkillRejectedEvent,
} from './skills/events.ts';

const CANARY = 'CallerSuppliedDetailCanary';

describe('the bureau event feed', () => {
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

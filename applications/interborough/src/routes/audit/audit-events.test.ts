import { describe, expect, test } from 'bun:test';

import type { AuditRecord } from '../../lib/bureau-audit.ts';
import type { BureauToolApproval } from '../../lib/bureau-reviews.ts';
import {
  amountOf,
  callLabelOf,
  dayGroupOf,
  describeRecord,
  describeRecords,
  lookupRequestsFor,
  narrowEvents,
  NO_LOOKUPS,
  recordKey,
  reviewIdOf,
  summaryOf,
  whenOf,
  type AuditLookups,
} from './audit-events.ts';
import { changedWords, detailOf } from './audit-facts.ts';

const at = (iso: string) => Date.parse(iso);

function record(overrides: Partial<AuditRecord> & { type: string }): AuditRecord {
  return {
    sequence: 1,
    timestamp: '2026-11-02T16:45:00.000Z',
    resource: 'run-1',
    principal: 'anonymous:local',
    detail: null,
    ...overrides,
  };
}

const REVIEW = {
  source: 'bureau',
  kind: 'tool-approval',
  id: 'approval:run-1:c1',
  runId: 'run-1',
  requestedAt: 0,
  ageMilliseconds: 0,
  status: 'pending',
  sessionId: 'chat-1',
  round: 1,
  approval: {
    callId: 'c1',
    toolName: 'issue-refund',
    arguments: { orderId: '4471', cents: 4200 },
    action: {
      type: 'approval',
      message: 'Refund order 4471 for $42.00?',
      risk: 'high',
      operation: { kind: 'tool' },
    },
  },
} as unknown as BureauToolApproval;

const LOOKUPS: AuditLookups = {
  ...NO_LOOKUPS,
  chatTitles: new Map([['chat-1', 'Please refund order 4471, it arrived damaged.']]),
  reviews: new Map([['approval:run-1:c1', REVIEW]]),
  tools: new Map([['issue-refund', { title: 'Issue refund', tier: 'dangerous' }]]),
  scheduleNames: new Map([['s-1', 'Daily summary']]),
  memories: new Map([['m-1', 'prefers long summaries']]),
  agentName: (name) => (name === 'tool-runner' ? 'Tool runner' : name),
};

describe('which records are events', () => {
  test('a run’s steps, a tool that ran without asking, and an unknown type are not', () => {
    for (const type of [
      'step.completed',
      'tool.started',
      'run.cleanup-settled',
      'run.completed',
      'who.knows',
    ]) {
      expect(describeRecord(record({ type }), LOOKUPS), type).toBeUndefined();
    }
    const ungated = record({
      type: 'tool.settled',
      principal: null,
      detail: { status: 'success', toolName: 'lookup-order' },
    });
    expect(describeRecord(ungated, LOOKUPS)).toBeUndefined();
  });
});

describe('who did it', () => {
  test('a person at this host is You, a service is Interborough, and an agent is named', () => {
    expect(
      describeRecord(record({ type: 'run.started', detail: { agentName: 'tool-runner' } }), LOOKUPS)
        ?.actor,
    ).toEqual({ kind: 'you', name: 'You' });
    expect(
      describeRecord(record({ type: 'host.started', principal: 'system:host' }), LOOKUPS)?.actor,
    ).toEqual({ kind: 'host', name: 'Interborough' });
    const asked = record({
      type: 'tool.settled',
      principal: null,
      detail: {
        agentName: 'tool-runner',
        status: 'paused',
        toolName: 'issue-refund',
        toolCallId: 'c1',
      },
    });
    expect(describeRecord(asked, LOOKUPS)?.actor).toEqual({ kind: 'agent', name: 'Tool runner' });
    // The run's own id is the principal of a memory an agent wrote; the agent is who did it.
    const corrected = record({
      type: 'memory.corrected',
      principal: 'run-1',
      detail: { agentName: 'tool-runner', writer: 'agent', memoryId: 'm-1' },
    });
    expect(describeRecord(corrected, LOOKUPS)?.actor.name).toBe('Tool runner');
    // No actor and no agent: the host noticed it.
    expect(
      describeRecord(
        record({
          type: 'schedule.created',
          principal: null,
          resource: 'schedule:s-1',
          detail: { scheduleId: 's-1' },
        }),
        LOOKUPS,
      )?.actor.kind,
    ).toBe('host');
  });
});

describe('what was done, in words', () => {
  test('words a tool call that asked in the tool’s own sentence, without its amount', () => {
    const asked = record({
      type: 'tool.settled',
      principal: null,
      detail: {
        agentName: 'tool-runner',
        status: 'paused',
        toolName: 'issue-refund',
        toolCallId: 'c1',
      },
    });
    const event = describeRecord(asked, LOOKUPS);
    expect(event?.action).toBe('Asked to refund order 4471');
    expect(event?.target).toBe('Issue refund · order 4471');
    expect(event?.title).toBe('Tool runner asked to refund order 4471');
    // Before the review is read, the tool is named instead.
    expect(describeRecord(asked, NO_LOOKUPS)?.action).toBe('Asked to use Issue refund');
  });

  test('words an approval, a run of a call that was approved, and a corrected memory', () => {
    const approved = record({
      type: 'review.tool-approval.approved',
      detail: { toolName: 'issue-refund', callId: 'c1' },
    });
    expect(describeRecord(approved, LOOKUPS)).toMatchObject({
      action: 'Approved a tool call',
      target: 'Issue refund · order 4471',
      title: 'You approved a tool call',
    });
    const ran = record({
      type: 'tool.settled',
      principal: null,
      detail: {
        agentName: 'tool-runner',
        status: 'success',
        toolName: 'issue-refund',
        reviewId: 'approval:run-1:c1',
      },
    });
    expect(describeRecord(ran, LOOKUPS)).toMatchObject({
      action: 'Ran Issue refund',
      target: '$42.00 · Issue refund',
    });
    const corrected = record({
      type: 'memory.corrected',
      principal: null,
      detail: { agentName: 'tool-runner', writer: 'agent', memoryId: 'm-1' },
    });
    expect(describeRecord(corrected, LOOKUPS)?.target).toBe('“prefers long summaries”');
  });

  test('words a removed key, missed runs, a server start, an agent edit and a deleted storage key', () => {
    expect(
      describeRecord(
        record({
          type: 'provider.disconnected',
          resource: 'provider:anthropic',
          detail: { provider: 'anthropic' },
        }),
        LOOKUPS,
      ),
    ).toMatchObject({ action: 'Removed the Anthropic key', target: 'Anthropic provider' });
    expect(
      describeRecord(
        record({
          type: 'schedule.missed',
          principal: 'system:scheduler',
          resource: 'schedule:s-1',
          detail: { scheduleId: 's-1', missedCount: 4 },
        }),
        LOOKUPS,
      ),
    ).toMatchObject({ action: 'Noticed 4 missed runs', target: 'Daily summary' });
    expect(
      describeRecord(
        record({
          type: 'schedule.missed',
          principal: 'system:scheduler',
          resource: 'schedule:s-1',
          detail: { scheduleId: 's-1', missedCount: 1 },
        }),
        LOOKUPS,
      )?.action,
    ).toBe('Noticed 1 missed run');
    expect(
      describeRecord(
        record({ type: 'host.started', principal: 'system:host', resource: 'host' }),
        LOOKUPS,
      )?.title,
    ).toBe('Server started');
    expect(
      describeRecord(
        record({
          type: 'agent.updated',
          resource: 'agent:tool-runner',
          detail: { revision: 4, previousRevision: 3 },
        }),
        LOOKUPS,
      ),
    ).toMatchObject({ action: 'Edited an agent', target: 'Tool runner · version 3 → 4' });
    expect(
      describeRecord(
        record({
          type: 'storage.key.deleted',
          principal: 'system:host',
          resource: 'storage:workflows/x',
        }),
        LOOKUPS,
      ),
    ).toMatchObject({ action: 'Deleted a storage key', target: 'Storage › workflows/x' });
  });

  test('names the chat only for the newest run of it, because the title is its latest message', () => {
    const older = record({
      type: 'run.started',
      sequence: 1,
      timestamp: '2026-11-02T16:30:00.000Z',
      detail: { agentName: 'tool-runner', sessionId: 'chat-1' },
    });
    const newer = record({
      type: 'run.started',
      sequence: 2,
      timestamp: '2026-11-02T16:42:00.000Z',
      detail: { agentName: 'tool-runner', sessionId: 'chat-1' },
    });
    const events = describeRecords([newer, older], LOOKUPS);
    expect(events.map((event) => event.target)).toEqual([
      'Chat › Please refund order 4471, it arrived damaged.',
      'Tool runner',
    ]);
  });
});

describe('reading a tool call', () => {
  test('finds the review of a call, the amount it names, and what it was about', () => {
    expect(
      reviewIdOf(record({ type: 'tool.settled', resource: 'run-9', detail: { toolCallId: 'c' } })),
    ).toBe('approval:run-9:c');
    expect(reviewIdOf(record({ type: 'tool.settled', detail: { reviewId: 'r-1' } }))).toBe('r-1');
    expect(amountOf('Refund order 4471 for $42.00')).toBe('$42.00');
    expect(amountOf('Send 3 emails')).toBeUndefined();
    expect(summaryOf(REVIEW)).toBe('Refund order 4471 for $42.00');
    expect(callLabelOf(REVIEW)).toBe('order 4471');
    expect(callLabelOf(undefined)).toBeUndefined();
  });
});

describe('narrowing the events', () => {
  const events = describeRecords(
    [
      record({
        type: 'provider.disconnected',
        resource: 'provider:anthropic',
        detail: { provider: 'anthropic' },
      }),
      record({ type: 'host.started', principal: 'system:host', resource: 'host', sequence: 2 }),
      record({
        type: 'tool.settled',
        principal: null,
        sequence: 3,
        detail: {
          agentName: 'tool-runner',
          status: 'paused',
          toolName: 'issue-refund',
          toolCallId: 'c1',
        },
      }),
    ],
    LOOKUPS,
  );

  test('by who did it', () => {
    expect(narrowEvents(events, 'you', '').map((event) => event.actor.name)).toEqual(['You']);
    expect(narrowEvents(events, 'agents', '').map((event) => event.actor.name)).toEqual([
      'Tool runner',
    ]);
    expect(narrowEvents(events, 'interborough', '').map((event) => event.actor.name)).toEqual([
      'Interborough',
    ]);
    expect(narrowEvents(events, '', '')).toHaveLength(3);
  });

  test('by text anywhere in the actor, the action or the target, whatever its case', () => {
    expect(narrowEvents(events, '', 'ANTHROPIC')).toHaveLength(1);
    expect(narrowEvents(events, '', 'tool runner')).toHaveLength(1);
    expect(narrowEvents(events, '', 'refund order')).toHaveLength(1);
    expect(narrowEvents(events, '', 'zzz')).toHaveLength(0);
  });
});

describe('what the page looks up', () => {
  test('asks for the chats, reviews, schedules and memories the events name, once each', () => {
    const requests = lookupRequestsFor([
      record({ type: 'run.started', detail: { sessionId: 'chat-1', agentName: 'a' } }),
      record({ type: 'run.started', sequence: 2, detail: { sessionId: 'chat-1', agentName: 'a' } }),
      record({
        type: 'tool.settled',
        sequence: 3,
        principal: null,
        detail: { status: 'paused', toolCallId: 'c1' },
      }),
      record({ type: 'tool.settled', sequence: 4, principal: null, detail: { status: 'success' } }),
      record({
        type: 'schedule.missed',
        sequence: 5,
        resource: 'schedule:s-1',
        detail: { scheduleId: 's-1' },
      }),
      record({
        type: 'memory.corrected',
        sequence: 6,
        detail: { agentName: 'tool-runner', memoryId: 'm-1' },
      }),
      record({ type: 'step.completed', sequence: 7, detail: { sessionId: 'never' } }),
    ]);
    expect(requests).toEqual({
      sessionIds: ['chat-1'],
      reviewIds: ['approval:run-1:c1'],
      scheduleIds: ['s-1'],
      memories: [{ agent: 'tool-runner', id: 'm-1' }],
    });
  });
});

describe('time', () => {
  const now = at('2026-11-02T16:46:00.000Z');

  test('groups a day under Today, Yesterday or its date, with the zone beside it', () => {
    expect(dayGroupOf(at('2026-11-02T16:45:00.000Z'), now).label).toMatch(/^Today, Nov 2$/);
    expect(dayGroupOf(at('2026-11-01T22:12:00.000Z'), now).label).toMatch(
      /^Yesterday, [A-Z][a-z]{2} Nov 1$/,
    );
    expect(dayGroupOf(at('2026-10-29T12:40:00.000Z'), now).label).toMatch(/^[A-Z][a-z]{2} Oct 29$/);
    expect(dayGroupOf(at('2026-11-02T16:45:00.000Z'), now).detail).not.toBe('');
  });

  test('reads a moment with its seconds under a day word or a date', () => {
    expect(whenOf(at('2026-11-02T16:45:12.000Z'), now)).toMatch(/^Today at \d{1,2}:45:12 [AP]M$/);
    expect(whenOf(at('2026-10-29T12:40:12.000Z'), now)).toMatch(
      /^[A-Z][a-z]{2} Oct 29 at \d{1,2}:40:12 [AP]M$/,
    );
  });

  test('keys a record by its time and its place in the trail', () => {
    expect(recordKey(record({ type: 'x', sequence: 7 }))).toBe('2026-11-02T16:45:00.000Z#7');
    expect(recordKey(record({ type: 'x', sequence: null }))).toBe('2026-11-02T16:45:00.000Z#');
  });
});

describe('the pane’s facts', () => {
  const now = at('2026-11-02T16:46:00.000Z');

  test('words what changed in an agent’s version, listing the tools added or removed by their names', () => {
    const name = (id: string) => (id === 'issue-refund' ? 'Issue refund' : id);
    expect(changedWords('instructions,tools', 'issue-refund', undefined, name)).toBe(
      'Instructions · Tools · added Issue refund',
    );
    expect(changedWords('toolApproval,model', undefined, 'a,b', name)).toBe(
      'Tool approvals · Model · removed a, b',
    );
    expect(changedWords(undefined, undefined, undefined, name)).toBe('');
    expect(changedWords('retryPolicy', undefined, undefined, name)).toBe('Retry policy');
  });

  test('a removed key has its provider and effect, and a link to Providers', () => {
    const event = describeRecord(
      record({
        type: 'provider.disconnected',
        resource: 'provider:anthropic',
        detail: { provider: 'anthropic' },
      }),
      LOOKUPS,
    );
    const model = detailOf(event!, LOOKUPS, now);
    expect(model.facts.map((fact) => fact.term)).toEqual(['Provider', 'Effect']);
    expect(model.links).toEqual([{ label: 'Open Providers', href: '/settings/models' }]);
    expect(model.whenLine).toMatch(/^Today at .* · from this browser$/);
  });

  test('a decided call is Done, and a call whose review is gone reads as waiting', () => {
    const approved = describeRecord(
      record({
        type: 'review.tool-approval.approved',
        detail: { toolName: 'issue-refund', callId: 'c1' },
      }),
      LOOKUPS,
    );
    const decided = { ...REVIEW, status: 'approved' } as BureauToolApproval;
    const withDecided: AuditLookups = {
      ...LOOKUPS,
      reviews: new Map([['approval:run-1:c1', decided]]),
    };
    const status = (lookups: AuditLookups) =>
      detailOf(approved!, lookups, now).facts.find((fact) => fact.term === 'Status')?.value;
    expect(status(withDecided)).toEqual({ kind: 'status', word: 'Done' });
    const asked = describeRecord(
      record({
        type: 'tool.settled',
        principal: null,
        detail: {
          agentName: 'tool-runner',
          status: 'paused',
          toolName: 'issue-refund',
          toolCallId: 'c1',
        },
      }),
      NO_LOOKUPS,
    );
    expect(
      detailOf(asked!, NO_LOOKUPS, now).facts.find((fact) => fact.term === 'Status')?.value,
    ).toEqual({ kind: 'status', word: 'Waiting on you' });
  });
});

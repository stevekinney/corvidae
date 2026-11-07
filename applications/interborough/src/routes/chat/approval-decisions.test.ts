/**
 * How a decided approval reads on the rail and under its call (COR-2016, design rows 18g, 18i and
 * the rail rows 16h): who decided and when come from the Bureau's record on the call's outcome row,
 * and where, when it was not here, from what the page watched.
 */
import type { ConversationHistory } from '@lostgradient/chat';
import { describe, expect, test } from 'bun:test';

import { decidedByLabel, decidedLine } from './approval-decision-words.ts';
import {
  APPROVAL_DECISION_METADATA_KEY,
  railCall,
  recordedDecision,
  toolGroups,
  type ToolCallEntry,
} from './tool-activity.ts';

type Row = ConversationHistory['messages'][string];

const row = (value: Record<string, unknown>): Row =>
  ({
    role: 'assistant',
    content: '',
    metadata: {},
    createdAt: '2026-11-02T16:40:00.000Z',
    ...value,
  }) as Row;

function conversation(...rows: Row[]): ConversationHistory {
  return {
    schemaVersion: 4,
    id: 't',
    status: 'active',
    metadata: {},
    ids: rows.map((entry) => entry.id),
    messages: Object.fromEntries(rows.map((entry) => [entry.id, entry])),
    createdAt: '2026-11-02T16:40:00.000Z',
    updatedAt: '2026-11-02T16:40:00.000Z',
  };
}

const DECIDED_AT = '2026-11-02T16:46:00.000Z';

/** One call to Issue refund whose approval the Bureau recorded as `decision`, and what became of it. */
function entryDecided(
  decision: Record<string, unknown> | undefined,
  outcome: 'success' | 'error' = 'success',
  content: unknown = { refunded: 4200 },
): ToolCallEntry {
  const history = conversation(
    row({
      id: 'call',
      role: 'tool-call',
      toolCall: { id: 'c1', name: 'issue-refund', arguments: { orderId: 4471 } },
    }),
    row({
      id: 'result',
      role: 'tool-result',
      toolResult: { callId: 'c1', outcome, content },
      metadata: decision === undefined ? {} : { [APPROVAL_DECISION_METADATA_KEY]: decision },
    }),
  );
  const entry = [...toolGroups(history).groups.values()][0]?.entries[0];
  if (entry === undefined) throw new Error('expected one call');
  return entry;
}

const APPROVED = { decision: 'approve', decidedBy: 'anonymous:local', decidedAt: DECIDED_AT };

describe('recordedDecision', () => {
  test('reads who, when, the note and the sentence the tool asked with', () => {
    expect(
      recordedDecision({
        [APPROVAL_DECISION_METADATA_KEY]: {
          decision: 'deny',
          decidedBy: 'anonymous:local',
          decidedAt: DECIDED_AT,
          reason: 'Check the carrier’s claim first.',
          asked: 'Refund order 4398 for $27.25',
        },
      }),
    ).toEqual({
      outcome: 'denied',
      decidedBy: 'anonymous:local',
      decidedAt: Date.parse(DECIDED_AT),
      reason: 'Check the carrier’s claim first.',
      asked: 'Refund order 4398 for $27.25',
    });
  });

  test('reads a rejection as a refusal, and an approval as approved', () => {
    expect(
      recordedDecision({ [APPROVAL_DECISION_METADATA_KEY]: { ...APPROVED, decision: 'reject' } })
        ?.outcome,
    ).toBe('denied');
    expect(recordedDecision({ [APPROVAL_DECISION_METADATA_KEY]: APPROVED })?.outcome).toBe(
      'approved',
    );
  });

  test.each([
    ['no record', undefined],
    ['a record that is not an object', { [APPROVAL_DECISION_METADATA_KEY]: 'yes' }],
    [
      'an unknown decision',
      { [APPROVAL_DECISION_METADATA_KEY]: { ...APPROVED, decision: 'maybe' } },
    ],
    ['no decider', { [APPROVAL_DECISION_METADATA_KEY]: { ...APPROVED, decidedBy: undefined } }],
    [
      'a time that is not a date',
      { [APPROVAL_DECISION_METADATA_KEY]: { ...APPROVED, decidedAt: 'soon' } },
    ],
  ])('says nothing for %s', (_label, metadata) => {
    expect(recordedDecision(metadata)).toBeUndefined();
  });

  test('keeps no empty note', () => {
    expect(
      recordedDecision({ [APPROVAL_DECISION_METADATA_KEY]: { ...APPROVED, reason: '  ' } }),
    ).not.toHaveProperty('reason');
  });
});

describe('a call whose approval a person decided', () => {
  test('carries the decision from its outcome row', () => {
    expect(entryDecided(APPROVED).decision?.outcome).toBe('approved');
    expect(entryDecided(undefined).decision).toBeUndefined();
  });

  test('reads on the rail as approved, with who decided, when and what it returned', () => {
    const entry = entryDecided(APPROVED);
    const call = railCall(entry, false, { owner: 'anonymous:local', zone: 'America/Chicago' });
    expect(call.status).toBe('approved');
    expect(call.decision).toBe('Approved by you 10:46 AM · refunded 4200');
  });

  test('says where when the page watched it decided on another page', () => {
    const entry = entryDecided(APPROVED);
    const context = {
      owner: 'anonymous:local',
      elsewhere: new Set([entry.callId]),
      zone: 'America/Chicago',
    };
    expect(railCall(entry, false, context).decision).toBe(
      'Approved by you in Reviews 10:46 AM · refunded 4200',
    );
  });

  test('says the run is running in place of the result while the run a decision in Reviews continues is going (18i)', () => {
    const entry = entryDecided(APPROVED);
    const context = {
      owner: 'anonymous:local',
      elsewhere: new Set([entry.callId]),
      zone: 'America/Chicago',
    };
    expect(railCall(entry, false, { ...context, continuing: true }).decision).toBe(
      'Approved by you in Reviews 10:46 AM · running…',
    );
    // A decision made in the chat itself, or a run that is not going, keeps the result.
    expect(
      railCall(entry, false, {
        owner: 'anonymous:local',
        zone: 'America/Chicago',
        continuing: true,
      }).decision,
    ).toBe('Approved by you 10:46 AM · refunded 4200');
    expect(railCall(entry, false, { ...context, continuing: false }).decision).toBe(
      'Approved by you in Reviews 10:46 AM · refunded 4200',
    );
  });

  test('reads a refusal as denied and neutral, with no claim about what it came to', () => {
    const entry = entryDecided(
      { ...APPROVED, decision: 'deny', reason: 'Check the carrier’s claim first.' },
      'error',
      'Tool call denied: Check the carrier’s claim first.',
    );
    const call = railCall(entry, false, { owner: 'anonymous:local', zone: 'America/Chicago' });
    expect(call.status).toBe('denied');
    expect(call.decision).toBe('Denied by you 10:46 AM');
  });

  test('names a decider that is not the chat’s person', () => {
    const entry = entryDecided({ ...APPROVED, decidedBy: 'api-key:ci' });
    expect(decidedByLabel(entry.decision!, 'anonymous:local')).toBe('api-key:ci');
    // A chat that has no owner of record names the principal too, since "you" would be a guess.
    expect(decidedByLabel(entry.decision!, null)).toBe('api-key:ci');
    expect(decidedLine(entry, { owner: 'anonymous:local', zone: 'America/Chicago' })).toContain(
      'by api-key:ci',
    );
  });

  test('a call with no record of a decision reads as it did before', () => {
    const call = railCall(entryDecided(undefined), false, { owner: 'anonymous:local' });
    expect(call.status).toBe('done');
    expect(call).not.toHaveProperty('decision');
  });
});

import { describe, expect, test } from 'bun:test';

import type { AuditRecord } from '../../lib/bureau-audit.ts';
import type { BureauToolApproval } from '../../lib/bureau-reviews.ts';
import {
  callLabelOf,
  describeRecord,
  describeRecords,
  LONG_TARGET_CHARACTERS,
  lookupRequestsFor,
  NO_LOOKUPS,
  type AuditLookups,
} from './audit-events.ts';
import { changedWords, detailOf } from './audit-facts.ts';

const NOW = Date.parse('2026-11-02T17:00:00.000Z');

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

const LOOKUPS: AuditLookups = {
  ...NO_LOOKUPS,
  scheduleNames: new Map([['s-1', 'Daily summary']]),
  memories: new Map([['m-1', 'prefers long summaries']]),
};

function worded(overrides: Partial<AuditRecord> & { type: string }, lookups = LOOKUPS) {
  const event = describeRecord(record(overrides), lookups);
  if (event === undefined) throw new Error(`${overrides.type} is not an event`);
  return event;
}

describe('the words of each kind of record', () => {
  test('a schedule record names the schedule, or says a schedule when none is known', () => {
    const kinds: [string, string][] = [
      ['schedule.fired', 'Started a scheduled run'],
      ['schedule.created', 'Created a schedule'],
      ['schedule.paused', 'Paused a schedule'],
      ['schedule.resumed', 'Resumed a schedule'],
      ['schedule.cancelled', 'Canceled a schedule'],
    ];
    for (const [type, action] of kinds) {
      const event = worded({ type, resource: 'schedule:s-1', detail: { scheduleId: 's-1' } });
      expect(event.action).toBe(action);
      expect(event.target).toBe('Daily summary');
    }
    const unknown = worded({ type: 'schedule.paused', resource: 'schedule:s-9' });
    expect(unknown.target).toBe('A schedule');
  });

  test('missed runs are counted, and one is singular', () => {
    expect(
      worded({ type: 'schedule.missed', detail: { scheduleId: 's-1', missedCount: 3 } }).action,
    ).toBe('Noticed 3 missed runs');
    expect(worded({ type: 'schedule.missed', detail: { scheduleId: 's-1' } }).action).toBe(
      'Noticed 1 missed run',
    );
  });

  test('an approved or denied call names the tool and what it was about', () => {
    const review = {
      approval: {
        callId: 'c1',
        toolName: 'issue-refund',
        arguments: { orderId: '4471' },
        action: { type: 'approval', message: 'Refund order 4471?', risk: 'high' },
      },
      status: 'approved',
      sessionId: 'chat-1',
    } as unknown as BureauToolApproval;
    const lookups: AuditLookups = {
      ...LOOKUPS,
      reviews: new Map([['approval:run-1:c1', review]]),
      tools: new Map([['issue-refund', { title: 'Issue refund', tier: 'dangerous' }]]),
    };
    const detail = { toolName: 'issue-refund', toolCallId: 'c1' };
    const approved = worded({ type: 'review.tool-approval.approved', detail }, lookups);
    expect(approved.action).toBe('Approved a tool call');
    expect(approved.target).toBe('Issue refund · order 4471');
    expect(worded({ type: 'review.tool-approval.denied', detail }, lookups).action).toBe(
      'Denied a tool call',
    );
    // Without its review the call has only the tool to name.
    expect(worded({ type: 'review.tool-approval.denied', detail }).target).toBe(
      'Issue refund',
    );
  });

  test('a memory is quoted when it is known and falls back to the agent', () => {
    expect(worded({ type: 'memory.forgotten', detail: { memoryId: 'm-1' } }).target).toBe(
      '“prefers long summaries”',
    );
    expect(worded({ type: 'memory.forgotten', detail: { agentName: 'writer' } }).target).toBe(
      'Writer',
    );
    expect(worded({ type: 'memory.corrected' }).target).toBe('');
  });

  test('definitions, hooks, chats, storage, sources and settings read as what was done', () => {
    const cases: [Partial<AuditRecord> & { type: string }, string, string][] = [
      [
        {
          type: 'agent.updated',
          resource: 'agent:writer',
          detail: { revision: 3, previousRevision: 2 },
        },
        'Edited an agent',
        'Writer · version 2 → 3',
      ],
      [
        { type: 'agent.updated', resource: 'agent:writer', detail: { revision: 1 } },
        'Edited an agent',
        'Writer · version 1',
      ],
      [
        { type: 'workflow.created', resource: 'workflow:daily-report' },
        'Created a workflow',
        'Daily report',
      ],
      [
        { type: 'workflow.updated', resource: 'workflow:daily-report' },
        'Edited a workflow',
        'Daily report',
      ],
      [{ type: 'hook.created', detail: { hookId: 'h-1' } }, 'Created a hook', 'h-1'],
      [{ type: 'hook.updated', resource: 'hook:h-2' }, 'Edited a hook', 'hook:h-2'],
      [{ type: 'session.deleted' }, 'Deleted a chat', 'Chat'],
      [
        { type: 'storage.key.deleted', resource: 'storage:notes/a' },
        'Deleted a storage key',
        'Storage › notes/a',
      ],
      [
        { type: 'tool.source.connected', detail: { sourceId: 'files' } },
        'Connected a tool source',
        'files',
      ],
      [
        { type: 'tool.source.removed', resource: 'tool-source:files' },
        'Removed a tool source',
        'files',
      ],
      [
        { type: 'skill.source.trusted', detail: { sourceId: 'docs' } },
        'Changed what a skill source may do',
        'docs',
      ],
      [
        { type: 'skill.source.trusted', resource: 'skill-source:x' },
        'Changed what a skill source may do',
        'skill-source:x',
      ],
      [
        { type: 'settings.changed', resource: 'settings:theme' },
        'Changed a setting',
        'settings:theme',
      ],
      [
        { type: 'webhook.delivery.exhausted', detail: { hookId: 'h-1' } },
        'Gave up delivering a hook',
        'h-1',
      ],
      [
        { type: 'webhook.delivery.exhausted', resource: 'hook:h-3' },
        'Gave up delivering a hook',
        'hook:h-3',
      ],
    ];
    for (const [overrides, action, target] of cases) {
      const event = worded(overrides);
      expect([overrides.type, event.action, event.target]).toEqual([
        overrides.type,
        action,
        target,
      ]);
    }
  });

  test('a run names the chat only for the newest run of that chat', () => {
    const lookups: AuditLookups = { ...LOOKUPS, chatTitles: new Map([['chat-1', 'Refund it']]) };
    const older = record({
      type: 'run.started',
      sequence: 1,
      timestamp: '2026-11-02T10:00:00.000Z',
      detail: { sessionId: 'chat-1', agentName: 'writer' },
    });
    const newer = record({
      type: 'run.started',
      sequence: 2,
      timestamp: '2026-11-02T11:00:00.000Z',
      detail: { sessionId: 'chat-1', agentName: 'writer' },
    });
    const events = describeRecords([newer, older], lookups);
    expect(events.map((event) => event.target)).toEqual(['Chat › Refund it', 'Writer']);
    const failed = describeRecords(
      [
        record({ type: 'run.error', detail: { agentName: 'writer' } }),
        record({ type: 'run.aborted' }),
      ],
      lookups,
    );
    expect(failed.map((event) => [event.action, event.target])).toEqual([
      ['A run failed', 'Writer'],
      ['Stopped a run', 'run-1'],
    ]);
  });
});

describe('a call label', () => {
  test('arguments that name no identifier, or are not an object, leave no label', () => {
    const withArguments = (args: unknown) =>
      ({ approval: { arguments: args } }) as unknown as BureauToolApproval;
    expect(callLabelOf(withArguments(['orderId']))).toBeUndefined();
    expect(callLabelOf(withArguments({ orderId: {}, note: 'x' }))).toBeUndefined();
    expect(callLabelOf(withArguments({ orderId: 12 }))).toBe('order 12');
    expect(callLabelOf(withArguments({ customerAccountId: 'a-1' }))).toBe('customer account a-1');
  });
});

describe('the pane of each kind of record', () => {
  test('a schedule event links to its schedule', () => {
    const event = worded({
      type: 'schedule.paused',
      resource: 'schedule:s-1',
      detail: { scheduleId: 's-1' },
    });
    const model = detailOf(event, LOOKUPS, NOW);
    expect(model.facts).toHaveLength(1);
    expect(model.facts[0]?.value).toMatchObject({ kind: 'link', text: 'Daily summary' });
  });

  test('a memory event links to the agent that wrote it, when one is named', () => {
    const named = detailOf(
      worded({ type: 'memory.forgotten', detail: { agentName: 'writer', memoryId: 'm-1' } }),
      LOOKUPS,
      NOW,
    );
    expect(named.facts).toHaveLength(1);
    expect(named.facts[0]?.value).toMatchObject({ kind: 'link', text: 'Writer' });
    expect(
      detailOf(worded({ type: 'memory.forgotten', detail: { memoryId: 'm-1' } }), LOOKUPS, NOW)
        .facts,
    ).toEqual([]);
  });

  test('an event about a thing says what it was about, and a long target is no fact', () => {
    const short = detailOf(
      worded({ type: 'settings.changed', resource: 'settings:theme' }),
      LOOKUPS,
      NOW,
    );
    expect(short.facts).toHaveLength(1);
    expect(short.facts[0]?.value).toMatchObject({ text: 'settings:theme' });
    const key = 'k'.repeat(LONG_TARGET_CHARACTERS + 1);
    const long = detailOf(
      worded({ type: 'storage.key.deleted', resource: `storage:${key}` }),
      LOOKUPS,
      NOW,
    );
    expect(long.facts).toEqual([]);
    const started = detailOf(
      worded({ type: 'host.started', principal: 'system:host' }),
      LOOKUPS,
      NOW,
    );
    expect(started.facts).toEqual([]);
  });

  test('a run names its agent and chat and links to the run', () => {
    const lookups: AuditLookups = { ...LOOKUPS, chatTitles: new Map([['chat-1', 'Refund it']]) };
    const model = detailOf(
      worded(
        {
          type: 'run.started',
          resource: 'run-1',
          detail: { agentName: 'writer', sessionId: 'chat-1' },
        },
        lookups,
      ),
      lookups,
      NOW,
    );
    expect(model.facts.map((fact) => fact.value)).toEqual([
      expect.objectContaining({ kind: 'link', text: 'Writer' }),
      expect.objectContaining({ kind: 'link', text: 'Refund it' }),
    ]);
  });
});

describe('what a version changed', () => {
  test('unknown keys are humanized and tools added and removed are named', () => {
    const name = (identifier: string) => identifier.toUpperCase();
    expect(changedWords(undefined, undefined, undefined, name)).toBe('');
    const words = changedWords('instructions, , someNewKey', 'a, b', 'c', name);
    expect(words).toContain('Some new key');
    expect(words).toContain('A, B');
    expect(words).toContain('C');
  });
});

describe('what the records ask the page to look up', () => {
  test('a run asks for its chat, a schedule for its name', () => {
    const requests = lookupRequestsFor([
      record({ type: 'run.started', detail: { sessionId: 'chat-1' } }),
      record({ type: 'schedule.created', resource: 'schedule:s-1', detail: { scheduleId: 's-1' } }),
      record({ type: 'who.knows', detail: { sessionId: 'ignored' } }),
    ]);
    expect(requests.sessionIds).toEqual(['chat-1']);
    expect(requests.scheduleIds).toContain('s-1');
  });
});

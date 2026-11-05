/**
 * What a schedule's page says, worked out without a DOM (COR-2018): the line under the heading,
 * why Run now is off, the card's When rows and viewer-zone sentence, and the input a schedule sends.
 */
import { describe, expect, test } from 'bun:test';

import type { ScheduleSummary } from '@lostgradient/weft';

import type { WorkflowFileListing } from '../../lib/workflow-files.ts';
import {
  isFileDefined,
  jsonProblemLine,
  lineOfParseError,
  nextSummary,
  problemLocation,
  runNowOffReason,
  scheduleInput,
  sentenceCadence,
  startedAgo,
  triggerInput,
  whenRows,
} from './schedule-detail-model.ts';

// Monday, Nov 2, 2026, 10:46 AM in Central time.
const NOW = Date.parse('2026-11-02T16:46:00.000Z');

function schedule(overrides: Partial<ScheduleSummary> = {}): ScheduleSummary {
  return {
    id: 'daily',
    workflowType: 'agentRun',
    status: 'active',
    cronExpression: '0 9 * * *',
    timeZone: 'UTC',
    overlap: 'skip',
    backfill: false,
    revisionPolicy: 'active-at-fire',
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
    missedFireCount: 0,
    skippedCount: 0,
    nextFireAt: Date.parse('2026-11-03T09:00:00.000Z'),
    queuedRuns: [],
    ...overrides,
  };
}

function file(trigger: Record<string, unknown> | null): WorkflowFileListing {
  return { id: 'digest', state: 'ready', trigger } as unknown as WorkflowFileListing;
}

describe('startedAgo (row 73e)', () => {
  test('spells out the seconds of a run that has just started, then its minutes and hours', () => {
    expect(startedAgo(NOW - 38_000, NOW)).toBe('38 seconds ago');
    expect(startedAgo(NOW - 1_000, NOW)).toBe('1 second ago');
    expect(startedAgo(NOW - 5 * 60_000, NOW)).toBe('5 minutes ago');
    expect(startedAgo(NOW - 2 * 3_600_000, NOW)).toBe('2 hours ago');
  });

  test('never reads the future when the clocks differ by a moment', () => {
    expect(startedAgo(NOW + 2_000, NOW)).toBe('0 seconds ago');
  });
});

describe('nextSummary', () => {
  test('says when it runs next with how far away that is', () => {
    const parts = nextSummary(schedule(), { status: 'active', blockers: [] }, NOW);

    expect(parts).toHaveLength(1);
    expect(parts[0]?.text).toMatch(/^Next [A-Z][a-z]{2} Nov 3, .* \(in \d+ hours\)$/);
  });

  test('says there is no next run while paused, and for a schedule that has none', () => {
    expect(nextSummary(schedule(), { status: 'paused', blockers: [] }, NOW)).toEqual([
      { text: 'No next run while paused' },
    ]);
    expect(
      nextSummary(schedule({ nextFireAt: null }), { status: 'active', blockers: [] }, NOW),
    ).toEqual([{ text: 'No next run' }]);
  });

  test('says a run that is due and will not start as due, with “won’t start” in amber', () => {
    const due = nextSummary(
      schedule({ nextFireAt: NOW + 14 * 60_000 }),
      { status: 'active', blockers: [{ kind: 'provider' }] },
      NOW,
    );

    // The clock is the viewer's, so the words are checked and not the hour.
    expect(due).toHaveLength(2);
    expect(due[0]?.text).toMatch(/^Due (today, )?.* \(in 14 minutes\)$/);
    expect(due[1]).toEqual({ text: 'won’t start', tone: 'warning' });
  });
});

describe('runNowOffReason', () => {
  test('is null when nothing keeps the schedule from starting', () => {
    expect(runNowOffReason({ allBlockers: [] })).toBeNull();
  });

  test('says each reason in order: the workflow first, then the provider', () => {
    expect(
      runNowOffReason({
        allBlockers: [
          { kind: 'cannot-load', workflowType: 'order-refund', label: 'Order refund' },
          { kind: 'provider' },
        ],
      }),
    ).toBe('Order refund can’t load. No model provider is connected.');
    expect(
      runNowOffReason({ allBlockers: [{ kind: 'deleted', workflowType: 'weekly-cleanup' }] }),
    ).toBe('weekly-cleanup was deleted.');
  });
});

describe('the cadence in the sentence and the card', () => {
  test('is lower case after Runs, and says the time of day', () => {
    expect(sentenceCadence(schedule(), NOW)).toMatch(/^every day at \d{1,2}:\d{2} [AP]M/);
  });

  test('says a cadence with no clock time as a cron, as it always has', () => {
    expect(sentenceCadence(schedule({ cronExpression: '*/7 9 * * 1-5' }), NOW)).toBe(
      'on cron */7 9 * * 1-5',
    );
  });

  test('When rows are the New schedule form’s own', () => {
    expect(whenRows(schedule())).toEqual([
      { label: 'Repeats', value: 'Every day' },
      { label: 'At', value: '9:00 AM' },
      { label: 'Time zone', value: 'UTC' },
    ]);
  });
});

describe('the input a schedule sends', () => {
  test('a chat is its message, as one field and as JSON', () => {
    expect(scheduleInput(schedule(), 'Summarize yesterday’s chats.', undefined)).toEqual({
      fields: [{ label: 'Message', value: 'Summarize yesterday’s chats.' }],
      payload: { message: 'Summarize yesterday’s chats.' },
    });
  });

  test('a chat the Bureau says no message of has no input to show', () => {
    expect(scheduleInput(schedule(), undefined, undefined)).toBeUndefined();
  });

  test('a file’s trigger sends its values, labelled in sentence case', () => {
    const input = scheduleInput(
      schedule({ workflowType: 'digest' }),
      undefined,
      file({ input: { branch: 'main', sinceDate: '2026-10-01', draft: true, depth: 2 } }),
    );

    expect(input?.fields).toEqual([
      { label: 'Branch', value: 'main' },
      { label: 'Since date', value: '2026-10-01' },
      { label: 'Draft', value: 'Yes' },
      { label: 'Depth', value: '2' },
    ]);
  });

  test('a workflow with no input has none to show', () => {
    expect(
      scheduleInput(schedule({ workflowType: 'triage' }), undefined, file({})),
    ).toBeUndefined();
    expect(
      scheduleInput(schedule({ workflowType: 'triage' }), undefined, undefined),
    ).toBeUndefined();
  });
});

describe('a schedule a file defines', () => {
  test('is one whose trigger fixes the values it sends', () => {
    expect(isFileDefined(file({ input: { branch: 'main' } }))).toBe(true);
    expect(isFileDefined(file({ kind: 'schedule' }))).toBe(false);
    expect(isFileDefined(file(null))).toBe(false);
    expect(triggerInput(file({ input: ['not', 'an', 'object'] }))).toBeUndefined();
  });
});

describe('nextSummary while the page shows old data', () => {
  test('drops the relative time, which it could not keep, and the rest stays', () => {
    const parts = nextSummary(schedule(), { status: 'active', blockers: [] }, NOW, true);

    expect(parts).toHaveLength(1);
    expect(parts[0]?.text).toMatch(/^Next [A-Z][a-z]{2} Nov 3, .*[AP]M$/);
    expect(parts[0]?.text).not.toContain('(in ');
  });

  test('says a run that is due and will not start without how long until it', () => {
    const due = schedule({ nextFireAt: Date.parse('2026-11-02T17:00:00.000Z') });
    const parts = nextSummary(
      due,
      { status: 'active', blockers: [{ kind: 'provider' }] },
      NOW,
      true,
    );

    expect(parts.map((part) => part.text)).toEqual([
      expect.stringMatching(/^Due today, .*[AP]M$/),
      'won’t start',
    ]);
  });
});

describe('where a workflow file stopped parsing', () => {
  test('reads the line a parser names, or counts the lines before the position it names', () => {
    expect(lineOfParseError('Expected ‘,’ in JSON at line 12 column 3', '')).toBe(12);
    expect(lineOfParseError('Unexpected token in JSON at position 6', 'a\nb\nc\nd')).toBe(4);
    expect(lineOfParseError("JSON Parse error: Expected '}'", '{}')).toBeUndefined();
  });

  test('is none for text that parses, and a number or nothing for text that does not', () => {
    expect(jsonProblemLine('{"a": 1}')).toBeUndefined();
    const line = jsonProblemLine('{\n  "a": 1\n  "b": 2\n}');
    expect(line === undefined || line >= 1).toBe(true);
  });

  test('says the file and the line, or the type alone when no line is known', () => {
    expect(problemLocation('order-refund', 12)).toBe('order-refund · order-refund.json line 12');
    expect(problemLocation('order-refund', undefined)).toBe('order-refund');
  });
});

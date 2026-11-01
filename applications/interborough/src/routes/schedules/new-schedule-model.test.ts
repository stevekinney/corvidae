import { describe, expect, test } from 'bun:test';

import { SCHEDULE_COPY } from '../../app/copy.ts';
import type { CatalogRow } from '../../lib/workflow-catalog.ts';
import {
  agentScheduleInput,
  draftErrors,
  emptyDraft,
  emptyInputOf,
  engineScheduleArgs,
  isDraftValid,
  optionMatches,
  recentTypes,
  summaryOf,
  takesNoInput,
  workflowLabel,
  workflowOptions,
  type NewScheduleDraft,
} from './new-schedule-model.ts';

const COPY = SCHEDULE_COPY.create;

function row(name: string, overrides: Partial<CatalogRow> = {}): CatalogRow {
  return {
    name,
    kind: 'code',
    agent: null,
    description: `The ${name} workflow.`,
    engine: false,
    runs: null,
    trigger: null,
    file: null,
    problem: null,
    failure: null,
    ...overrides,
  };
}

function chatDraft(overrides: Partial<NewScheduleDraft> = {}): NewScheduleDraft {
  return {
    ...emptyDraft(),
    workflowType: 'agentRun',
    agentName: 'reporter',
    message: 'Send the report',
    cadence: { cron: '0 9 * * 1-5', timeZone: 'America/Los_Angeles' },
    ...overrides,
  };
}

function workflowDraft(overrides: Partial<NewScheduleDraft> = {}): NewScheduleDraft {
  return {
    ...emptyDraft(),
    workflowType: 'report-gen',
    cadence: { cron: '0 2 * * *', timeZone: 'UTC' },
    ...overrides,
  };
}

describe('workflowOptions', () => {
  test('lists the built-in chat first, then Recent in the order of the newest schedules, then the rest by name', () => {
    const options = workflowOptions(
      [row('alpha'), row('beta'), row('gamma'), row('delta')],
      ['gamma', 'beta'],
    );
    expect(options.map((option) => [option.group, option.value])).toEqual([
      [COPY.groups.builtIn, 'agentRun'],
      [COPY.groups.recent, 'gamma'],
      [COPY.groups.recent, 'beta'],
      [COPY.groups.all, 'alpha'],
      [COPY.groups.all, 'delta'],
    ]);
  });

  test('holds at most three workflows under Recent', () => {
    const rows = ['a', 'b', 'c', 'd'].map((name) => row(name));
    const options = workflowOptions(rows, ['a', 'b', 'c', 'd']);
    expect(options.filter((option) => option.group === COPY.groups.recent)).toHaveLength(3);
    expect(options.find((option) => option.value === 'd')?.group).toBe(COPY.groups.all);
  });

  test('names a workflow in words, and describes it', () => {
    const [, option] = workflowOptions([row('order-processing')], []);
    expect(option).toMatchObject({
      value: 'order-processing',
      label: 'Order Processing',
      description: 'The order-processing workflow.',
    });
  });

  test('describes a workflow with no description by its identifier', () => {
    const [, option] = workflowOptions([row('plain', { description: null })], []);
    expect(option?.description).toBe('plain');
  });

  test('lists an agent-authored workflow disabled with the reason, and leaves out the types the Bureau runs itself', () => {
    const options = workflowOptions(
      [row('digest', { kind: 'agent-authored' }), row('agentRun', { engine: true })],
      [],
    );
    expect(options.map((option) => option.value)).toEqual(['agentRun', 'digest']);
    expect(options[0]?.label).toBe(COPY.chat.label);
    expect(options[1]).toMatchObject({ disabled: true, description: COPY.inFile });
  });
});

describe('optionMatches', () => {
  const [, option] = workflowOptions([row('order-processing')], []);

  test('matches the words, the identifier and the description, ignoring case', () => {
    for (const query of ['order processing', 'ORDER-PRO', 'the order', '  order  ', '']) {
      expect(optionMatches(option!, query), query).toBe(true);
    }
  });

  test('does not match anything else', () => {
    expect(optionMatches(option!, 'invoice')).toBe(false);
  });
});

describe('recentTypes', () => {
  test('is the type of each of the newest schedules, newest first, once each', () => {
    expect(
      recentTypes([
        { workflowType: 'a', createdAt: 1 },
        { workflowType: 'b', createdAt: 3 },
        { workflowType: 'a', createdAt: 2 },
      ]),
    ).toEqual(['b', 'a']);
  });
});

describe('workflowLabel', () => {
  test('names the built-in chat and humanizes a type', () => {
    expect(workflowLabel('agentRun')).toBe(COPY.chat.label);
    expect(workflowLabel('inventory-sync-sweep')).toBe('Inventory Sync Sweep');
  });
});

describe('draftErrors', () => {
  test('asks for a workflow first', () => {
    expect(draftErrors(emptyDraft())).toEqual({ workflowType: COPY.workflowRequired });
    expect(isDraftValid(emptyDraft())).toBe(false);
  });

  test('asks a chat for an agent and a message', () => {
    expect(draftErrors(chatDraft({ agentName: ' ', message: '' }))).toEqual({
      agentName: SCHEDULE_COPY.form.agentRequired,
      message: SCHEDULE_COPY.form.inputRequired,
    });
    expect(isDraftValid(chatDraft())).toBe(true);
  });

  test('refuses a message or a description that is too long', () => {
    expect(draftErrors(chatDraft({ message: 'x'.repeat(100_001) })).message).toBe(
      SCHEDULE_COPY.form.inputTooLong,
    );
    expect(draftErrors(chatDraft({ description: 'x'.repeat(2_001) })).description).toBe(
      SCHEDULE_COPY.form.descriptionTooLong(2_000),
    );
  });

  test('refuses an overlap of allow for a chat that continues a chat, which the Bureau refuses', () => {
    expect(draftErrors(chatDraft({ chatId: 'chat-1', overlap: 'allow' })).chat).toBe(
      SCHEDULE_COPY.form.sessionWithAllow,
    );
    expect(draftErrors(chatDraft({ overlap: 'allow' })).chat).toBeUndefined();
  });

  test('holds a workflow’s jitter to a duration, and a chat to none', () => {
    expect(draftErrors(workflowDraft({ jitterText: 'soon' })).jitter).toBeDefined();
    expect(draftErrors(workflowDraft({ jitterText: ' 30s ' })).jitter).toBeUndefined();
    expect(draftErrors(chatDraft({ jitterText: 'soon' })).jitter).toBeUndefined();
  });
});

describe('agentScheduleInput', () => {
  test('sends a cron schedule in the zone it is read in', () => {
    expect(agentScheduleInput(chatDraft({ description: '  Daily  ', chatId: 'chat-1' }))).toEqual({
      agentName: 'reporter',
      spec: '0 9 * * 1-5',
      input: 'Send the report',
      overlap: 'skip',
      description: 'Daily',
      sessionId: 'chat-1',
      timeZone: 'America/Los_Angeles',
    });
  });

  test('sends an interval as a duration, in no zone', () => {
    const input = agentScheduleInput(
      chatDraft({
        cadence: { every: { unit: 'hours', count: 7 }, timeZone: 'America/Los_Angeles' },
      }),
    );
    expect(input.spec).toBe('7h');
    expect(input).not.toHaveProperty('timeZone');
    expect(input).not.toHaveProperty('sessionId');
  });

  test('reads an overlap the Bureau has no word for as skip', () => {
    expect(agentScheduleInput(chatDraft({ overlap: 'queue' })).overlap).toBe('skip');
    expect(agentScheduleInput(chatDraft({ overlap: 'allow' })).overlap).toBe('allow');
  });
});

describe('engineScheduleArgs', () => {
  test('omits the description and jitter when both are blank', () => {
    expect(engineScheduleArgs(workflowDraft(), { day: 'today' })).toEqual({
      workflowType: 'report-gen',
      input: { day: 'today' },
      spec: { cron: '0 2 * * *' },
      timeZone: 'UTC',
      overlap: 'skip',
      backfill: false,
      revisionPolicy: 'active-at-fire',
    });
  });

  test('sends the trimmed description and jitter, and the options as chosen', () => {
    const args = engineScheduleArgs(
      workflowDraft({
        description: '  Nightly  ',
        jitterText: '  30s  ',
        overlap: 'cancel-running',
        backfill: true,
        revisionPolicy: 'pinned',
        cadence: { every: { unit: 'minutes', count: 5 }, timeZone: 'UTC' },
      }),
      undefined,
    );
    expect(args).toEqual({
      workflowType: 'report-gen',
      input: undefined,
      spec: { every: 300_000 },
      overlap: 'cancel-running',
      backfill: true,
      revisionPolicy: 'pinned',
      description: 'Nightly',
      jitter: '30s',
    });
  });

  test('is made in the zone that was chosen, and an interval in none', () => {
    expect(
      engineScheduleArgs(
        workflowDraft({ cadence: { cron: '0 9 * * 1-5', timeZone: 'Asia/Tokyo' } }),
        {},
      ),
    ).toMatchObject({ spec: { cron: '0 9 * * 1-5' }, timeZone: 'Asia/Tokyo' });
    expect(
      engineScheduleArgs(
        workflowDraft({ cadence: { every: { unit: 'hours', count: 7 }, timeZone: 'Asia/Tokyo' } }),
        {},
      ),
    ).not.toHaveProperty('timeZone');
  });
});

describe('summaryOf', () => {
  test('says to choose a workflow before one is chosen', () => {
    expect(summaryOf(emptyDraft())).toBe(COPY.summaryNothing);
  });

  test('says what a chat and a workflow will do, in the zone they will do it', () => {
    expect(summaryOf(chatDraft())).toContain('reporter');
    expect(summaryOf(chatDraft())).toContain('America/Los_Angeles');
    expect(summaryOf(workflowDraft())).toContain('Report Gen');
  });

  test('names no zone for an interval', () => {
    const summary = summaryOf(
      workflowDraft({ cadence: { every: { unit: 'hours', count: 6 }, timeZone: 'Asia/Tokyo' } }),
    );
    expect(summary).not.toContain('Asia/Tokyo');
  });
});

describe('takesNoInput and emptyInputOf', () => {
  const NO_FIELDS = { type: 'object', properties: {}, additionalProperties: false };

  test('only a schema that says it takes no input does, and not a missing or open one', () => {
    expect(takesNoInput(undefined)).toBe(false);
    expect(takesNoInput({})).toBe(false);
    expect(takesNoInput({ type: 'object', properties: {} })).toBe(false);
    expect(takesNoInput({ type: 'object', properties: { a: { type: 'string' } } })).toBe(false);
    expect(takesNoInput({ type: 'null' })).toBe(true);
    expect(takesNoInput(NO_FIELDS)).toBe(true);
    expect(takesNoInput({ type: 'object', additionalProperties: false })).toBe(true);
  });

  test('sends the empty value the schema accepts: null for null, an empty object otherwise', () => {
    expect(emptyInputOf({ type: 'null' })).toBeNull();
    expect(emptyInputOf(NO_FIELDS)).toEqual({});
  });
});

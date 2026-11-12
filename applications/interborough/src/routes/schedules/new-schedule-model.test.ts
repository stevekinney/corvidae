/**
 * What the new schedule page decides outside the page (COR-2018, rows 74a–75o): the picker's
 * groups, the draft's problems, the name a schedule starts with, the two requests a valid draft
 * becomes, the name that is taken, and the footer line with the order of what it says first.
 */
import { describe, expect, test } from 'bun:test';

import { SCHEDULE_COPY } from '../../app/copy/schedules.ts';
import { AGENT_RUN_TYPE } from '../../lib/schedule-kinds.ts';
import type { CatalogRow } from '../../lib/workflow-catalog.ts';
import {
  agentScheduleInput,
  defaultNameOf,
  draftErrors,
  emptyDraft,
  emptyInputOf,
  engineScheduleArgs,
  footerLineOf,
  isDraftStarted,
  isDraftValid,
  optionMatches,
  recentTypes,
  scheduleTargetOf,
  takenNameOf,
  takesNoInput,
  workflowOptions,
  type FooterState,
  type NewScheduleDraft,
} from './new-schedule-model.ts';

const COPY = SCHEDULE_COPY.create;

function row(name: string, overrides: Partial<CatalogRow> = {}): CatalogRow {
  return {
    name,
    kind: 'code',
    agent: null,
    description: `${name} description`,
    engine: false,
    runs: null,
    trigger: null,
    file: null,
    problem: null,
    failure: null,
    ...overrides,
  };
}

function fileRow(name: string, state: 'ready' | 'invalid', paused = false): CatalogRow {
  return row(name, {
    kind: 'agent-authored',
    description: 'Sorts new messages.',
    file: {
      id: name,
      state,
      owner: 'o',
      hash: 'h',
      title: 'Triage inbox',
      description: 'Sorts new messages.',
      agent: null,
      paused,
      inputSchema: null,
      outputSchema: null,
      version: null,
      trigger: null,
      problem: null,
      runs: null,
    },
  });
}

function chatDraft(overrides: Partial<NewScheduleDraft> = {}): NewScheduleDraft {
  return {
    ...emptyDraft(),
    workflowType: AGENT_RUN_TYPE,
    agentName: 'Assistant',
    message: 'Summarize yesterday’s chats and open reviews.',
    name: 'Daily summary',
    ...overrides,
  };
}

describe('workflowOptions', () => {
  test('lists the chat under Built in, then Recent in the order of the newest schedules, then All workflows by name', () => {
    const options = workflowOptions(
      [row('release-notes'), row('order-refund'), row('triage-inbox'), row('a-sweep')],
      ['order-refund', 'release-notes'],
    );
    expect(options.map((option) => [option.group, option.label])).toEqual([
      [COPY.groups.builtIn, COPY.chat.label],
      [COPY.groups.recent, 'Order refund'],
      [COPY.groups.recent, 'Release notes'],
      [COPY.groups.all, 'A sweep'],
      [COPY.groups.all, 'Triage inbox'],
    ]);
    expect(options[0]?.description).toBe('Send a message to an agent each time it runs.');
  });

  test('offers a workflow file that loads as one to choose, by the title its file gives, and never a type the Bureau runs for itself', () => {
    const options = workflowOptions(
      [fileRow('triage-inbox', 'ready', true), row(AGENT_RUN_TYPE, { engine: true })],
      [],
    );
    expect(options.map((option) => option.label)).toEqual([COPY.chat.label, 'Triage inbox']);
    expect(options[1]).not.toHaveProperty('disabled');
    expect(options[1]?.description).toBe('Sorts new messages.');
  });

  test('lists a file that cannot load under All workflows, disabled, with the reason in danger text', () => {
    const [, broken] = workflowOptions([fileRow('order-refund', 'invalid')], ['order-refund']);
    expect(broken).toMatchObject({
      group: COPY.groups.all,
      disabled: true,
      description: COPY.cannotLoad,
      descriptionTone: 'danger',
    });
  });

  test('matches by label, identifier or description, ignoring case', () => {
    const [chat] = workflowOptions([], []);
    if (chat === undefined) throw new Error('expected the chat option');
    expect(optionMatches(chat, 'CHAT')).toBe(true);
    expect(optionMatches(chat, 'each time')).toBe(true);
    expect(optionMatches(chat, 'refnud')).toBe(false);
    expect(optionMatches(chat, '  ')).toBe(true);
  });
});

describe('recentTypes', () => {
  test('is the newest schedule’s type first, once each', () => {
    expect(
      recentTypes([
        { workflowType: 'a', createdAt: 1 },
        { workflowType: 'b', createdAt: 3 },
        { workflowType: 'a', createdAt: 4 },
      ]),
    ).toEqual(['a', 'b']);
  });
});

describe('no input', () => {
  test('is said only by a schema that says it', () => {
    expect(takesNoInput(undefined)).toBe(false);
    expect(takesNoInput({ type: 'null' })).toBe(true);
    expect(takesNoInput({ type: 'object', properties: {}, additionalProperties: false })).toBe(
      true,
    );
    expect(takesNoInput({ type: 'object', properties: { a: {} } })).toBe(false);
    expect(emptyInputOf({ type: 'null' })).toBeNull();
    expect(emptyInputOf({ type: 'object' })).toEqual({});
  });
});

describe('scheduleTargetOf', () => {
  const file = (state: 'ready' | 'invalid', paused: boolean) => ({
    kind: 'agent-authored' as const,
    file: { ...fileRow('triage-inbox', state, paused).file!, text: null, schedule: null },
    definition: undefined,
  });

  test('treats a paused file as one that can be scheduled, and a file that cannot load as one that cannot', () => {
    expect(scheduleTargetOf('triage-inbox', file('ready', true)).status).toBe('ready');
    expect(scheduleTargetOf('triage-inbox', file('ready', false)).status).toBe('ready');
    expect(scheduleTargetOf('triage-inbox', file('invalid', false)).status).toBe('invalid');
  });
});

describe('draftErrors', () => {
  test('asks for a workflow and a name before anything else, with nothing chosen', () => {
    expect(draftErrors(emptyDraft())).toEqual({
      workflowType: COPY.required,
      name: COPY.nameRequired,
    });
    expect(isDraftValid(emptyDraft())).toBe(false);
  });

  test('asks a chat for an agent and a message, and refuses a message that is too long', () => {
    expect(draftErrors(chatDraft({ agentName: ' ', message: '' }))).toEqual({
      agentName: SCHEDULE_COPY.form.agentRequired,
      message: SCHEDULE_COPY.form.inputRequired,
    });
    expect(draftErrors(chatDraft({ message: 'x'.repeat(100_001) })).message).toBe(
      SCHEDULE_COPY.form.inputTooLong,
    );
    expect(isDraftValid(chatDraft())).toBe(true);
  });

  test('refuses a name that is blank or too long', () => {
    expect(draftErrors(chatDraft({ name: '   ' })).name).toBe(COPY.nameRequired);
    expect(draftErrors(chatDraft({ name: 'n'.repeat(2_001) })).name).toBe(COPY.nameTooLong(2_000));
  });
});

describe('the name a schedule starts with', () => {
  test('is the workflow’s name, the agent’s for a chat, and nothing before a workflow is chosen', () => {
    expect(defaultNameOf(emptyDraft(), '')).toBe('');
    expect(defaultNameOf(chatDraft(), 'Chat with an agent')).toBe('Assistant');
    expect(defaultNameOf({ workflowType: 'release-notes', agentName: '' }, 'Release notes')).toBe(
      'Release notes',
    );
  });
});

describe('isDraftStarted', () => {
  test('is true once anything differs from the page as it opened', () => {
    const opened = emptyDraft();
    expect(isDraftStarted(emptyDraft(), opened)).toBe(false);
    expect(isDraftStarted({ ...opened, message: 'x' }, opened)).toBe(true);
  });
});

describe('the requests', () => {
  test('a chat is the Bureau’s, with the name as its description and the zone it was read in', () => {
    expect(agentScheduleInput(chatDraft())).toEqual({
      agentName: 'Assistant',
      spec: '0 9 * * *',
      input: 'Summarize yesterday’s chats and open reviews.',
      overlap: 'skip',
      description: 'Daily summary',
      timeZone: expect.any(String),
    });
  });

  test('a chat that continues one asks the Bureau for the chat, never names one, and never starts a run beside itself', () => {
    const input = agentScheduleInput(chatDraft({ continueChat: true, overlap: 'allow' }));
    expect(input).toMatchObject({ continueChat: true, overlap: 'skip' });
    expect(input).not.toHaveProperty('sessionId');
    expect(agentScheduleInput(chatDraft({ overlap: 'allow' }))).toMatchObject({
      overlap: 'allow',
    });
    expect(agentScheduleInput(chatDraft({ overlap: 'allow' }))).not.toHaveProperty('continueChat');
  });

  test('a workflow is the engine’s, with the policy selects, the input and the name', () => {
    const draft = {
      ...emptyDraft(),
      workflowType: 'triage-inbox',
      name: 'Inbox check',
      overlap: 'allow' as const,
      catchUp: true,
    };
    expect(engineScheduleArgs(draft, { folder: 'Inbox' })).toMatchObject({
      workflowType: 'triage-inbox',
      input: { folder: 'Inbox' },
      overlap: 'allow',
      backfill: true,
      description: 'Inbox check',
    });
  });
});

describe('takenNameOf', () => {
  const schedules = [
    { id: 's1', description: 'Daily summary' },
    { id: 's2', description: null },
  ];

  test('finds a schedule with the same name, ignoring case and the space around it', () => {
    expect(takenNameOf('  daily SUMMARY ', schedules)).toEqual({ id: 's1', name: 'Daily summary' });
    expect(takenNameOf('Weekly', schedules)).toBeUndefined();
    expect(takenNameOf('   ', schedules)).toBeUndefined();
  });
});

describe('footerLineOf', () => {
  const base: FooterState = {
    draft: emptyDraft(),
    workflow: '',
    creating: false,
    slow: false,
    waitingForWorkflows: false,
    waitingForInput: false,
    blocked: false,
    problemField: undefined,
  };

  test('says what to do first, and then what a schedule made now starts', () => {
    expect(footerLineOf(base)).toBe('Pick a workflow to see what it will start.');
    expect(footerLineOf({ ...base, draft: chatDraft() })).toBe(
      'Creates a schedule that starts a chat with Assistant.',
    );
    expect(
      footerLineOf({
        ...base,
        draft: { ...emptyDraft(), workflowType: 'order-refund' },
        workflow: 'Order refund',
      }),
    ).toBe('Creates a schedule that starts Order refund.');
  });

  test('says a schedule will not run without a provider, in place of what it starts', () => {
    expect(footerLineOf({ ...base, draft: chatDraft(), blocked: true })).toBe(
      'Won’t run until a provider is connected.',
    );
  });

  test('adds what pressing Create does while a field shows a problem', () => {
    expect(
      footerLineOf({ ...base, draft: chatDraft(), blocked: true, problemField: 'Day of week' }),
    ).toBe(
      'Won’t run until a provider is connected. Create schedule stays enabled; on submit, focus moves to Day of week.',
    );
  });

  test('says what it waits for before anything else, the workflow list before the input fields', () => {
    expect(footerLineOf({ ...base, waitingForWorkflows: true, waitingForInput: true })).toBe(
      'Waiting for the workflow list',
    );
    expect(footerLineOf({ ...base, draft: chatDraft(), waitingForInput: true })).toBe(
      'Waiting for the workflow’s input fields',
    );
  });

  test('says only that it is creating until it has taken ten seconds, and then how to stop it', () => {
    expect(
      footerLineOf({ ...base, draft: chatDraft(), creating: true, waitingForInput: true }),
    ).toBe('Creating the schedule…');
    expect(
      footerLineOf({ ...base, draft: chatDraft(), creating: true, slow: true, blocked: true }),
    ).toBe(
      'Creating the schedule… Taking longer than usual. Cancel stops the request and keeps the form.',
    );
  });
});

/**
 * What the page that edits a schedule decides outside the page (COR-2018, rows 74r, 74t, 75p, 75q):
 * the form it opens on, the requests a change becomes, and the footer that says what Save does.
 */
import type { ScheduleSummary } from '@lostgradient/weft';
import { describe, expect, test } from 'bun:test';

import { footerLineOf, takenNameOf, type NewScheduleDraft } from './new-schedule-model.ts';
import {
  agentUpdateOf,
  cadenceChanged,
  editDraftOf,
  editNameOf,
  endsSkippedRun,
  engineUpdateOf,
  messageIsCut,
  type EditTarget,
} from './schedule-edit-model.ts';

function summary(
  overrides: Partial<ScheduleSummary> = {},
  omit: readonly (keyof ScheduleSummary)[] = [],
): ScheduleSummary {
  const made = {
    id: 'daily-summary',
    workflowType: 'agentRun',
    status: 'active',
    description: 'Daily summary',
    cronExpression: '0 9 * * *',
    overlap: 'skip',
    backfill: false,
    timeZone: 'UTC',
    revisionPolicy: 'active-at-fire',
    revision: 3,
    createdAt: 1,
    updatedAt: 1,
    missedFireCount: 0,
    skippedCount: 0,
    queuedRuns: [],
    ...overrides,
  } as ScheduleSummary;
  for (const key of omit) delete made[key];
  return made;
}

const CHAT: EditTarget = {
  schedule: summary(),
  kind: 'agent-run',
  agentName: 'assistant',
  message: 'Summarize yesterday’s chats and open reviews.',
};

const ENGINE: EditTarget = {
  schedule: summary({ id: 'cleanup', workflowType: 'weekly-cleanup' }, ['description']),
  kind: 'code',
  agentName: null,
  message: null,
};

function draftOf(target: EditTarget, changes: Partial<NewScheduleDraft> = {}): NewScheduleDraft {
  return { ...editDraftOf(target), ...changes };
}

describe('the form an edit opens on', () => {
  test('a chat is filled in from the schedule and the Bureau', () => {
    expect(editDraftOf(CHAT)).toMatchObject({
      agentName: 'assistant',
      message: 'Summarize yesterday’s chats and open reviews.',
      name: 'Daily summary',
      overlap: 'skip',
      catchUp: false,
      continueChat: false,
    });
    expect(editDraftOf(CHAT).workflowType).not.toBe('');
  });

  test('a schedule with no description is named by its workflow’s words', () => {
    expect(editNameOf(ENGINE.schedule)).toBe('Weekly cleanup');
    expect(editDraftOf(ENGINE)).toMatchObject({
      workflowType: 'weekly-cleanup',
      name: 'Weekly cleanup',
    });
  });

  test('an engine schedule’s backfill is the catch-up choice', () => {
    const target = { ...ENGINE, schedule: summary({ workflowType: 'x', backfill: true }) };
    expect(editDraftOf(target).catchUp).toBe(true);
  });
});

describe('the requests a change becomes', () => {
  test('a chat sends only the cadence when nothing changed', () => {
    expect(agentUpdateOf(CHAT, draftOf(CHAT), editDraftOf(CHAT))).toEqual({ spec: '0 9 * * *' });
  });

  test('a chat sends the name and the policy that changed', () => {
    const update = agentUpdateOf(
      CHAT,
      draftOf(CHAT, { name: ' Morning ', overlap: 'allow' }),
      editDraftOf(CHAT),
    );
    expect(update).toEqual({ spec: '0 9 * * *', description: 'Morning', overlap: 'allow' });
  });

  test('a chat sends the agent, the message and the chat it now continues, each only when it changed (74r)', () => {
    const opened = editDraftOf(CHAT);
    const update = agentUpdateOf(
      CHAT,
      draftOf(CHAT, { agentName: ' tool-runner ', message: 'A new message', continueChat: true }),
      opened,
    );
    expect(update).toMatchObject({
      spec: '0 9 * * *',
      agentName: 'tool-runner',
      input: 'A new message',
    });
    expect(update.continueChat).toBe(true);
    // The page never makes up a chat's identifier: the Bureau names the chat it starts.
    // Nothing else is named: the schedule keeps what the person did not touch.
    expect(Object.keys(update).toSorted()).toEqual(['agentName', 'continueChat', 'input', 'spec']);
  });

  test('a new agent for a schedule that keeps continuing a chat starts a new chat with the change (74r)', () => {
    const continuing = { ...CHAT, continuesChat: true };
    const opened = editDraftOf(continuing);
    expect(agentUpdateOf(continuing, { ...opened, agentName: 'tool-runner' }, opened)).toEqual({
      spec: '0 9 * * *',
      agentName: 'tool-runner',
      continueChat: true,
    });
    // Turning the chat off with the change needs no new chat: every fire is a fresh one.
    expect(
      agentUpdateOf(
        continuing,
        { ...opened, agentName: 'tool-runner', continueChat: false },
        opened,
      ),
    ).toEqual({ spec: '0 9 * * *', agentName: 'tool-runner', sessionId: null });
  });

  test('a chat that continues one is opened on, and turned off, by naming no chat (74r)', () => {
    const continuing = { ...CHAT, continuesChat: true };
    const opened = editDraftOf(continuing);
    expect(opened.continueChat).toBe(true);
    expect(agentUpdateOf(continuing, { ...opened }, opened)).toEqual({ spec: '0 9 * * *' });
    expect(agentUpdateOf(continuing, { ...opened, continueChat: false }, opened)).toEqual({
      spec: '0 9 * * *',
      sessionId: null,
    });
  });

  test('a chat that continues one is never sent an overlap of allow, which the Bureau refuses for it', () => {
    const opened = editDraftOf(CHAT);
    const update = agentUpdateOf(CHAT, { ...opened, continueChat: true, overlap: 'allow' }, opened);
    expect(update).not.toHaveProperty('overlap');
  });

  test('a message the Bureau showed only the start of is known by its cut', () => {
    expect(messageIsCut('Summarize.')).toBe(false);
    expect(messageIsCut(null)).toBe(false);
    expect(messageIsCut(`${'a'.repeat(499)}…`)).toBe(true);
    expect(messageIsCut('a'.repeat(500))).toBe(false);
  });

  test('a name left as the one the schedule was shown by is not sent as a description', () => {
    const unnamed = { ...CHAT, schedule: summary({}, ['description']) };
    const update = agentUpdateOf(unnamed, draftOf(unnamed), editDraftOf(unnamed));
    expect(update).not.toHaveProperty('description');
  });

  test('a cadence of less than a minute is sent exactly until it is changed', () => {
    const fast = { ...CHAT, schedule: summary({ intervalMs: 30_000 }, ['cronExpression']) };
    const opened = editDraftOf(fast);
    expect(agentUpdateOf(fast, { ...opened, name: 'Fast' }, opened).spec).toBe('30s');
    const changed = {
      ...opened,
      cadence: { every: { unit: 'minutes' as const, count: 5 }, timeZone: 'UTC' },
    };
    expect(cadenceChanged(changed, opened)).toBe(true);
    expect(agentUpdateOf(fast, changed, opened).spec).toBe('5m');
  });

  test('an engine schedule sends its cadence and only the options that changed', () => {
    const opened = editDraftOf(ENGINE);
    expect(engineUpdateOf(ENGINE, opened, opened)).toEqual({
      spec: { cron: '0 9 * * *' },
      options: undefined,
    });
    const update = engineUpdateOf(
      ENGINE,
      { ...opened, name: 'Cleanup', catchUp: true, overlap: 'allow' },
      opened,
    );
    expect(update.options).toEqual({ description: 'Cleanup', overlap: 'allow', backfill: true });
  });

  test('a changed cadence ends a skipped run, and an unchanged one keeps it', () => {
    const skipped = { ...ENGINE, schedule: summary({ skippedOccurrences: [5] }) };
    const opened = editDraftOf(skipped);
    expect(endsSkippedRun(skipped, opened, opened)).toBe(false);
    const moved = { ...opened, cadence: { cron: '0 5 * * *', timeZone: 'UTC' } };
    expect(endsSkippedRun(skipped, moved, opened)).toBe(true);
    expect(
      endsSkippedRun(
        ENGINE,
        { ...editDraftOf(ENGINE), cadence: moved.cadence },
        editDraftOf(ENGINE),
      ),
    ).toBe(false);
  });
});

describe('the footer and the name check of an edit', () => {
  const state = {
    draft: editDraftOf(CHAT),
    workflow: 'Chat with an agent',
    creating: false,
    slow: false,
    waitingForWorkflows: false,
    waitingForInput: false,
    blocked: false,
    problemField: undefined,
    editing: 'Daily summary',
  };

  test('says what Save does, and what it is doing', () => {
    expect(footerLineOf(state)).toBe('Saves changes to Daily summary.');
    expect(footerLineOf({ ...state, creating: true })).toBe('Saving the changes…');
    expect(footerLineOf({ ...state, creating: true, slow: true })).toBe(
      'Saving the changes… Taking longer than usual. Cancel stops the request and keeps the form.',
    );
  });

  test('adds the provider and the field Save moves focus to', () => {
    expect(footerLineOf({ ...state, blocked: true, problemField: 'Day of week' })).toBe(
      'Saves changes to Daily summary. Won’t run until a provider is connected. Save changes stays enabled; on submit, focus moves to Day of week.',
    );
  });

  test('a schedule may keep its own name, and another’s is taken', () => {
    const schedules = [
      { id: 'daily-summary', description: 'Daily summary' },
      { id: 'other', description: 'Other' },
    ];
    expect(takenNameOf('daily summary', schedules, 'daily-summary')).toBeUndefined();
    expect(takenNameOf('other', schedules, 'daily-summary')).toEqual({
      id: 'other',
      name: 'Other',
    });
  });
});

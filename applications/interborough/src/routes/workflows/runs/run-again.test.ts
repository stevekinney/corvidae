/**
 * What Run again does for a run, and when a missing provider holds it (COR-2424, rows 54e, 54f, 55f,
 * 55j): a chat's run opens a new chat with the message, a schedule's run starts the schedule now, an
 * instance of a workflow file sets up another run, and a goal's attempt or a run still going has none.
 */
import { describe, expect, test } from 'bun:test';

import { taskFixture } from '../../../lib/bureau-fixtures.test-support.ts';
import { runAgainBlocked, runAgainOf } from './run-again.ts';

describe('what Run again does', () => {
  test('opens a new chat with the same agent and the message that started a chat’s run (row 54e)', () => {
    const task = taskFixture({ kind: 'chat', agentName: 'tool-runner' });

    expect(runAgainOf({ over: true, goalAttempt: false, task, messageIn: 'Look up 4472' })).toEqual(
      {
        kind: 'open',
        href: '/chats/new?agent=tool-runner&about=Look%20up%204472',
      },
    );
    // The chat's thread no longer holds the message: the new chat is still with the same agent.
    expect(runAgainOf({ over: true, goalAttempt: false, task })).toEqual({
      kind: 'open',
      href: '/chats/new?agent=tool-runner',
    });
  });

  test('starts the schedule now for a run a schedule started (row 55j)', () => {
    const task = taskFixture({
      kind: 'schedule-fire',
      agentName: 'assistant',
      origin: { kind: 'schedule', scheduleId: 'daily-summary', fireId: 'fire-1' },
    });

    expect(runAgainOf({ over: true, goalAttempt: false, task })).toEqual({
      kind: 'schedule',
      scheduleId: 'daily-summary',
    });
  });

  test('sets up another run of the workflow for an instance of a workflow file', () => {
    expect(runAgainOf({ over: true, goalAttempt: false, workflowType: 'release-notes' })).toEqual({
      kind: 'open',
      href: '/workflows/release-notes/run',
    });
  });

  test('is none for a goal’s attempt, which the goal reruns (row 55f)', () => {
    const task = taskFixture({
      kind: 'catalog',
      origin: { kind: 'goal', goalRunId: 'g', attemptId: 'a' },
    });
    expect(runAgainOf({ over: true, goalAttempt: true, task })).toBeUndefined();
  });

  test('is none for a run still going, and for the Bureau’s own workflows (row 54l)', () => {
    const task = taskFixture({ kind: 'chat', agentName: 'tool-runner' });
    expect(runAgainOf({ over: false, goalAttempt: false, task })).toBeUndefined();
    expect(
      runAgainOf({ over: true, goalAttempt: false, workflowType: 'agentRun' }),
    ).toBeUndefined();
    expect(runAgainOf({ over: true, goalAttempt: false })).toBeUndefined();
  });

  test('is none for a task that is neither a chat’s run nor a schedule’s', () => {
    const task = taskFixture({ kind: 'catalog', agentName: 'tool-runner' });
    expect(runAgainOf({ over: true, goalAttempt: false, task })).toBeUndefined();
  });
});

describe('when a missing provider holds Run again (row 54f)', () => {
  const modelAgents = new Set(['tool-runner']);

  test('holds it only when no provider is connected and an agent the run uses names a model', () => {
    expect(runAgainBlocked({ noProvider: true, agents: ['tool-runner'], modelAgents })).toBe(true);
    expect(runAgainBlocked({ noProvider: false, agents: ['tool-runner'], modelAgents })).toBe(
      false,
    );
  });

  test('never holds a scripted agent, whose run needs no model, nor a run whose agents are unknown', () => {
    expect(runAgainBlocked({ noProvider: true, agents: ['assistant'], modelAgents })).toBe(false);
    expect(runAgainBlocked({ noProvider: true, agents: [], modelAgents })).toBe(false);
  });
});

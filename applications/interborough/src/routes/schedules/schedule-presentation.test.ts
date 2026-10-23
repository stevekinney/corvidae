import { describe, expect, test } from 'bun:test';

import {
  cadenceClause,
  scheduleName,
  scheduleNameIdentifiers,
  scheduleSentence,
} from './schedule-presentation.ts';

const AGENT = { kind: 'agent-run', agentName: 'assistant' } as const;
const UNNAMED_AGENT = { kind: 'agent-run', agentName: null } as const;
const CODE = { kind: 'code' } as const;

describe('the name of a schedule', () => {
  test('is its description when it has one', () => {
    expect(scheduleName({ description: 'Daily summary', workflowType: 'agentRun' }, AGENT)).toBe(
      'Daily summary',
    );
  });

  test('is “Schedule for” its agent when it has no description, never its identifier', () => {
    expect(scheduleName({ workflowType: 'agentRun' }, AGENT)).toBe('Schedule for assistant');
    expect(scheduleName({ description: '   ', workflowType: 'agentRun' }, AGENT)).toBe(
      'Schedule for assistant',
    );
  });

  test('is a scheduled agent run when the caller may not read the agent', () => {
    expect(scheduleName({ workflowType: 'agentRun' }, UNNAMED_AGENT)).toBe('Scheduled agent run');
  });

  test('is “Schedule for” the workflow type for a schedule that starts a workflow', () => {
    expect(scheduleName({ workflowType: 'order-processing' }, CODE)).toBe(
      'Schedule for order-processing',
    );
    expect(scheduleName({ workflowType: 'digest' }, { kind: 'unknown' })).toBe(
      'Schedule for digest',
    );
  });

  test('names as identifiers only what it was derived from, and nothing of a description', () => {
    expect(
      scheduleNameIdentifiers({ description: 'Daily summary', workflowType: 'agentRun' }, AGENT),
    ).toEqual([]);
    expect(scheduleNameIdentifiers({ workflowType: 'agentRun' }, AGENT)).toEqual(['assistant']);
    expect(scheduleNameIdentifiers({ workflowType: 'agentRun' }, UNNAMED_AGENT)).toEqual([]);
    expect(scheduleNameIdentifiers({ workflowType: 'order-processing' }, CODE)).toEqual([
      'order-processing',
    ]);
  });
});

describe('a cadence at the end of a sentence', () => {
  test('is lower-cased when it begins with “Every” or “Monthly”', () => {
    expect(cadenceClause({ cronExpression: '0 9 * * *' })).toBe('every day at 09:00');
    expect(cadenceClause({ intervalMs: 5 * 60_000 })).toBe('every 5 minutes');
    expect(cadenceClause({ cronExpression: '0 9 3 * *' })).toBe('monthly on day 3 at 09:00');
  });

  test('keeps a weekday’s capital and says “on”', () => {
    expect(cadenceClause({ cronExpression: '0 9 * * 1' })).toBe('on Mondays at 09:00');
  });

  test('says an expression it cannot put in words as it is', () => {
    expect(cadenceClause({ cronExpression: '0 9 * * 1-5' })).toBe('on cron 0 9 * * 1-5');
    expect(cadenceClause({})).toBe('on an unknown cadence');
  });
});

describe('what a schedule does, as a sentence', () => {
  test('runs an agent, and starts a workflow', () => {
    const cadence = { cronExpression: '0 9 * * *' };
    expect(scheduleSentence(cadence, AGENT)).toEqual({
      verb: 'Runs',
      clause: 'every day at 09:00',
    });
    expect(scheduleSentence(cadence, CODE)).toEqual({
      verb: 'Starts',
      clause: 'every day at 09:00',
    });
  });
});

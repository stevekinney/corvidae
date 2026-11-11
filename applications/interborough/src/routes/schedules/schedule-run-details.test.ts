/**
 * What a run's row says on its second line (COR-2018, rows 73f and 73k): how it started, where it
 * is, and where a failed run stopped and why, read from the run's state, its timeline and its
 * schedule provenance.
 */
import { describe, expect, test } from 'bun:test';

import type { WorkflowTimelineEntry } from '@lostgradient/weft';

import {
  fetchRunDetail,
  oneLine,
  runDetailLine,
  type RunDetailClient,
} from './schedule-run-details.ts';

const AGENT_FAILURE =
  'Agent "assistant" failed (finish reason "error"): {"name":"AgentRunError","message":"GitHub didn’t answer (HTTP 503)","kind":"generate","code":"UNKNOWN","cause":{"name":"Error","message":"GitHub didn’t answer (HTTP 503)"}}';

function entry(overrides: Partial<WorkflowTimelineEntry>): WorkflowTimelineEntry {
  return {
    step: 0,
    operationType: 'activity',
    operationLabel: 'Collect merged changes',
    inputSummary: '',
    timestamp: 0,
    status: 'completed',
    ...overrides,
  };
}

function client(options: {
  error?: string | undefined;
  timeline?: WorkflowTimelineEntry[];
  provenance?: unknown;
  failing?: ReadonlyArray<'get' | 'timeline' | 'provenance'>;
}): RunDetailClient {
  const failing = new Set(options.failing ?? []);
  return {
    get: () =>
      failing.has('get')
        ? Promise.reject(new Error('no'))
        : Promise.resolve({ error: options.error }),
    getTimeline: () =>
      failing.has('timeline')
        ? Promise.reject(new Error('no'))
        : Promise.resolve(options.timeline ?? []),
    operations: {
      'weft.workflows.scheduleprovenance.get': () =>
        failing.has('provenance')
          ? Promise.reject(new Error('no'))
          : Promise.resolve(options.provenance ?? null),
    },
  } as unknown as RunDetailClient;
}

describe('oneLine', () => {
  test('reads the cause an agent run wraps in its own message, without the detail in parentheses', () => {
    expect(oneLine(AGENT_FAILURE)).toBe('GitHub didn’t answer');
  });

  test('drops the name of the error class and everything after the first line', () => {
    expect(oneLine('TypeError: Cannot read properties\n    at run (file.ts:1:1)')).toBe(
      'Cannot read properties',
    );
  });

  test('reads a message whose brace is not JSON as it stands', () => {
    expect(oneLine('Expected { after the key')).toBe('Expected { after the key');
  });

  test('keeps the text of a message that is only a parenthetical', () => {
    expect(oneLine('(nothing else)')).toBe('');
  });
});

describe('fetchRunDetail', () => {
  test('reads that a person started it with Run now, and the step a run that is going is on', async () => {
    const detail = await fetchRunDetail(
      client({
        provenance: { scheduleId: 's', manual: true },
        timeline: [
          entry({ stepIndex: 0, status: 'completed' }),
          entry({ stepIndex: 1, status: 'running', operationLabel: 'Collecting merged changes' }),
        ],
      }),
      'run-1',
    );

    expect(detail).toEqual({ manual: true, currentStep: 'Collecting merged changes' });
  });

  test('reads the one-based step a failed run stopped at, and what it said', async () => {
    const detail = await fetchRunDetail(
      client({
        error: AGENT_FAILURE,
        timeline: [entry({ stepIndex: 0 }), entry({ stepIndex: 1, status: 'failed' })],
      }),
      'run-2',
    );

    expect(detail).toEqual({ manual: false, failedStep: 2, message: 'GitHub didn’t answer' });
  });

  test('falls back to the checkpoint step when the timeline carries no step index', async () => {
    const detail = await fetchRunDetail(
      client({ timeline: [entry({ step: 2, status: 'failed' })] }),
      'run-3',
    );

    expect(detail.failedStep).toBe(3);
  });

  test('says what it could read when one of the reads fails', async () => {
    const cases: ReadonlyArray<ReadonlyArray<'get' | 'timeline' | 'provenance'>> = [
      ['get'],
      ['timeline'],
      ['provenance'],
    ];
    for (const failing of cases) {
      const detail = await fetchRunDetail(
        client({
          error: 'Boom',
          timeline: [entry({ stepIndex: 0, status: 'failed' })],
          provenance: { scheduleId: 's', manual: true },
          failing,
        }),
        'run-4',
      );
      expect(detail.manual).toBe(!failing.includes('provenance'));
      expect(detail.message).toBe(failing.includes('get') ? undefined : 'Boom');
      expect(detail.failedStep).toBe(failing.includes('timeline') ? undefined : 1);
    }
  });
});

describe('runDetailLine', () => {
  test('says nothing before the run has been read, and for a run that went as the cadence says', () => {
    expect(runDetailLine(undefined, 'failed')).toBeUndefined();
    expect(runDetailLine({ manual: false }, 'other')).toBeUndefined();
  });

  test('says how a run that is going started and where it is', () => {
    expect(
      runDetailLine({ manual: true, currentStep: 'Collecting merged changes' }, 'running'),
    ).toBe('Started with Run now, Collecting merged changes');
    expect(runDetailLine({ manual: false, currentStep: 'Collecting' }, 'running')).toBe(
      'Collecting',
    );
  });

  test('says where a failed run stopped and why', () => {
    expect(
      runDetailLine({ manual: false, failedStep: 2, message: 'GitHub didn’t answer' }, 'failed'),
    ).toBe('Failed at step 2, GitHub didn’t answer');
    expect(runDetailLine({ manual: false, message: 'Boom' }, 'failed')).toBe('Boom');
  });

  test('says only how a canceled run started', () => {
    expect(runDetailLine({ manual: true, failedStep: 1, currentStep: 'x' }, 'other')).toBe(
      'Started with Run now',
    );
  });
});

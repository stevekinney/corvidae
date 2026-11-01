/**
 * COR-1978 — what a hook's scope reads about a run: its own agent, and the workflows and schedules
 * of the run and every run above it, over scripted records.
 */
import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { describe, expect, it } from 'bun:test';

import type { StoredTaskOrigin } from '../task-origin.ts';
import { createRunHookOrigins } from './run-hook-origins.ts';

type Task = { agent?: string; origin?: StoredTaskOrigin };
type Instance = { type: string; input?: unknown };

function subjects(tasks: Record<string, Task>, instances: Record<string, Instance> = {}) {
  return createRunHookOrigins({
    kv: undefined,
    workflowOf: (runId) => Promise.resolve(instances[runId] ?? null),
    taskOriginOf: (runId) => Promise.resolve(tasks[runId]?.origin),
    agentOf: (runId) => Promise.resolve(tasks[runId]?.agent ?? null),
    diagnose: () => undefined,
  }).subjectsOfRun;
}

describe('the subjects of a run', () => {
  it('is its own agent, and nothing else, for a run with nothing above it', async () => {
    const read = subjects({ 'run-1': { agent: 'scout', origin: { kind: 'api' } } });
    expect(await read('run-1')).toEqual({ agent: 'scout', workflows: [], schedules: [] });
  });

  it('reads a step’s workflow from the instance above it, in the name Bureau knows it by', async () => {
    const read = subjects(
      {
        step: { agent: 'scout', origin: { kind: 'parent', parentRunId: 'instance' } },
        instance: {},
      },
      { instance: { type: 'nightly', input: { kind: 'schedule', scheduleId: 'bureau-s' } } },
    );
    expect(await read('step')).toEqual({
      agent: 'scout',
      workflows: ['nightly'],
      schedules: ['bureau-s'],
    });
  });

  it('keeps a child’s own agent, and takes the schedule of the run that started it', async () => {
    const read = subjects({
      child: {
        agent: 'writer',
        origin: { kind: 'agent', parentRunId: 'parent', agentName: 'scout' },
      },
      parent: {
        agent: 'scout',
        origin: { kind: 'schedule', scheduleId: 'every-hour', fireId: 'fire-1' },
      },
    });
    expect(await read('child')).toEqual({
      agent: 'writer',
      workflows: [],
      schedules: ['every-hour'],
    });
  });

  it('knows nothing of a run with no record, and fails on a chain deeper than any real one', async () => {
    expect(await subjects({})('missing')).toEqual({
      agent: undefined,
      workflows: [],
      schedules: [],
    });
    const endless = subjects({
      loop: { origin: { kind: 'parent', parentRunId: 'loop' } },
    });
    expect((await rejectionOf(endless('loop'))) as Error).toBeInstanceOf(Error);
  });
});

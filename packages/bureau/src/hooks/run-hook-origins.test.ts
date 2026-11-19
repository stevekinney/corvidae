/**
 * COR-1978 — what a hook's scope reads about a run: its own agent, and the workflows and schedules
 * of the run and every run above it, over scripted records.
 */
import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { MemoryStorage, textValueStore } from '@lostgradient/storage';
import { describe, expect, it } from 'bun:test';

import type { StoredTaskOrigin } from '../task-origin.ts';
import { createRunHookOrigins } from './run-hook-origins.ts';

type Task = { agent?: string; origin?: StoredTaskOrigin };
type Instance = { type: string; input?: unknown; tags?: string[] };

/** What the sources read: `fires` is Weft's record of which schedule fired each run. */
function sourcesOf(
  tasks: Record<string, Task>,
  instances: Record<string, Instance>,
  fires: Record<string, string>,
  kv?: ReturnType<typeof textValueStore>,
) {
  return {
    kv,
    workflowOf: (runId: string) => Promise.resolve(instances[runId] ?? null),
    scheduleOfFire: (runId: string) => Promise.resolve(fires[runId]),
    taskOriginOf: (runId: string) => Promise.resolve(tasks[runId]?.origin),
    agentOf: (runId: string) => Promise.resolve(tasks[runId]?.agent ?? null),
    diagnose: () => undefined,
  };
}

function subjects(
  tasks: Record<string, Task>,
  instances: Record<string, Instance> = {},
  fires: Record<string, string> = {},
) {
  return createRunHookOrigins(sourcesOf(tasks, instances, fires)).subjectsOfRun;
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
      { instance: 'bureau-s' },
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

describe('the schedule a run was fired by (COR-2546)', () => {
  /** A hook-started run's schedules carry the hook; a person's `elsewhere` schedule carries one too. */
  async function hookChain(instances: Record<string, Instance>, fires: Record<string, string>) {
    const kv = textValueStore(new MemoryStorage());
    const origins = createRunHookOrigins(sourcesOf({}, instances, fires, kv));
    await origins.scheduleHookOrigins!.recordSchedule('hooked-schedule', 'hook-1');
    return origins;
  }

  const forgedInputs: Array<[string, unknown]> = [
    ['a schedule trigger', { kind: 'schedule', scheduleId: 'hooked-schedule' }],
    [
      'an agent schedule’s fire',
      { agentName: 'writer', input: 'x', scheduleId: 'hooked-schedule' },
    ],
  ];

  for (const [name, input] of forgedInputs) {
    it(`is not the one ${name} in a run’s input names, when no schedule fired the run`, async () => {
      const origins = await hookChain({ 'run-1': { type: 'kit__echo', input } }, {});
      expect(await origins.startedByHook('run-1')).toBeUndefined();
      expect(await origins.subjectsOfRun('run-1')).toEqual({
        agent: undefined,
        workflows: ['kit:echo'],
        schedules: [],
      });
    });

    it(`is the one the fire record names, not the one ${name} in the input names`, async () => {
      const origins = await hookChain(
        { 'run-1': { type: 'kit__echo', input } },
        { 'run-1': 'people-schedule' },
      );
      expect(await origins.startedByHook('run-1')).toBeUndefined();
      expect((await origins.subjectsOfRun('run-1')).schedules).toEqual(['people-schedule']);
    });
  }

  it('reads a hook-made schedule of a code workflow as the hook’s, though its raw input names no schedule', async () => {
    const origins = await hookChain(
      { 'run-1': { type: 'kit__echo', input: { n: 1 } } },
      { 'run-1': 'hooked-schedule' },
    );
    expect(await origins.startedByHook('run-1')).toBe('hook-1');
    expect((await origins.subjectsOfRun('run-1')).schedules).toEqual(['hooked-schedule']);
  });
});

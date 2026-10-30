/**
 * COR-1940 — the walk from a run up to the hook that started it, which is what keeps hooks from
 * chaining.
 */
import { describe, expect, it } from 'bun:test';

import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { createHookOriginLookup, hookOfTags, hookOriginTag } from './hook-origin.ts';
import { scheduleOfInstanceInput } from './schedule-hook-origins.ts';

function lookupOver(
  tags: Readonly<Record<string, readonly string[]>>,
  parents: Readonly<Record<string, string>>,
) {
  const reads: string[] = [];
  const lookup = createHookOriginLookup({
    workflowTags: (runId) => {
      reads.push(runId);
      return Promise.resolve(tags[runId]);
    },
    parentOf: (runId) => Promise.resolve(parents[runId] ?? null),
    scheduleOf: () => Promise.resolve(undefined),
    hookOfSchedule: () => Promise.resolve(undefined),
  });
  return { lookup, reads };
}

describe('the tag of a run a hook started', () => {
  it('names the hook and is read back from among other tags', () => {
    expect(hookOfTags([hookOriginTag('hook-7'), 'origin:person'])).toBe('hook-7');
    expect(hookOfTags(['origin:person'])).toBeUndefined();
    expect(hookOfTags(undefined)).toBeUndefined();
  });
});

describe('the hook that started a run', () => {
  it('is the hook named on the run itself', async () => {
    const { lookup } = lookupOver({ 'run-1': [hookOriginTag('hook-1')] }, {});
    expect(await lookup('run-1')).toBe('hook-1');
  });

  it('is found through every run above: a step, a child of a step, an attempt', async () => {
    const { lookup } = lookupOver(
      { instance: [hookOriginTag('hook-2'), 'origin:person'] },
      { step: 'instance', child: 'step', attempt: 'child' },
    );
    expect(await lookup('attempt')).toBe('hook-2');
    expect(await lookup('step')).toBe('hook-2');
  });

  it('is nothing for a run no hook started, however far up it looks', async () => {
    const { lookup, reads } = lookupOver({ top: ['origin:person'] }, { step: 'top' });
    expect(await lookup('step')).toBeUndefined();
    expect(reads).toEqual(['step', 'top']);
  });

  it('gives up, rather than answer, on a chain deeper than any real one or a cycle', async () => {
    const { lookup } = lookupOver({}, { a: 'b', b: 'a' });
    expect(await rejectionOf(lookup('a'))).toMatchObject({
      message: expect.stringContaining('nested deeper'),
    });
  });

  it('propagates a failed read, so the caller can treat the run as a hook’s own', async () => {
    const lookup = createHookOriginLookup({
      workflowTags: () => Promise.reject(new Error('storage is closed')),
      parentOf: () => Promise.resolve(null),
      scheduleOf: () => Promise.resolve(undefined),
      hookOfSchedule: () => Promise.resolve(undefined),
    });
    expect(await rejectionOf(lookup('run-1'))).toMatchObject({ message: 'storage is closed' });
  });
});

describe('the hook behind a run a schedule fired (COR-1952)', () => {
  /** A walk over a run whose schedule, if any, is in `schedules` and whose hook is in `hooks`. */
  function scheduledLookup(
    schedules: Readonly<Record<string, string>>,
    hooks: Readonly<Record<string, string>>,
    parents: Readonly<Record<string, string>> = {},
    tags: Readonly<Record<string, readonly string[]>> = {},
  ) {
    return createHookOriginLookup({
      workflowTags: (runId) => Promise.resolve(tags[runId]),
      parentOf: (runId) => Promise.resolve(parents[runId] ?? null),
      scheduleOf: (runId) => Promise.resolve(schedules[runId]),
      hookOfSchedule: (scheduleId) => Promise.resolve(hooks[scheduleId]),
    });
  }

  it('is the hook recorded for the schedule that fired it, and for every run beneath the fire', async () => {
    const lookup = scheduledLookup(
      { fire: 'schedule-1' },
      { 'schedule-1': 'hook-3' },
      {
        step: 'fire',
        child: 'step',
      },
    );
    expect(await lookup('fire')).toBe('hook-3');
    expect(await lookup('step')).toBe('hook-3');
    expect(await lookup('child')).toBe('hook-3');
  });

  it('is nothing for a fire of a schedule with no record, which is an owner’s', async () => {
    const lookup = scheduledLookup({ fire: 'schedule-2' }, { 'schedule-1': 'hook-3' });
    expect(await lookup('fire')).toBeUndefined();
  });

  it('is the hook on the run’s own tag before the schedule’s record', async () => {
    const lookup = scheduledLookup(
      { fire: 'schedule-1' },
      { 'schedule-1': 'hook-3' },
      {},
      { fire: [hookOriginTag('hook-1')] },
    );
    expect(await lookup('fire')).toBe('hook-1');
  });
});

describe('the schedule a workflow instance’s input names', () => {
  it('is the schedule of a workflow trigger or of an agent schedule’s fire, and nothing else', () => {
    expect(scheduleOfInstanceInput({ kind: 'schedule', scheduleId: 's-1' })).toBe('s-1');
    expect(scheduleOfInstanceInput({ agentName: 'scribe', input: 'x', scheduleId: 's-2' })).toBe(
      's-2',
    );
    // Whatever a person or a signal supplied is not a schedule's.
    expect(scheduleOfInstanceInput({ scheduleId: 's-3' })).toBeUndefined();
    expect(
      scheduleOfInstanceInput({ kind: 'signal', name: 'go', scheduleId: 's-4' }),
    ).toBeUndefined();
    expect(scheduleOfInstanceInput({ kind: 'schedule', scheduleId: '' })).toBeUndefined();
    for (const input of [null, undefined, 'text', 4, ['s']]) {
      expect(scheduleOfInstanceInput(input)).toBeUndefined();
    }
  });
});

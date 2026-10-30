/**
 * COR-1940 — the walk from a run up to the hook that started it, which is what keeps hooks from
 * chaining.
 */
import { describe, expect, it } from 'bun:test';

import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { createHookOriginLookup, hookOfTags, hookOriginTag } from './hook-origin.ts';

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
    });
    expect(await rejectionOf(lookup('run-1'))).toMatchObject({ message: 'storage is closed' });
  });
});

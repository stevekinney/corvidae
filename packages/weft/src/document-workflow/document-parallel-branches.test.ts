/**
 * COR-2416: what a branch of a parallel step may hold, now that each branch runs on its own: an
 * activity that retries, a child workflow, a parallel step of its own, and a `map`. Each is
 * checked beside a sibling that waits, across a restart that comes after the branch's step.
 */
import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from '@lostgradient/storage';
import { waitUntil } from '@lostgradient/testing/wait-until';

import { deserializeCheckpoint } from '../core/checkpoint.ts';
import { isParallelOperationCacheEntry } from '../core/context/parallel-cache-entry.ts';
import { Engine } from '../core/engine/index.ts';
import { workflow, type WorkflowContext } from '../core/types.ts';
import { KEYS } from '../storage/keys.ts';
import type { DocumentWorkflowHost } from './document.ts';
import { registerWorkflowDocuments } from './register.ts';

const calls: string[] = [];
let flakyAttempts = 0;

/** A step input as the call log records it: a string as written, anything else as JSON. */
function labelOf(input: unknown): string {
  return typeof input === 'string' ? input : JSON.stringify(input);
}

const child = workflow({ name: 'branch-child', version: '1' }).execute(async function* (
  _context: WorkflowContext,
  input: unknown,
) {
  yield* [];
  calls.push('child');
  return { echoed: input };
});

const host: DocumentWorkflowHost = {
  activities: {
    count: ({ input }) => {
      calls.push(labelOf(input));
      return input;
    },
    list: () => ({ items: ['x', 'y'] }),
    flaky: {
      retry: { maxAttempts: 2, initialBackoff: 5, backoffMultiplier: 1, maxBackoff: 5 },
      execute: ({ input }) => {
        flakyAttempts += 1;
        calls.push(labelOf(input));
        if (flakyAttempts === 1) throw new Error('first attempt fails');
        return `settled after ${String(flakyAttempts)}`;
      },
    },
    each: ({ previous }) => {
      calls.push(`each:${String(previous)}`);
      return previous;
    },
  },
  triggerKinds: { manual: () => undefined },
  workflows: ['branch-child'],
  workflowVersions: { 'branch-child': '1' },
};

const manual = { kind: 'manual' };
const parallel = (branches: Record<string, unknown>) => ({ kind: 'parallel', branches });
const wait = (signal: string) => ({ kind: 'await-signal', signal });
const doc = (name: string, steps: readonly unknown[]) => ({ name, trigger: manual, steps });

async function isWaitingOn(engine: Engine, id: string, signal: string): Promise<boolean> {
  const state = await engine.get(id);
  return (state?.waitingForSignals ?? []).includes(signal);
}

/** Whether the run's committed checkpoint holds a finished branch slot. */
async function hasFulfilledSlot(storage: MemoryStorage, id: string): Promise<boolean> {
  const bytes = await storage.get(KEYS.checkpoint(id));
  if (bytes === null) return false;
  const entry = deserializeCheckpoint(bytes)
    .accumulatedResults.map(([, value]) => value)
    .find(isParallelOperationCacheEntry);
  return entry?.branches.some((slot) => slot.status === 'fulfilled') ?? false;
}

/** Start `document`, wait for its sibling wait, restart, finish it, and return its result. */
async function runAcrossRestart(document: ReturnType<typeof doc>, finished: () => boolean) {
  const storage = new MemoryStorage();
  const id = `${document.name}-run`;
  {
    await using original = new Engine({ storage });
    original.register(child);
    await registerWorkflowDocuments(original, host, { active: [document] });
    await original.start(document.name, null, { id });
    await waitUntil(async () => (await isWaitingOn(original, id, 'go')) && finished(), {
      message: 'the branch to finish and the sibling to wait',
    });
    // The branch's commit follows its last step: wait for it before the restart.
    await waitUntil(async () => hasFulfilledSlot(storage, id), {
      message: 'the finished branch to be committed',
    });
  }
  await using restarted = new Engine({ storage });
  restarted.register(child);
  await registerWorkflowDocuments(restarted, host, { active: [document] });
  const [handle] = await restarted.recoverAll();
  await waitUntil(async () => isWaitingOn(restarted, id, 'go'), { message: 'the sibling to wait' });
  await handle!.signal('go', 'signalled');
  // Awaited here: the restarted engine is disposed as this function returns.
  return await handle!.result();
}

describe('what a branch of a parallel step may hold', () => {
  it('retries an activity inside a branch while a sibling waits, and runs it no more across a restart', async () => {
    calls.length = 0;
    flakyAttempts = 0;
    const result = await runAcrossRestart(
      doc('branch-retry', [
        parallel({ a: [{ kind: 'activity', handler: 'flaky', input: 'f' }], b: [wait('go')] }),
      ]),
      () => flakyAttempts === 2,
    );
    expect(result).toEqual({ a: 'settled after 2', b: 'signalled' });
    expect(flakyAttempts).toBe(2);
  });

  it('starts a child workflow inside a branch while a sibling waits, and starts it once across a restart', async () => {
    calls.length = 0;
    const result = await runAcrossRestart(
      doc('branch-child-workflow', [
        parallel({
          a: [{ kind: 'workflow', workflow: 'branch-child', input: 'kid' }],
          b: [wait('go')],
        }),
      ]),
      () => calls.includes('child'),
    );
    expect(result).toEqual({ a: { echoed: 'kid' }, b: 'signalled' });
    expect(calls.filter((call) => call === 'child')).toHaveLength(1);
  });

  it('runs a parallel step nested in a branch, and a map in a branch, beside a sibling that waits', async () => {
    calls.length = 0;
    const result = await runAcrossRestart(
      doc('branch-nested', [
        parallel({
          a: [
            parallel({
              x: [{ kind: 'activity', handler: 'count', input: 'x' }],
              y: [{ kind: 'activity', handler: 'count', input: 'y' }],
            }),
          ],
          m: [
            { kind: 'activity', handler: 'list' },
            { kind: 'map', over: 'items', steps: [{ kind: 'activity', handler: 'each' }] },
          ],
          b: [wait('go')],
        }),
      ]),
      () => calls.includes('each:y'),
    );
    expect(result).toEqual({ a: { x: 'x', y: 'y' }, m: ['x', 'y'], b: 'signalled' });
  });
});

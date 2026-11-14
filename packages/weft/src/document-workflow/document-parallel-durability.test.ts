/**
 * COR-2416: a signal a branch of a parallel step takes is consumed in the same commit as the branch
 * progress that records it, at every nesting depth and on every outcome, so a restart never finds
 * the signal gone while the branch that took it starts over. Each test is a probe of the review of
 * the first round (`review-round-1.md`), run across a restart.
 */
import { describe, expect, it } from 'bun:test';

import { encodeStorageKeyComponent, MemoryStorage } from '@lostgradient/storage';
import { throwingRejectionOf } from '@lostgradient/testing/promise-outcome';
import { waitUntil } from '@lostgradient/testing/wait-until';

import { deserializeCheckpoint } from '../core/checkpoint.ts';
import {
  isParallelOperationCacheEntry,
  type ParallelBranchSlot,
} from '../core/context/parallel-cache-entry.ts';
import { Engine } from '../core/engine/index.ts';
import { KEYS } from '../storage/keys.ts';
import type { DocumentWorkflowHost } from './document.ts';
import { registerWorkflowDocuments } from './register.ts';

const calls: string[] = [];

const host: DocumentWorkflowHost = {
  activities: {
    count: ({ input }) => {
      calls.push(String(input));
      return input;
    },
    boom: () => {
      calls.push('boom');
      throw new Error('branch exploded');
    },
  },
  triggerKinds: { manual: () => undefined },
};

const parallel = (branches: Record<string, unknown>) => ({ kind: 'parallel', branches });
const wait = (signal: string) => ({ kind: 'await-signal', signal });
const doc = (name: string, steps: readonly unknown[]) => ({
  name,
  trigger: { kind: 'manual' },
  steps,
});

async function waitingNames(engine: Engine, id: string): Promise<readonly string[]> {
  const state = await engine.get(id);
  return (state?.waitingForSignals ?? []).toSorted();
}

async function isWaitingOn(engine: Engine, id: string, ...names: string[]): Promise<boolean> {
  const waiting = await waitingNames(engine, id);
  return names.every((name) => waiting.includes(name));
}

/** The slots of the top-level parallel step in the run's committed checkpoint. */
async function committedSlots(storage: MemoryStorage, id: string): Promise<ParallelBranchSlot[]> {
  const bytes = await storage.get(KEYS.checkpoint(id));
  if (bytes === null) return [];
  const entry = deserializeCheckpoint(bytes)
    .accumulatedResults.map(([, value]) => value)
    .find(isParallelOperationCacheEntry);
  return entry?.branches ?? [];
}

/** How many of its own steps branch `index` has committed, finished or not. */
async function committedStepCount(storage: MemoryStorage, id: string, index: number) {
  const slot = (await committedSlots(storage, id))[index];
  if (slot === undefined) return 0;
  if (slot.status === 'fulfilled') return Number.POSITIVE_INFINITY;
  return 'results' in slot ? (slot.results?.length ?? 0) : 0;
}

/** Whether a signal named `name` is still buffered, durably, for run `id`. */
async function hasBufferedSignal(storage: MemoryStorage, id: string, name: string) {
  const prefix = `sig:${encodeStorageKeyComponent(id)}:${encodeStorageKeyComponent(name)}:`;
  return (await storage.count(prefix)) > 0;
}

async function startEngine(storage: MemoryStorage, document: ReturnType<typeof doc>) {
  const engine = new Engine({ storage });
  await registerWorkflowDocuments(engine, host, { active: [document] });
  return engine;
}

describe('a signal a branch takes is committed with the progress that records it', () => {
  it('keeps what a failed branch took across a restart, and fails the run as it would have (review probe 1)', async () => {
    calls.length = 0;
    const storage = new MemoryStorage();
    const id = 'failed-after-signal-run';
    const document = doc('failed-after-signal', [
      parallel({
        a: [wait('one'), { kind: 'activity', handler: 'boom' }],
        b: [wait('two'), wait('three')],
      }),
      { kind: 'activity', handler: 'count', input: 'after' },
    ]);
    {
      await using original = await startEngine(storage, document);
      const run = await original.start(document.name, null, { id });
      await waitUntil(async () => isWaitingOn(original, id, 'one', 'two'), {
        message: 'both branches to wait',
      });
      await run.signal('one', 'A');
      await waitUntil(async () => calls.includes('boom'), { message: 'branch a to fail' });
      await run.signal('two', 'B');
      await waitUntil(async () => (await committedStepCount(storage, id, 1)) === 1, {
        message: 'branch b`s first step to be committed',
      });
      // The commit that took `two` also landed the delete of `one`: what took it must be durable.
      expect(await hasBufferedSignal(storage, id, 'one')).toBe(false);
    }
    await using restarted = await startEngine(storage, document);
    const [handle] = await restarted.recoverAll();
    await waitUntil(async () => isWaitingOn(restarted, id, 'three'), {
      message: 'branch b to wait again',
    });
    // Branch `a` resumes after the signal it took: it runs the step that threw again, and never
    // waits on `one` again.
    await waitUntil(async () => calls.length === 2, {
      message: 'branch a to run the step that threw again',
    });
    expect(await waitingNames(restarted, id)).toEqual(['three']);
    await handle!.signal('three', 'C');
    expect(await throwingRejectionOf(handle!.result())).toThrow('branch exploded');
    expect((await restarted.get(id))?.status).toBe('failed');
    // The failed activity runs again after the restart (at-least-once), and no later step runs.
    expect(calls).toEqual(['boom', 'boom']);
  });

  it('commits a nested parallel step`s progress with the signal it took (review probe 2)', async () => {
    calls.length = 0;
    const storage = new MemoryStorage();
    const id = 'nested-signal-run';
    const document = doc('nested-signal', [
      parallel({
        a: [parallel({ x: [wait('one')], y: [wait('two')] })],
        b: [wait('three'), wait('four')],
      }),
    ]);
    {
      await using original = await startEngine(storage, document);
      const run = await original.start(document.name, null, { id });
      await waitUntil(async () => isWaitingOn(original, id, 'one', 'two', 'three'), {
        message: 'every branch to wait',
      });
      await run.signal('one', 'X');
      await waitUntil(async () => !(await isWaitingOn(original, id, 'one')), {
        message: 'the nested branch to take its signal',
      });
      await run.signal('three', 'T');
      await waitUntil(async () => (await committedStepCount(storage, id, 1)) === 1, {
        message: 'branch b`s first step to be committed',
      });
      // The commit that landed the consume of `one` holds the nested step's progress, which took it.
      expect(await hasBufferedSignal(storage, id, 'one')).toBe(false);
      expect(await committedStepCount(storage, id, 0)).toBe(1);
    }
    await using restarted = await startEngine(storage, document);
    const [handle] = await restarted.recoverAll();
    await waitUntil(async () => isWaitingOn(restarted, id, 'two', 'four'), {
      message: 'the open waits to wait again',
    });
    expect(await waitingNames(restarted, id)).toEqual(['four', 'two']);
    await handle!.signal('two', 'Y');
    await handle!.signal('four', 'F');
    expect(await handle!.result()).toEqual({ a: { x: 'X', y: 'Y' }, b: 'F' });
  });

  it('commits the last nested branch with its signal, before a sibling commits (a nested step that waits)', async () => {
    // The nested step finishes when `one` arrives; the outer sibling then commits `three` before
    // branch `a` itself moves on. That commit must already hold the nested step's result.
    calls.length = 0;
    const storage = new MemoryStorage();
    const id = 'nested-finish-run';
    const document = doc('nested-finish', [
      parallel({
        a: [parallel({ x: [wait('one')] }), wait('five')],
        b: [wait('three'), wait('four')],
      }),
    ]);
    {
      await using original = await startEngine(storage, document);
      const run = await original.start(document.name, null, { id });
      await waitUntil(async () => isWaitingOn(original, id, 'one', 'three'), {
        message: 'both branches to wait',
      });
      await run.signal('one', 'X');
      await run.signal('three', 'T');
      await waitUntil(async () => isWaitingOn(original, id, 'five', 'four'), {
        message: 'both branches to move on',
      });
      await waitUntil(async () => (await committedStepCount(storage, id, 1)) === 1, {
        message: 'branch b`s first step to be committed',
      });
    }
    await using restarted = await startEngine(storage, document);
    const [handle] = await restarted.recoverAll();
    await waitUntil(async () => isWaitingOn(restarted, id, 'five', 'four'), {
      message: 'the open waits to wait again',
    });
    expect(await waitingNames(restarted, id)).toEqual(['five', 'four']);
    await handle!.signal('five', 'V');
    await handle!.signal('four', 'F');
    expect(await handle!.result()).toEqual({ a: 'V', b: 'F' });
  });

  it('holds a wait a nested branch opens later on a signal an outer sibling waits on (review probe 3)', async () => {
    calls.length = 0;
    const storage = new MemoryStorage();
    const id = 'nested-same-signal-run';
    const document = doc('nested-same-signal', [
      parallel({
        left: [parallel({ a: [wait('x'), wait('y')], b: [wait('z')] })],
        right: [wait('t'), wait('y')],
      }),
    ]);
    {
      await using original = await startEngine(storage, document);
      const run = await original.start(document.name, null, { id });
      await waitUntil(async () => isWaitingOn(original, id, 'x', 'z', 't'), {
        message: 'every branch to wait',
      });
      await run.signal('x', 'X');
      await waitUntil(async () => isWaitingOn(original, id, 'y'), {
        message: 'the nested branch to wait on y',
      });
      await run.signal('t', 'T');
      await waitUntil(async () => (await committedStepCount(storage, id, 1)) === 1, {
        message: 'branch right`s first step to be committed',
      });
    }
    await using restarted = await startEngine(storage, document);
    const [handle] = await restarted.recoverAll();
    await waitUntil(async () => isWaitingOn(restarted, id, 'y', 'z'), {
      message: 'the open waits to wait again',
    });
    await handle!.signal('y', 'Y1');
    // One delivery answers one wait: the held one opens and waits for a delivery of its own.
    await waitUntil(async () => !(await hasBufferedSignal(storage, id, 'y')), {
      message: 'the first y to be taken',
    });
    await waitUntil(async () => isWaitingOn(restarted, id, 'y'), {
      message: 'the held wait on y to open',
    });
    await handle!.signal('y', 'Y2');
    await handle!.signal('z', 'Z');
    expect(await handle!.result()).toEqual({ left: { a: 'Y1', b: 'Z' }, right: 'Y2' });
  });
});

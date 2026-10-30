/** The record revision and resync mark (COR-1669, part 2b-3): additive, absent reads as 0. */
import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import { MemoryStorage, textValueStore } from '@lostgradient/storage';
import { describe, expect, it } from 'bun:test';

import { createTaskRegistry, TASK_RECORD_KEY_PREFIX } from './task-registry';

function build() {
  const runtime = createManualRuntimeServices({ origin: '2026-10-18T00:00:00.000Z' });
  const kv = textValueStore(new MemoryStorage());
  const registry = createTaskRegistry({
    kv,
    clock: runtime.clock,
    identifiers: runtime.identifiers,
    host: {
      liveTask: () => undefined,
      liveTasksOfContexts: () => new Map(),
      pendingReviews: () => [],
      currentIncarnation: async () => 'incarnation-1',
      abort: () => 'not-found',
      cancelChild: async () => 'not-found',
      cancelDurable: async () => ({ status: 'requested' }),
      sleep: async () => undefined,
    },
    diagnose: () => undefined,
  });
  return { registry, kv };
}

type Built = ReturnType<typeof build>['registry'];

/** A task's record, read for one field. */
async function recordOf(registry: Built, taskId: string) {
  return registry.record(taskId);
}

async function admitted() {
  const built = build();
  await built.registry.recordAdmission({
    taskId: 'task-1',
    contextId: 'context-1',
    incarnation: 'incarnation-1',
    agentName: 'assistant',
    owner: 'api-key:alice',
    origin: { kind: 'api' },
    message: 'hello',
  });
  return built;
}

describe('the task record revision and resync mark', () => {
  it('counts each change of the record, and a mark is not a change', async () => {
    const { registry } = await admitted();
    const before = await recordOf(registry, 'task-1');
    expect(before?.revision ?? 0).toBe(0);
    await registry.recordSettled('task-1', {
      at: '2026-10-18T00:00:01.000Z',
      status: 'completed',
      finishReason: 'stop',
      message: null,
    });
    const settled = await recordOf(registry, 'task-1');
    expect(settled?.revision).toBe(1);

    expect(await registry.markResyncPending('task-1')).toBe(true);
    const marked = await recordOf(registry, 'task-1');
    expect(marked?.revision).toBe(1);
    expect(marked?.resyncPending).toBe(true);
  });

  it('clears the mark only at the revision the repair read', async () => {
    const { registry } = await admitted();
    await registry.markResyncPending('task-1');
    await registry.recordSettled('task-1', {
      at: '2026-10-18T00:00:01.000Z',
      status: 'failed',
      finishReason: 'error',
      message: 'boom',
    });
    // The repair read revision 0; the record has since changed.
    expect(await registry.clearResyncPending('task-1', 0)).toBe(false);
    const kept = await recordOf(registry, 'task-1');
    expect(kept?.resyncPending).toBe(true);
    expect(await registry.clearResyncPending('task-1', 1)).toBe(true);
    const cleared = await recordOf(registry, 'task-1');
    expect(cleared?.resyncPending).toBeUndefined();
  });

  it('answers false for a task with no record, and lists a marked session run', async () => {
    const { registry } = await admitted();
    expect(await registry.markResyncPending('no-such-task')).toBe(false);
    expect(await registry.resyncCandidates()).toEqual([]);
    await registry.markResyncPending('task-1');
    const candidates = await registry.resyncCandidates();
    expect(candidates.map((record) => record.taskId)).toEqual(['task-1']);
  });

  it('reads a record written before the fields existed', async () => {
    const { registry, kv } = await admitted();
    const key = `${TASK_RECORD_KEY_PREFIX}task-1`;
    const record = JSON.parse((await kv.get(key)) ?? '{}') as Record<string, unknown>;
    delete record['revision'];
    delete record['resyncPending'];
    await kv.set(key, JSON.stringify(record));
    const read = await registry.record('task-1');
    expect(read?.taskId).toBe('task-1');
    expect(read?.revision ?? 0).toBe(0);
    expect(await registry.markResyncPending('task-1')).toBe(true);
  });
});

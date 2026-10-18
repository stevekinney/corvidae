/**
 * COR-718 — a deleted session's owner across a restart. The first Bureau's outbox
 * drain is blocked, so the deletion is committed but undrained when it is disposed.
 * A second Bureau on the same storage replays the deletion, with an empty in-memory
 * map: everything it knows about the owner it reads back from the key-value store.
 */
import { type GenerateFunction, stopWhen } from '@lostgradient/operative';
import { MemoryStorage, textValueStore } from '@lostgradient/weft';
import { describe, expect, it } from 'bun:test';

import { createBureau } from './create-bureau';
import { waitForCondition } from './test';

const generate: GenerateFunction = async () => ({ content: 'Done.', toolCalls: [] });
const SIDE_RECORD_PREFIX = 'session-deletion-owner:v1:';

type TextStore = ReturnType<typeof textValueStore>;

/** Wraps `base` so its method calls can be intercepted by name, without changing its type. */
function intercepted(
  base: TextStore,
  intercept: (method: string, args: unknown[]) => Promise<unknown> | undefined,
): TextStore {
  return new Proxy(base, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) =>
        intercept(String(property), args) ??
        (value as (...a: unknown[]) => unknown).apply(target, args);
    },
  });
}

/** A first Bureau whose outbox cannot be listed once `blocked.value` is set, so nothing drains in-process. */
async function openBlockedBureau(storage: MemoryStorage, blocked: { value: boolean }) {
  const base = textValueStore(storage, { disposeUnderlyingStorage: false });
  const persistence = intercepted(base, (method, args) =>
    method === 'list' && blocked.value && String(args[0]).startsWith('agent-session-outbox')
      ? Promise.reject(new Error('injected: outbox unavailable'))
      : undefined,
  );
  const bureau = await createBureau({
    agents: {},
    generate,
    persistence,
    stopWhen: stopWhen.noToolCalls(),
  });
  return { bureau, base };
}

type FirstBureau = Awaited<ReturnType<typeof openBlockedBureau>>['bureau'];

async function settled(bureau: FirstBureau, principal: string, sessionId: string) {
  const run = await bureau.createRun({ message: 'hello', sessionId, principal });
  await waitForCondition(
    () => bureau.getRun(run.id)?.status !== 'running',
    `run ${run.id} never settled`,
  );
}

async function deletionEntries(
  bureau: { auditTrail: FirstBureau['auditTrail'] },
  sessionId: string,
) {
  const entries = await bureau.auditTrail?.query({
    runId: `session:${sessionId}`,
    type: 'session.deleted',
  });
  return entries ?? [];
}

const ownerOf = (entry: { detail: unknown }) => (entry.detail as { owner?: string }).owner;

describe('a session deletion replayed after a restart (COR-718)', () => {
  it('carries the owner it reads back from the key-value store, and removes the side record', async () => {
    const storage = new MemoryStorage();
    const blocked = { value: false };
    const { bureau: first, base } = await openBlockedBureau(storage, blocked);
    await settled(first, 'api-key:alice', 'replayed');
    blocked.value = true;
    await first.deleteSession('replayed').catch(() => undefined);
    expect(await deletionEntries(first, 'replayed')).toHaveLength(0);
    expect(await base.list(SIDE_RECORD_PREFIX)).toHaveLength(1);
    await first.dispose().catch(() => undefined);

    const second = await createBureau({
      agents: {},
      generate,
      persistence: textValueStore(storage, { disposeUnderlyingStorage: false }),
      stopWhen: stopWhen.noToolCalls(),
    });
    try {
      await second.runDurableMaintenance();
      await waitForCondition(
        async () => (await deletionEntries(second, 'replayed')).length === 1,
        'the replayed deletion never reached the audit trail',
      );

      const [entry] = await deletionEntries(second, 'replayed');
      expect(entry && ownerOf(entry)).toBe('api-key:alice');
      expect(await base.list(SIDE_RECORD_PREFIX)).toHaveLength(0);
    } finally {
      await second.dispose();
    }
  });

  it('keeps each undrained deletion of one id under the owner of its own incarnation', async () => {
    const storage = new MemoryStorage();
    const blocked = { value: false };
    const { bureau: first, base } = await openBlockedBureau(storage, blocked);
    await settled(first, 'api-key:alice', 'reused');
    blocked.value = true;
    await first.deleteSession('reused').catch(() => undefined);
    // The drain stays blocked, so Alice's deletion is still pending when Bob recreates the id.
    await settled(first, 'api-key:bob', 'reused');
    await first.deleteSession('reused').catch(() => undefined);
    expect(await base.list(SIDE_RECORD_PREFIX)).toHaveLength(2);
    await first.dispose().catch(() => undefined);

    const second = await createBureau({
      agents: {},
      generate,
      persistence: textValueStore(storage, { disposeUnderlyingStorage: false }),
      stopWhen: stopWhen.noToolCalls(),
    });
    try {
      await second.runDurableMaintenance();
      await waitForCondition(
        async () => (await deletionEntries(second, 'reused')).length === 2,
        'the replayed deletions never reached the audit trail',
      );

      const entries = await deletionEntries(second, 'reused');
      const incarnations = entries.map(
        (entry) => (entry.detail as { incarnation: string }).incarnation,
      );
      expect(new Set(incarnations).size).toBe(2);
      expect(entries.map((entry) => ownerOf(entry)).toSorted()).toEqual([
        'api-key:alice',
        'api-key:bob',
      ]);
      expect(await base.list(SIDE_RECORD_PREFIX)).toHaveLength(0);
    } finally {
      await second.dispose();
    }
  });

  it('leaves the deletion pending, owner intact, when reading the owner record fails', async () => {
    const storage = new MemoryStorage();
    const blocked = { value: false };
    const { bureau: first, base } = await openBlockedBureau(storage, blocked);
    await settled(first, 'api-key:alice', 'retried');
    blocked.value = true;
    await first.deleteSession('retried').catch(() => undefined);
    await first.dispose().catch(() => undefined);

    const reading = { fails: true };
    const flaky = intercepted(
      textValueStore(storage, { disposeUnderlyingStorage: false }),
      (method, args) => {
        if (method === 'get' && String(args[0]).startsWith(SIDE_RECORD_PREFIX) && reading.fails) {
          return Promise.reject(new Error('injected: transient read failure'));
        }
        return undefined;
      },
    );
    const second = await createBureau({
      agents: {},
      generate,
      persistence: flaky,
      stopWhen: stopWhen.noToolCalls(),
    });
    try {
      // Boot drained while every read of the owner record failed, so the deletion was neither audited nor acknowledged,
      // and the only copy of the owner is still there.
      expect(await deletionEntries(second, 'retried')).toHaveLength(0);
      expect(await base.list(SIDE_RECORD_PREFIX)).toHaveLength(1);

      reading.fails = false;
      await second.runDurableMaintenance();
      await waitForCondition(
        async () => (await deletionEntries(second, 'retried')).length === 1,
        'the retried deletion never reached the audit trail',
      );
      const [entry] = await deletionEntries(second, 'retried');
      expect(entry && ownerOf(entry)).toBe('api-key:alice');
      expect(await base.list(SIDE_RECORD_PREFIX)).toHaveLength(0);
    } finally {
      await second.dispose();
    }
  });
});

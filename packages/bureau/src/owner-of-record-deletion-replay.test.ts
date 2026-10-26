/**
 * COR-718 — a deleted session's owner across a restart. The first Bureau's outbox
 * drain is blocked, so the deletion is committed but undrained when it is disposed.
 * A second Bureau on the same storage replays the deletion, with an empty in-memory
 * map: everything it knows about the owner it reads back from the key-value store.
 */
import { type GenerateFunction, stopWhen, createAgent } from '@lostgradient/operative';
import { MemoryStorage, textValueStore } from '@lostgradient/weft';
import { describe, expect, it } from 'bun:test';

import { createBureau } from './create-bureau';
import { waitForCondition } from './test';
import type { AgentDefinitions } from './agent-catalog';
import { storageOverTextStore } from './testing/text-store-storage.test-support';

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
  const bureau = await createBureau<AgentDefinitions>({
    agents: {
      default: createAgent({ generate, stopWhen: stopWhen.noToolCalls() }),
    },
    storage: storageOverTextStore(persistence),
    durable: false,
  });
  return { bureau, base };
}

type FirstBureau = Awaited<ReturnType<typeof openBlockedBureau>>['bureau'];

async function settled(bureau: FirstBureau, principal: string, sessionId: string) {
  const run = await bureau.createRun({
    agentName: 'default',
    message: 'hello',
    sessionId,
    principal,
  });
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

async function deletionCount(bureau: { auditTrail: FirstBureau['auditTrail'] }, sessionId: string) {
  const entries = await deletionEntries(bureau, sessionId);
  return entries.length;
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

    const second = await createBureau<AgentDefinitions>({
      agents: {
        default: createAgent({ generate, stopWhen: stopWhen.noToolCalls() }),
      },
      storage: storage,
      durable: false,
    });
    try {
      await second.runDurableMaintenance();
      await waitForCondition(
        async () => (await deletionCount(second, 'replayed')) === 1,
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

    const second = await createBureau<AgentDefinitions>({
      agents: {
        default: createAgent({ generate, stopWhen: stopWhen.noToolCalls() }),
      },
      storage: storage,
      durable: false,
    });
    try {
      await second.runDurableMaintenance();
      await waitForCondition(
        async () => (await deletionCount(second, 'reused')) === 2,
        'the replayed deletions never reached the audit trail',
      );

      const entries = await deletionEntries(second, 'reused');
      const incarnations = entries.map(
        (entry) => (entry.detail as { incarnation: string }).incarnation,
      );
      expect(new Set(incarnations).size).toBe(2);
      expect(
        entries
          .map((entry) => ownerOf(entry))
          .toSorted((left, right) => String(left).localeCompare(String(right))),
      ).toEqual(['api-key:alice', 'api-key:bob']);
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
    const second = await createBureau<AgentDefinitions>({
      agents: {
        default: createAgent({ generate, stopWhen: stopWhen.noToolCalls() }),
      },
      storage: storageOverTextStore(flaky),
      durable: false,
    });
    try {
      // Boot drained while every read of the owner record failed, so the deletion was neither audited nor acknowledged,
      // and the only copy of the owner is still there.
      expect(await deletionEntries(second, 'retried')).toHaveLength(0);
      expect(await base.list(SIDE_RECORD_PREFIX)).toHaveLength(1);

      reading.fails = false;
      await second.runDurableMaintenance();
      await waitForCondition(
        async () => (await deletionCount(second, 'retried')) === 1,
        'the retried deletion never reached the audit trail',
      );
      const [entry] = await deletionEntries(second, 'retried');
      expect(entry && ownerOf(entry)).toBe('api-key:alice');
      expect(await base.list(SIDE_RECORD_PREFIX)).toHaveLength(0);
    } finally {
      await second.dispose();
    }
  });

  it('treats an owner record that cannot be decoded as a definite miss, so it never jams the outbox', async () => {
    const storage = new MemoryStorage();
    const blocked = { value: false };
    const { bureau: first, base } = await openBlockedBureau(storage, blocked);
    await settled(first, 'api-key:alice', 'poisoned');
    blocked.value = true;
    await first.deleteSession('poisoned').catch(() => undefined);
    await first.dispose().catch(() => undefined);
    const [sideKey] = await base.list(SIDE_RECORD_PREFIX);
    // Bytes that are not valid UTF-8, so every read of the record throws.
    await storage.put(sideKey!, new Uint8Array([0xff, 0xfe, 0xfd]));

    const second = await createBureau<AgentDefinitions>({
      agents: {
        default: createAgent({ generate, stopWhen: stopWhen.noToolCalls() }),
      },
      storage: storage,
      durable: false,
    });
    try {
      // Another session's deletion queues behind the poisoned one.
      await settled(second, 'api-key:bob', 'later');
      await second.deleteSession('later');
      await second.runDurableMaintenance();
      await waitForCondition(
        async () => (await deletionCount(second, 'later')) === 1,
        'a later deletion never reached the audit trail behind the poisoned record',
      );

      expect(await deletionCount(second, 'poisoned')).toBe(1);
      const [entry] = await deletionEntries(second, 'poisoned');
      expect(entry?.detail).not.toHaveProperty('owner');
      expect(await base.list(SIDE_RECORD_PREFIX)).toHaveLength(0);
    } finally {
      await second.dispose();
    }
  });

  it('keeps the owner when the store fails with a TypeError of its own, as an unreachable HTTP store does', async () => {
    const storage = new MemoryStorage();
    const blocked = { value: false };
    const { bureau: first, base } = await openBlockedBureau(storage, blocked);
    await settled(first, 'api-key:alice', 'unreachable');
    blocked.value = true;
    await first.deleteSession('unreachable').catch(() => undefined);
    await first.dispose().catch(() => undefined);

    const reading = { fails: true };
    const second = await createBureau<AgentDefinitions>({
      agents: {
        default: createAgent({ generate, stopWhen: stopWhen.noToolCalls() }),
      },
      storage: storageOverTextStore(
        intercepted(textValueStore(storage, { disposeUnderlyingStorage: false }), (method, args) =>
          method === 'get' && String(args[0]).startsWith(SIDE_RECORD_PREFIX) && reading.fails
            ? Promise.reject(
                new TypeError('Unable to connect. Is the computer able to access the url?'),
              )
            : undefined,
        ),
      ),
      durable: false,
    });
    try {
      // The failure is the store's, not the record's: the deletion waits, owner intact.
      expect(await deletionCount(second, 'unreachable')).toBe(0);
      expect(await base.list(SIDE_RECORD_PREFIX)).toHaveLength(1);

      reading.fails = false;
      await second.runDurableMaintenance();
      await waitForCondition(
        async () => (await deletionCount(second, 'unreachable')) === 1,
        'the deletion never reached the audit trail once the store recovered',
      );
      const [entry] = await deletionEntries(second, 'unreachable');
      expect(entry && ownerOf(entry)).toBe('api-key:alice');
    } finally {
      await second.dispose();
    }
  });
});

import { type GenerateFunction, stopWhen, createAgent } from '@lostgradient/operative';
import { describe, expect, it } from 'bun:test';

import { createBureau } from './create-bureau';
import { waitForCondition } from './test';
import { rejectionOf } from './testing/promise-outcome.test-support.ts';
import type { AgentDefinitions } from './agent-catalog';

const generate: GenerateFunction = async () => ({ content: 'Done.', toolCalls: [] });

async function openBureau() {
  return createBureau<AgentDefinitions>({
    agents: {
      default: createAgent({ generate, stopWhen: stopWhen.noToolCalls() }),
    },
    storage: { type: 'memory' },
    durable: false,
  });
}

type OpenBureau = Awaited<ReturnType<typeof openBureau>>;

async function createdSession(
  bureau: OpenBureau,
  principal: string | undefined,
  sessionId: string,
) {
  const run = await bureau.createRun({
    agentName: 'default',
    message: 'hello',
    sessionId,
    ...(principal === undefined ? {} : { principal }),
  });
  await waitForCondition(
    () => bureau.getRun(run.id)?.status !== 'running',
    `run ${run.id} never settled`,
  );
  return run;
}

/** The `session.deleted` audit entries for one session id, once the audit trail holds `count`. */
async function deletionEntries(bureau: OpenBureau, sessionId: string, count: number) {
  const runId = `session:${sessionId}`;
  await waitForCondition(async () => {
    const entries = await bureau.internals.auditTrail?.query({ runId, type: 'session.deleted' });
    return entries?.length === count;
  }, `the audit trail never held ${count} session.deleted entries for ${sessionId}`);
  return (await bureau.internals.auditTrail?.query({ runId, type: 'session.deleted' })) ?? [];
}

const SIDE_RECORD_PREFIX = 'session-deletion-owner:v1:';

describe('the owner of a deleted session’s audit entry (COR-718)', () => {
  it('carries the owner in the deletion record, which never reads the live session', async () => {
    const bureau = await openBureau();
    try {
      await createdSession(bureau, 'api-key:alice', 'deleted-session');
      await bureau.contexts.delete('deleted-session');
      await bureau.runDurableMaintenance();

      const [entry] = await deletionEntries(bureau, 'deleted-session', 1);

      expect(entry?.detail).toMatchObject({ sessionId: 'deleted-session', owner: 'api-key:alice' });
      expect(
        await bureau.getOwner({
          kind: 'audit',
          runId: 'session:deleted-session',
          detail: entry?.detail,
        }),
      ).toBe('api-key:alice');
      // The session itself is gone, so the answer cannot have come from it.
      expect(await bureau.getOwner({ kind: 'session', id: 'deleted-session' })).toBeUndefined();
    } finally {
      await bureau.dispose();
    }
  });

  it('keeps reporting the first owner after another principal recreates the session id', async () => {
    const bureau = await openBureau();
    try {
      await createdSession(bureau, 'api-key:alice', 'recreated-session');
      await bureau.contexts.delete('recreated-session');
      await bureau.runDurableMaintenance();
      const [entry] = await deletionEntries(bureau, 'recreated-session', 1);

      await createdSession(bureau, 'api-key:bob', 'recreated-session');

      expect(await bureau.getOwner({ kind: 'session', id: 'recreated-session' })).toBe(
        'api-key:bob',
      );
      expect(
        await bureau.getOwner({
          kind: 'audit',
          runId: 'session:recreated-session',
          detail: entry?.detail,
        }),
      ).toBe('api-key:alice');
    } finally {
      await bureau.dispose();
    }
  });

  it('removes its side record once the audit entry is written', async () => {
    const bureau = await openBureau();
    try {
      await createdSession(bureau, 'api-key:alice', 'tidy-session');
      await bureau.contexts.delete('tidy-session');
      await bureau.runDurableMaintenance();
      await deletionEntries(bureau, 'tidy-session', 1);

      await waitForCondition(async () => {
        const remaining = await bureau.internals.kv?.list(SIDE_RECORD_PREFIX);
        return remaining?.length === 0;
      }, 'the side record outlived the audit entry');
    } finally {
      await bureau.dispose();
    }
  });

  it('deletes nothing when the owner cannot be recorded first, so the caller can retry', async () => {
    const bureau = await openBureau();
    try {
      await createdSession(bureau, 'api-key:alice', 'retained-session');
      const kv = bureau.internals.kv!;
      const originalSet = kv.set.bind(kv);
      kv.set = async (key: string, value: string) => {
        if (key.startsWith(SIDE_RECORD_PREFIX)) throw new Error('injected: owner store down');
        return originalSet(key, value);
      };

      const refusal = await rejectionOf(bureau.contexts.delete('retained-session'));
      expect(String(refusal)).toContain('injected');
      expect(await bureau.contexts.get('retained-session')).toBeDefined();
      const pending = await bureau.internals.sessionStore!.outbox.pending();
      expect(pending.filter((entry) => entry.kind === 'session.deleted')).toEqual([]);
      expect(
        await bureau.internals.auditTrail?.query({ runId: 'session:retained-session' }),
      ).toEqual([]);

      kv.set = originalSet;
      await bureau.contexts.delete('retained-session');
      await bureau.runDurableMaintenance();
      const [entry] = await deletionEntries(bureau, 'retained-session', 1);
      expect(entry?.detail).toMatchObject({ owner: 'api-key:alice' });
    } finally {
      await bureau.dispose();
    }
  });

  it('leaves the entry without an owner when the deletion bypassed Bureau, so only operators see it', async () => {
    const bureau = await openBureau();
    try {
      await createdSession(bureau, 'api-key:alice', 'bypassed-session');
      await bureau.internals.sessionStore?.delete('bypassed-session');
      await bureau.runDurableMaintenance();

      const [entry] = await deletionEntries(bureau, 'bypassed-session', 1);

      expect(entry?.detail).not.toHaveProperty('owner');
      expect(
        await bureau.getOwner({
          kind: 'audit',
          runId: 'session:bypassed-session',
          detail: entry?.detail,
        }),
      ).toBeUndefined();
      expect(
        await bureau.getOwner({ kind: 'audit', runId: 'session:bypassed-session' }),
      ).toBeUndefined();
    } finally {
      await bureau.dispose();
    }
  });
});

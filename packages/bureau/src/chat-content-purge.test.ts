/**
 * COR-1934 — the pending record, the sweep and the guards of a deleted chat's content purge, over
 * stubs, so each cell of the lifecycle is a case: a run that has not ended, events still in the
 * session outbox, a chat that still exists, and a chat recreated under the same id.
 */
import { MemoryStorage, textValueStore } from '@lostgradient/storage';
import { describe, expect, it } from 'bun:test';

import type { AuditTrail } from './audit-trail';
import { ChatRunsNotEndedError, createChatContentPurge } from './chat-content-purge';
import type { DurableEventHistory, DurableEventProducer } from './durable-event-history';
import type { BureauDiagnostic } from './types';

const PENDING_PREFIX = 'chat-content-purge-pending:v1:';

interface Calls {
  readonly events: string[];
  readonly redacted: string[][];
  readonly workflows: string[];
}

function setup(
  options: {
    ended?: (runId: string) => boolean;
    undrained?: () => boolean;
    incarnation?: () => string | undefined;
  } = {},
) {
  const kv = textValueStore(new MemoryStorage());
  const calls: Calls = { events: [], redacted: [], workflows: [] };
  const diagnostics: BureauDiagnostic[] = [];
  const history = {
    async purgeOwner(
      owner: { kind: string; id: string },
      purgeOptions?: { incarnation?: string | undefined; keepKinds?: ReadonlySet<string> },
    ) {
      calls.events.push(
        `${owner.kind}:${owner.id}${purgeOptions?.incarnation === undefined ? '' : `@${purgeOptions.incarnation}`}${purgeOptions?.keepKinds?.has('session.deleted') === true ? '+keep' : ''}`,
      );
      return 0;
    },
  } as unknown as DurableEventHistory;
  const producer = {
    async waitForActiveWrites() {},
  } as unknown as DurableEventProducer;
  const audit = {
    async redact(runIds: ReadonlySet<string>) {
      calls.redacted.push([...runIds]);
      return runIds.size;
    },
  } as unknown as AuditTrail;
  const purge = createChatContentPurge({
    kv,
    history: () => history,
    producer: () => producer,
    audit: () => audit,
    runEnded: async (runId) => options.ended?.(runId) ?? true,
    purgeRun: async (runId) => {
      calls.workflows.push(runId);
    },
    hasUndrainedEvents: async () => options.undrained?.() ?? false,
    currentIncarnation: async () =>
      options.incarnation === undefined ? undefined : options.incarnation(),
    diagnose: (diagnostic) => diagnostics.push(diagnostic),
  });
  return { kv, calls, diagnostics, purge };
}

const CHAT = { sessionId: 'chat-1', incarnation: 'one', runIds: ['run-1', 'run-2', 'run-1'] };

describe('createChatContentPurge (COR-1934)', () => {
  it('purges each run once and the chat of its incarnation, keeping its deletion marker, then drops the record', async () => {
    const { kv, calls, purge } = setup();
    await purge.record(CHAT);
    expect(await kv.list(PENDING_PREFIX)).toHaveLength(1);

    await purge.run(CHAT);

    expect(calls.events).toEqual(['run:run-1', 'run:run-2', 'session:chat-1@one+keep']);
    expect(calls.workflows).toEqual(['run-1', 'run-2']);
    expect(calls.redacted).toEqual([['run-1', 'run-2']]);
    expect(await kv.list(PENDING_PREFIX)).toEqual([]);
  });

  it('purges the runs that have ended, keeps the record, and finishes once the rest have', async () => {
    let ended = false;
    const { kv, calls, diagnostics, purge } = setup({
      ended: (runId) => runId !== 'run-2' || ended,
      incarnation: () => undefined,
    });
    await purge.record(CHAT);

    const error = await purge.run(CHAT).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ChatRunsNotEndedError);
    expect(calls.events).toEqual(['run:run-1', 'session:chat-1@one+keep']);
    expect(calls.workflows).toEqual(['run-1']);
    expect(calls.redacted).toEqual([['run-1']]);
    expect(await kv.list(PENDING_PREFIX)).toHaveLength(1);

    // The sweep reports it as a warning, not an error, and comes back.
    expect(await purge.sweep()).toBe(0);
    expect(diagnostics.map((entry) => entry.level)).toEqual(['warn']);
    ended = true;
    expect(await purge.sweep()).toBe(1);
    // Each pass purges what has ended again, which is idempotent; the last also takes run-2.
    expect(calls.workflows).toEqual(['run-1', 'run-1', 'run-1', 'run-2']);
    expect(await kv.list(PENDING_PREFIX)).toEqual([]);
  });

  it('purges nothing while events of the chat are still in the session outbox', async () => {
    let undrained = true;
    const { kv, calls, purge } = setup({
      undrained: () => undrained,
      incarnation: () => undefined,
    });
    await purge.record(CHAT);

    expect(await purge.sweep()).toBe(0);
    expect(calls.events).toEqual([]);
    expect(await kv.list(PENDING_PREFIX)).toHaveLength(1);

    undrained = false;
    expect(await purge.sweep()).toBe(1);
    expect(calls.events).toHaveLength(3);
  });

  it('leaves the record of a chat that still exists under its incarnation, and purges it when another holds the id', async () => {
    let incarnation: string | undefined = 'one';
    const { kv, calls, purge } = setup({ incarnation: () => incarnation });
    await purge.record(CHAT);

    // Its delete has not committed: nothing is purged and the record stays for the delete that does.
    expect(await purge.sweep()).toBe(0);
    expect(calls.events).toEqual([]);
    expect(await kv.list(PENDING_PREFIX)).toHaveLength(1);

    // The id was deleted and used again: the old incarnation's content goes, the new one's stays.
    incarnation = 'two';
    expect(await purge.sweep()).toBe(1);
    expect(calls.events).toEqual(['run:run-1', 'run:run-2', 'session:chat-1@one+keep']);
    expect(await kv.list(PENDING_PREFIX)).toEqual([]);
  });

  it('shares one pass between concurrent calls for the same chat', async () => {
    const { calls, purge } = setup();
    await purge.record(CHAT);

    await Promise.all([purge.run(CHAT), purge.run(CHAT)]);

    expect(calls.workflows).toEqual(['run-1', 'run-2']);
  });

  it('refuses to record when the store cannot, and forgets a record on request', async () => {
    const { kv, purge } = setup();
    const set = kv.set.bind(kv);
    kv.set = async () => {
      throw new Error('injected');
    };
    const refusal = await purge.record(CHAT).catch((reason: unknown) => reason);
    expect(String(refusal)).toContain('the chat was not deleted');
    kv.set = set;

    await purge.record(CHAT);
    await purge.forget(CHAT);
    expect(await kv.list(PENDING_PREFIX)).toEqual([]);
  });

  it('leaves an unreadable record in place and reports it', async () => {
    const { kv, diagnostics, purge } = setup();
    await kv.set(`${PENDING_PREFIX}garbage`, '{not json');

    expect(await purge.sweep()).toBe(0);

    expect(await kv.list(PENDING_PREFIX)).toHaveLength(1);
    expect(diagnostics.map((entry) => entry.level)).toEqual(['error']);
  });
});

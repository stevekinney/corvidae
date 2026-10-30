/**
 * COR-1915 — the chat spend ledger: one record per run, written once however often it is replayed,
 * summed per chat and incarnation, keyed so no chat's records are another's, and carried across a
 * restart by the store.
 */
import { MemoryStorage, textValueStore } from '@lostgradient/storage';
import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { describe, expect, it } from 'bun:test';

import { CHAT_SPEND_KEY_PREFIX, createChatSpendLedger } from './chat-spend-ledger';
import type { BureauDiagnostic } from './types';

const OWNER = 'anonymous:local';

function input(runId: string, usd: number, overrides: Record<string, unknown> = {}) {
  return {
    sessionId: 'chat-1',
    incarnation: 'one',
    runId,
    agentName: 'helper',
    owner: OWNER,
    usd,
    recordedAt: '2026-10-30T00:00:00.000Z',
    ...overrides,
  };
}

function setup() {
  const kv = textValueStore(new MemoryStorage());
  const diagnostics: BureauDiagnostic[] = [];
  const ledger = createChatSpendLedger({
    kv,
    diagnose: (diagnostic) => diagnostics.push(diagnostic),
  });
  return { kv, ledger, diagnostics };
}

describe('the chat spend ledger', () => {
  it('sums what the runs of a chat spent, and a chat with none has spent nothing', async () => {
    const { ledger } = setup();
    expect(await ledger.totalOf('chat-1', 'one')).toBe(0);
    await ledger.record(input('run-a', 0.25));
    await ledger.record(input('run-b', 0.5));
    expect(await ledger.totalOf('chat-1', 'one')).toBeCloseTo(0.75, 10);
  });

  it('counts a replayed run once: a second record of the same run changes nothing', async () => {
    const { ledger } = setup();
    expect(await ledger.record(input('run-a', 0.25))).toBe(true);
    expect(await ledger.record(input('run-a', 0.25))).toBe(false);
    // Even a replay that reports another figure cannot change what the first recorded.
    expect(await ledger.record(input('run-a', 9))).toBe(false);
    expect(await ledger.totalOf('chat-1', 'one')).toBe(0.25);
  });

  it('records two runs written at once, and a run written twice at once, exactly once each', async () => {
    const { ledger } = setup();
    const outcomes = await Promise.all([
      ledger.record(input('run-a', 0.1)),
      ledger.record(input('run-a', 0.1)),
      ledger.record(input('run-b', 0.2)),
    ]);
    expect(outcomes.filter(Boolean)).toHaveLength(2);
    expect(await ledger.totalOf('chat-1', 'one')).toBeCloseTo(0.3, 10);
  });

  it('keeps one chat’s records from another’s, including a session id that begins with another’s', async () => {
    const { ledger } = setup();
    await ledger.record(input('run-a', 1));
    await ledger.record(input('run-a', 2, { sessionId: 'chat-1:more' }));
    await ledger.record(input('run-a', 4, { sessionId: 'chat-2' }));
    expect(await ledger.totalOf('chat-1', 'one')).toBe(1);
    expect(await ledger.totalOf('chat-1:more', 'one')).toBe(2);
    expect(await ledger.totalOf('chat-2', 'one')).toBe(4);
  });

  it('ignores the records of an earlier incarnation of a chat, and forget removes only its own', async () => {
    const { ledger } = setup();
    await ledger.record(input('run-a', 1, { incarnation: 'old' }));
    await ledger.record(input('run-b', 2, { incarnation: 'new' }));
    expect(await ledger.totalOf('chat-1', 'new')).toBe(2);
    expect(await ledger.forget('chat-1', 'old')).toBe(1);
    expect(await ledger.totalOf('chat-1', 'old')).toBe(0);
    expect(await ledger.totalOf('chat-1', 'new')).toBe(2);
  });

  it('puts the incarnation in the key, so a chat’s records are one prefix and a late one is removed by it (COR-1933)', async () => {
    const { kv, ledger } = setup();
    await ledger.record(input('run-a', 1, { incarnation: 'old' }));
    await ledger.record(input('run-b', 2, { incarnation: 'new' }));
    expect(await kv.list(`${CHAT_SPEND_KEY_PREFIX}chat-1:old:`)).toHaveLength(1);
    expect(await kv.list(`${CHAT_SPEND_KEY_PREFIX}chat-1:new:`)).toHaveLength(1);

    expect(await ledger.forget('chat-1', 'old')).toBe(1);
    // A record written after the chat was forgotten (a run that ended after its deletion) is
    // left under the same prefix, and the next forget removes it without reading anything.
    await ledger.record(input('run-late', 4, { incarnation: 'old' }));
    expect(await kv.list(`${CHAT_SPEND_KEY_PREFIX}chat-1:old:`)).toHaveLength(1);
    expect(await ledger.forget('chat-1', 'old')).toBe(1);
    expect(await kv.list(`${CHAT_SPEND_KEY_PREFIX}chat-1:old:`)).toHaveLength(0);
    expect(await ledger.totalOf('chat-1', 'new')).toBe(2);
  });

  it('does not count a version 1 record, and forget removes the ones of its incarnation (COR-1933)', async () => {
    const { kv, ledger } = setup();
    const legacy = (incarnation: string) =>
      JSON.stringify({ schemaVersion: 1, ...input('run-a', 8, { incarnation }) });
    await kv.set('bureau-chat-spend:v1:chat-1:run-old', legacy('old'));
    await kv.set('bureau-chat-spend:v1:chat-1:run-new', legacy('new'));
    expect(await ledger.totalOf('chat-1', 'old')).toBe(0);
    expect(await ledger.forget('chat-1', 'old')).toBe(1);
    expect(await kv.list('bureau-chat-spend:v1:chat-1:')).toEqual([
      'bureau-chat-spend:v1:chat-1:run-new',
    ]);
  });

  it('stores the owner and the incarnation on every record, under the reserved prefix', async () => {
    const { kv, ledger } = setup();
    await ledger.record(input('run-a', 0.25, { owner: 'api-key:alice' }));
    const keys = await kv.list(CHAT_SPEND_KEY_PREFIX);
    expect(keys).toHaveLength(1);
    expect(JSON.parse((await kv.get(keys[0] as string)) as string)).toMatchObject({
      schemaVersion: 1,
      owner: 'api-key:alice',
      incarnation: 'one',
      sessionId: 'chat-1',
      runId: 'run-a',
      usd: 0.25,
    });
  });

  it('survives a restart: a ledger over the same store reads what the first recorded', async () => {
    const { kv, ledger } = setup();
    await ledger.record(input('run-a', 0.4));
    const restarted = createChatSpendLedger({ kv, diagnose: () => undefined });
    expect(await restarted.totalOf('chat-1', 'one')).toBe(0.4);
    expect(await restarted.record(input('run-a', 0.4))).toBe(false);
  });

  it('refuses to total a chat whose record it cannot read, rather than counting it as nothing', async () => {
    const { kv, ledger } = setup();
    await kv.set(`${CHAT_SPEND_KEY_PREFIX}chat-1:one:broken`, '{"schemaVersion":2}');
    const error = await rejectionOf(ledger.totalOf('chat-1', 'one'));
    expect(error instanceof Error ? error.message : '').toContain('version 1');
  });

  it('diagnoses a write it gives up on, and says the chat falls short', async () => {
    const { kv, diagnostics } = setup();
    const failing = Object.assign(Object.create(kv), {
      conditionalBatch: async () => {
        throw new Error('disk full');
      },
    });
    const ledger = createChatSpendLedger({
      kv: failing,
      diagnose: (diagnostic) => diagnostics.push(diagnostic),
    });
    expect(await ledger.record(input('run-a', 0.25))).toBe(false);
    expect(diagnostics.map((diagnostic) => diagnostic.message).join('\n')).toContain('falls short');
  });
});

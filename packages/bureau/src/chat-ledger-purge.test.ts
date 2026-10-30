/**
 * COR-1934 — the command-ledger entries of a deleted chat go with it; another chat's stay.
 */
import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import { MemoryStorage, textValueStore } from '@lostgradient/storage';
import { describe, expect, it } from 'bun:test';

import {
  A2A_SEND_LEDGER_PREFIX,
  CHAT_LEDGER_KEY_PREFIXES,
  purgeChatLedgerEntries,
} from './chat-ledger-purge';
import { COMMAND_LEDGER_KEY_PREFIX, createCommandLedger } from './command-ledger';
import { A2A_SEND_LEDGER_KEY_PREFIX } from './http/a2a-request-handler';
import { TASKS_RESPOND_LEDGER_KEY_PREFIX } from './tasks/respond-to-task';

const identity = (target: string, requestId: string) => ({
  callerId: 'api-key:alice',
  target,
  requestId,
  operationVersion: 'v1',
});

describe('purgeChatLedgerEntries', () => {
  it('spells the A2A send ledger’s prefix as the request handler declares it', () => {
    expect(A2A_SEND_LEDGER_PREFIX).toBe(A2A_SEND_LEDGER_KEY_PREFIX);
    expect(CHAT_LEDGER_KEY_PREFIXES).toEqual([
      COMMAND_LEDGER_KEY_PREFIX,
      A2A_SEND_LEDGER_KEY_PREFIX,
      TASKS_RESPOND_LEDGER_KEY_PREFIX,
    ]);
  });

  it('deletes the entries of commands on the runs, with their conflicts, and leaves the rest, a recreated context’s included', async () => {
    const kv = textValueStore(new MemoryStorage());
    const runtime = createManualRuntimeServices();
    const clock = runtime.clock;
    const nextConflictId = () => runtime.identifiers.next('ledger-conflict');
    const respond = createCommandLedger<{ submission?: { value: unknown } }, { ok: true }>({
      kv,
      clock,
      nextConflictId,
      keyPrefix: TASKS_RESPOND_LEDGER_KEY_PREFIX,
    });
    const send = createCommandLedger<{ inbound?: unknown }, { taskId: string }>({
      kv,
      clock,
      nextConflictId,
      keyPrefix: A2A_SEND_LEDGER_PREFIX,
    });
    const creation = createCommandLedger<{ runId: string; sessionId: string }, { ok: true }>({
      kv,
      clock,
      nextConflictId,
    });
    // A pending respond claim with the answer, completed sends by target and by result, a run
    // creation by its claim, and a conflict record on the respond entry.
    await respond.claim(identity('run-1', 'm-1'), 'digest-a', { submission: { value: 'SECRET' } });
    await respond.claim(identity('run-1', 'm-1'), 'digest-b', {}).catch(() => undefined);
    const continued = await send.claim(identity('task:run-1', 'm-2'), 'd', { inbound: 'SECRET' });
    await send.complete(continued.entry as never, { taskId: 'run-1' });
    const created = await send.claim(identity('agent:helper', 'm-3'), 'd', {});
    await send.complete(created.entry as never, { taskId: 'run-2' });
    await creation.claim(identity('helper', 'm-4'), 'd', { runId: 'run-2', sessionId: 'chat-1' });
    // Another chat's entries, and a run of a context recreated under the deleted chat's id, whose
    // receipt the live context still replays; a value that merely equals a run id is not ownership.
    await respond.claim(identity('run-7', 'm-5'), 'd', { submission: { value: 'run-1' } });
    const theirs = await send.claim(identity('agent:helper', 'm-6'), 'd', {});
    await send.complete(theirs.entry as never, { taskId: 'run-8' });
    await creation.claim(identity('helper', 'm-7'), 'd', { runId: 'run-9', sessionId: 'chat-1' });
    const conflicts = await kv.list(`${TASKS_RESPOND_LEDGER_KEY_PREFIX}:conflict:`);
    expect(conflicts).toHaveLength(1);

    const deleted = await purgeChatLedgerEntries(kv, new Set(['run-1', 'run-2']));

    expect(deleted).toBe(4);
    const left = await kv.list('command-ledger:');
    expect(left.filter((key) => key.includes(':conflict:'))).toEqual([]);
    expect(new Set(left.map((key) => key.split(':').at(-2)))).toEqual(
      new Set(['m-5', 'm-6', 'm-7']),
    );
    for (const key of left) expect(await kv.get(key)).not.toContain('SECRET');
    expect(await purgeChatLedgerEntries(kv, new Set(['run-1', 'run-2']))).toBe(0);
  });
});

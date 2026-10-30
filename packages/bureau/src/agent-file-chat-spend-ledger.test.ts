/**
 * COR-1933 — follow-ups to the chat spend ledger (COR-1915), on real chats. A run's record is
 * written before the session records how the run ended, so a crash between the two is repaired by
 * recovery's replay; every way a run can end leaves exactly one record; a chat deleted while a run
 * is in flight leaves none behind; and a ledger that cannot be read refuses the next run with a
 * typed error.
 */
import { MemoryStorage, textValueStore } from '@lostgradient/storage';
import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { afterEach, describe, expect, it } from 'bun:test';

import { BureauError } from './create-bureau';
import type { BureauDiagnostic } from './types';
import { CHAT_SPEND_KEY_PREFIX } from './chat-spend-ledger';
import { agentFileText, KNOWN_MODEL } from './testing/agent-file-fixtures.test-support';
import { type FileBureauHarness, startFileBureau } from './testing/agent-file-bureau.test-support';

/** Opus 5.5 is $4 per million tokens in: 50,000 prompt tokens cost $0.20. */
const TWENTY_CENTS = { prompt: 50_000, completion: 0, total: 50_000 };

const SESSION_BODY_PREFIX = 'agent-session-v2:body:';

/**
 * A storage that logs the key of every write in order, so a test can say which of two records
 * reached the store first.
 */
function loggingStorage(base: MemoryStorage): { storage: MemoryStorage; writes: string[] } {
  const writes: string[] = [];
  const storage = new Proxy(base, {
    get(target, property, receiver) {
      if (property === 'conditionalBatch') {
        return (conditions: unknown, operations: readonly { type: string; key: string }[]) => {
          for (const operation of operations) {
            if (operation.type === 'put') writes.push(operation.key);
          }
          return (target as unknown as Record<string, (...input: unknown[]) => unknown>)[
            'conditionalBatch'
          ]?.(conditions, operations);
        };
      }
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { storage, writes };
}

describe.each(['non-durable', 'durable'] as const)(
  'the chat spend ledger on a file agent, %s dispatch',
  (dispatch) => {
    const harnesses: FileBureauHarness[] = [];
    const diagnostics: BureauDiagnostic[] = [];
    afterEach(async () => {
      for (const harness of harnesses.splice(0)) await harness.dispose();
    });

    async function start(
      frontmatter: Record<string, string>,
      script: () => unknown = () => ({ content: 'Done.', usage: TWENTY_CENTS }),
      storage: MemoryStorage = new MemoryStorage(),
    ) {
      const harness = await startFileBureau({
        scripts: { 'claude-opus-5-5': script as never },
        overrides: {
          durable: dispatch === 'durable',
          storage,
          onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
        },
      });
      harnesses.push(harness);
      await harness.put('helper.md', agentFileText({ model: KNOWN_MODEL, ...frontmatter }));
      await harness.bureau.agents.refresh();
      return { harness, bureau: harness.bureau, storage };
    }

    /** A model that spends on its first step, asks for a tool, and holds its second step. */
    function heldSecondStep() {
      const reached = Promise.withResolvers<void>();
      const gate = Promise.withResolvers<void>();
      let generations = 0;
      return {
        reached: reached.promise,
        release: gate.resolve,
        script: async () => {
          generations += 1;
          if (generations === 1) {
            return {
              content: '',
              usage: TWENTY_CENTS,
              toolCalls: [{ name: 'lookup-order', arguments: {} }],
            };
          }
          reached.resolve();
          await gate.promise;
          return { content: 'late', usage: TWENTY_CENTS };
        },
      };
    }

    function ledgerKeys(storage: MemoryStorage): Promise<string[]> {
      return textValueStore(storage, { disposeUnderlyingStorage: false }).list(
        CHAT_SPEND_KEY_PREFIX,
      );
    }

    it('writes a run’s record before the session records how the run ended', async () => {
      const logged = loggingStorage(new MemoryStorage());
      const { bureau } = await start(
        { costBudget: '{ perRunUsd: 5, perChatUsd: 9 }' },
        undefined,
        logged.storage,
      );
      const task = await bureau.tasks.start('helper', 'Go.');
      await task.result();
      await bureau.internals.whenTaskRecorded(task.id);

      const ledgerWrite = logged.writes.findIndex((key) => key.startsWith(CHAT_SPEND_KEY_PREFIX));
      const sessionWrites = logged.writes.flatMap((key, index) =>
        key.startsWith(SESSION_BODY_PREFIX) ? [index] : [],
      );
      expect(ledgerWrite).toBeGreaterThan(-1);
      // The run's start saved the session, and its end saved it again: the record sits between.
      expect(sessionWrites.length).toBeGreaterThanOrEqual(2);
      expect(ledgerWrite).toBeGreaterThan(sessionWrites[0] as number);
      expect(ledgerWrite).toBeLessThan(sessionWrites.at(-1) as number);
    });

    it('records a run that ends over its own budget once, as it records one that ends normally', async () => {
      const { bureau, storage } = await start({ costBudget: '{ perRunUsd: 0.1, perChatUsd: 9 }' });
      const task = await bureau.tasks.start('helper', 'Go.');
      const result = await task.result();
      await bureau.internals.whenTaskRecorded(task.id);
      expect(result.finishReason).toBe('budget-exceeded');
      expect(await ledgerKeys(storage)).toHaveLength(1);
    });

    const CHAT = { tools: '[lookup-order]', costBudget: '{ perRunUsd: 5, perChatUsd: 9 }' };

    it('records a run cancelled in this process once', async () => {
      const model = heldSecondStep();
      const { bureau, storage } = await start(CHAT, model.script);
      const task = await bureau.tasks.start('helper', 'Go.');
      await model.reached;
      await bureau.tasks.cancel(task.id);
      model.release();
      await task.result();
      await bureau.internals.whenTaskRecorded(task.id);
      expect(await ledgerKeys(storage)).toHaveLength(1);
    });

    it('leaves no record behind when its chat is deleted while a run is in flight', async () => {
      const model = heldSecondStep();
      const { bureau, storage } = await start(CHAT, model.script);
      const task = await bureau.tasks.start('helper', 'Go.');
      await model.reached;
      const deletion = bureau.contexts.delete(task.contextId);
      model.release();
      await deletion;
      await task.result().catch(() => undefined);
      // The run's end records its spend and then finds its chat gone, so nothing is left; the
      // record is written after the deletion has forgotten the chat's, so only that check removes it.
      await bureau.internals.whenTaskRecorded(task.id);
      expect(await ledgerKeys(storage)).toHaveLength(0);
    });

    it('refuses the next run with a typed error when the chat’s ledger cannot be read', async () => {
      const { bureau, storage } = await start({ costBudget: '{ perRunUsd: 5, perChatUsd: 9 }' });
      const first = await bureau.tasks.start('helper', 'Go.');
      await first.result();
      await bureau.internals.whenTaskRecorded(first.id);
      const kv = textValueStore(storage, { disposeUnderlyingStorage: false });
      const [key] = await ledgerKeys(storage);
      await kv.set(key as string, '{"schemaVersion":2}');

      const error = await rejectionOf(
        bureau.tasks.start('helper', 'Again.', { contextId: first.contextId }),
      );
      expect(error).toBeInstanceOf(BureauError);
      expect((error as BureauError).code).toBe('STORAGE_UNAVAILABLE');
      expect((error as BureauError).message).toContain(first.contextId);
      expect(diagnostics.map((diagnostic) => diagnostic.scope)).toContain('chat-spend');
    });
  },
);

/**
 * COR-1915 — an agent file's `costBudget.perChatUsd`, enforced on real chats. A chat's runs are
 * recorded in the spend ledger as they end; the run that follows the one that took the chat to its
 * limit finishes `budget-exceeded` naming `perChatUsd`, before the model is asked anything. A run
 * that is under way is never stopped by it, another chat is not affected, and the total survives a
 * restart. Every ledger record names the chat's owner.
 */
import { MemoryStorage, textValueStore } from '@lostgradient/storage';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CHAT_SPEND_KEY_PREFIX, createChatSpendLedger } from './chat-spend-ledger';
import { agentFileText, KNOWN_MODEL } from './testing/agent-file-fixtures.test-support';
import { type FileBureauHarness, startFileBureau } from './testing/agent-file-bureau.test-support';
import type { Bureau } from './types';
import type { AgentDefinitions } from './agent-catalog';

/** Opus 5.5 is $4 per million tokens in: 50,000 prompt tokens cost $0.20. */
const TWENTY_CENTS = { prompt: 50_000, completion: 0, total: 50_000 };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

describe.each(['non-durable', 'durable'] as const)(
  'a file agent’s perChatUsd, %s dispatch',
  (dispatch) => {
    const harnesses: FileBureauHarness[] = [];
    const directories: string[] = [];
    afterEach(async () => {
      for (const harness of harnesses.splice(0)) await harness.dispose();
      for (const directory of directories.splice(0)) {
        await rm(directory, { recursive: true, force: true });
      }
    });

    async function start(perChatUsd: number, storage = new MemoryStorage(), directory?: string) {
      let generations = 0;
      const dir = directory ?? (await mkdtemp(join(tmpdir(), 'bureau-chat-budget-')));
      if (directory === undefined) directories.push(dir);
      const harness = await startFileBureau({
        directory: dir,
        scripts: {
          'claude-opus-5-5': () => {
            generations += 1;
            return { content: 'Done.', usage: TWENTY_CENTS };
          },
        },
        overrides: { durable: dispatch === 'durable', storage },
      });
      harnesses.push(harness);
      await harness.put(
        'helper.md',
        agentFileText({
          model: KNOWN_MODEL,
          costBudget: `{ perRunUsd: 5, perChatUsd: ${perChatUsd} }`,
        }),
      );
      await harness.bureau.agents.refresh();
      return {
        harness,
        bureau: harness.bureau,
        storage,
        directory: dir,
        generations: () => generations,
      };
    }

    /** One turn of a chat: starts a run, waits for its result and for the chat to have recorded it. */
    async function turn(bureau: Bureau<AgentDefinitions>, contextId?: string) {
      const task = await bureau.tasks.start(
        'helper',
        'Go.',
        contextId === undefined ? {} : { contextId },
      );
      const result = await task.result();
      await bureau.internals.whenTaskRecorded(task.id);
      return { task, result };
    }

    it('lets a chat under its limit run, then stops the next run after the one that passed it', async () => {
      const { bureau, generations } = await start(0.5);
      const first = await turn(bureau);
      const contextId = first.task.contextId;
      await turn(bureau, contextId);
      const third = await turn(bureau, contextId);
      // $0.20, $0.40, then $0.60: the third run began under the limit and was not stopped by it.
      expect(third.result.finishReason).not.toBe('budget-exceeded');
      expect(generations()).toBe(3);

      const fourth = await turn(bureau, contextId);
      expect(fourth.result.finishReason).toBe('budget-exceeded');
      expect(messageOf(fourth.result.error)).toContain('perChatUsd');
      expect(messageOf(fourth.result.error)).toContain('0.5');
      // It never asked the model anything.
      expect(generations()).toBe(3);
    });

    it('stops the next run when the chat has spent exactly its limit', async () => {
      const { bureau, generations } = await start(0.4);
      const first = await turn(bureau);
      await turn(bureau, first.task.contextId);
      expect(generations()).toBe(2);
      const third = await turn(bureau, first.task.contextId);
      expect(third.result.finishReason).toBe('budget-exceeded');
      expect(generations()).toBe(2);
    });

    it('does not count a chat’s spend against another chat', async () => {
      const { bureau, generations } = await start(0.3);
      const first = await turn(bureau);
      await turn(bureau, first.task.contextId);
      const stopped = await turn(bureau, first.task.contextId);
      expect(stopped.result.finishReason).toBe('budget-exceeded');
      const other = await turn(bureau);
      expect(other.result.finishReason).not.toBe('budget-exceeded');
      expect(generations()).toBe(3);
    });

    it('lets two runs of one chat that are under way together finish, and stops the one after them', async () => {
      const gate = Promise.withResolvers<void>();
      let waiting = 0;
      let generations = 0;
      const dir = await mkdtemp(join(tmpdir(), 'bureau-chat-budget-'));
      directories.push(dir);
      const harness = await startFileBureau({
        directory: dir,
        scripts: {
          'claude-opus-5-5': async () => {
            generations += 1;
            // The first run of the chat answers at once; the next two wait for each other.
            if (generations > 1 && generations < 4) {
              waiting += 1;
              await gate.promise;
            }
            return { content: 'Done.', usage: TWENTY_CENTS };
          },
        },
        overrides: { durable: dispatch === 'durable', storage: new MemoryStorage() },
      });
      harnesses.push(harness);
      await harness.put(
        'helper.md',
        agentFileText({ model: KNOWN_MODEL, costBudget: '{ perRunUsd: 5, perChatUsd: 0.5 }' }),
      );
      await harness.bureau.agents.refresh();
      const { bureau } = harness;
      const first = await turn(bureau);
      const contextId = first.task.contextId;
      // $0.20 so far. Two more runs start while the total is under $0.50, and take it to $0.80.
      const second = await bureau.tasks.start('helper', 'Two.', { contextId });
      const third = await bureau.tasks.start('helper', 'Three.', { contextId });
      await waitUntil(() => waiting === 2);
      gate.resolve();
      const results = await Promise.all([second.result(), third.result()]);
      await bureau.internals.whenTaskRecorded(second.id);
      await bureau.internals.whenTaskRecorded(third.id);
      expect(results.map((result) => result.finishReason)).not.toContain('budget-exceeded');

      const fourth = await turn(bureau, contextId);
      expect(fourth.result.finishReason).toBe('budget-exceeded');
      expect(generations).toBe(3);
    });

    it('records each run once, with the chat’s owner, under the reserved prefix', async () => {
      const { bureau, storage } = await start(10);
      const first = await turn(bureau);
      await turn(bureau, first.task.contextId);
      const kv = textValueStore(storage, { disposeUnderlyingStorage: false });
      const keys = await kv.list(CHAT_SPEND_KEY_PREFIX);
      expect(keys).toHaveLength(2);
      for (const key of keys) {
        expect(JSON.parse((await kv.get(key)) as string)).toMatchObject({
          schemaVersion: 1,
          sessionId: first.task.contextId,
          owner: 'anonymous:local',
          agentName: 'helper',
        });
      }
    });

    it('keeps the total across a restart', async () => {
      const storage = new MemoryStorage();
      const before = await start(0.4, storage);
      const first = await turn(before.bureau);
      await turn(before.bureau, first.task.contextId);
      await before.harness.dispose();
      harnesses.splice(harnesses.indexOf(before.harness), 1);

      const after = await start(0.4, storage, before.directory);
      const next = await turn(after.bureau, first.task.contextId);
      expect(next.result.finishReason).toBe('budget-exceeded');
      expect(messageOf(next.result.error)).toContain('perChatUsd');
      expect(after.generations()).toBe(0);
    });

    it('puts no limit on an agent whose file sets no perChatUsd, and records its runs all the same', async () => {
      const storage = new MemoryStorage();
      const harness = await startFileBureau({
        scripts: { 'claude-opus-5-5': () => ({ content: 'Done.', usage: TWENTY_CENTS }) },
        overrides: { durable: dispatch === 'durable', storage },
      });
      harnesses.push(harness);
      await harness.put(
        'helper.md',
        agentFileText({ model: KNOWN_MODEL, costBudget: '{ perRunUsd: 5 }' }),
      );
      await harness.bureau.agents.refresh();
      const first = await turn(harness.bureau);
      for (let index = 0; index < 3; index += 1) {
        const next = await turn(harness.bureau, first.task.contextId);
        expect(next.result.finishReason).not.toBe('budget-exceeded');
      }
      const ledger = createChatSpendLedger({
        kv: textValueStore(storage, { disposeUnderlyingStorage: false }),
        diagnose: () => undefined,
      });
      const session = await harness.bureau.contexts.get(first.task.contextId);
      expect(
        await ledger.totalOf(first.task.contextId, session?.incarnation as string),
      ).toBeCloseTo(0.8, 10);
    });
  },
);

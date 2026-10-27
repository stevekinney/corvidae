/**
 * The lifetime of a task's A2A record (COR-1637): a removal that fails is retried and swept rather
 * than left holding message text, and the clearing of a deleted context reaches only its own
 * incarnation.
 */
import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import { createAgent } from '@lostgradient/operative';
import type { ConditionalTextValueStore } from '@lostgradient/weft';
import { describe, expect, it } from 'bun:test';

import type { AgentDefinitions } from '../agent-catalog';
import { createMemoryAssetStorage } from '../assets/storage';
import { createBureau } from '../create-bureau';
import { createSqliteStorageFixture } from '../test/storage-fixtures';
import { waitForCondition } from '../test';
import type { Bureau } from '../types.ts';
import { type Json, message } from './a2a-mount.test-support.ts';
import { COMMAND_RECEIPTS_EXTENSION_URI } from './a2a-command-receipts.ts';
import {
  A2A_CONTEXT_INDEX_KEY_PREFIX,
  A2A_TASK_RECORD_KEY_PREFIX,
  createA2ATaskRecords,
} from './a2a-task-record.ts';
import { authentication } from './management/management-fixtures.test-support.ts';
import { createBureauHandler } from './create-bureau-handler.ts';

const ORIGIN = '2026-10-22T00:00:00.000Z';
const DAY_MS = 86_400_000;

/** `kv` whose next `failures` deletes of an A2A task record throw, as a transient outage does. */
function flakyDeletes(kv: ConditionalTextValueStore, faults: { failures: number }) {
  return new Proxy(kv, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if (property === 'delete') {
        return async (key: string) => {
          if (faults.failures > 0 && key.startsWith(A2A_TASK_RECORD_KEY_PREFIX)) {
            faults.failures -= 1;
            throw new Error('injected: the delete failed');
          }
          return target.delete(key);
        };
      }
      return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
    },
  });
}

async function withBureau(
  body: (context: {
    bureau: Bureau;
    handle: (kv?: ConditionalTextValueStore) => (request: Request) => Promise<Response>;
    runtime: ReturnType<typeof createManualRuntimeServices>;
  }) => Promise<void>,
): Promise<void> {
  const runtime = createManualRuntimeServices({ origin: ORIGIN });
  const fixture = createSqliteStorageFixture({ runtime });
  const bureau = await createBureau<AgentDefinitions>({
    id: 'record-lifetime',
    agents: {
      asker: createAgent({
        name: 'asker',
        generate: async () => ({ content: 'done', toolCalls: [] }),
      }),
    },
    runtime,
    storage: fixture.configuration,
    durable: true,
    durableOwnership: { ownership: 'none' },
    maintenance: 'manual',
    retention: { tasks: { olderThan: DAY_MS }, receipts: { olderThan: DAY_MS } },
    assets: { storage: createMemoryAssetStorage() },
  });
  try {
    await body({
      bureau,
      runtime,
      handle: (kv) =>
        createBureauHandler(
          kv === undefined
            ? bureau
            : (Object.create(bureau, {
                internals: { value: { ...bureau.internals, kv } },
              }) as typeof bureau),
          { authentication, publish: ['asker'], publicUrl: 'http://localhost' },
        ),
    });
  } finally {
    await bureau.dispose();
    await fixture.dispose();
  }
}

async function sendOn(
  handler: (request: Request) => Promise<Response>,
  text: string,
  extra: Json = {},
  headers: Record<string, string> = {},
) {
  const response = await handler(
    new Request('http://localhost/a2a/asker', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'A2A-Version': '1.0',
        'X-API-Key': 'alice-key',
        ...headers,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'SendMessage',
        params: { message: message(text, extra) },
      }),
    }),
  );
  const body: Json = await response.json();
  return body.result.task as { id: string; contextId: string };
}

describe('a task’s A2A record, when removing it fails', () => {
  it('is deleted by the next removal that succeeds', async () => {
    await withBureau(async ({ bureau, handle, runtime }) => {
      const faults = { failures: 0 };
      const handler = handle(
        flakyDeletes(bureau.internals.kv as ConditionalTextValueStore, faults),
      );
      const first = await sendOn(handler, 'one');
      const second = await sendOn(handler, 'two');
      const keyOf = (id: string) => `${A2A_TASK_RECORD_KEY_PREFIX}${encodeURIComponent(id)}`;
      runtime.setTime(Date.parse(ORIGIN) + 3 * DAY_MS);

      // The first task's removal fails once; the second's succeeds and retries the first's.
      faults.failures = 1;
      await bureau.maintain();
      await bureau.maintain();
      await waitForCondition(
        async () =>
          (await bureau.internals.kv?.get(keyOf(first.id))) === null &&
          (await bureau.internals.kv?.get(keyOf(second.id))) === null,
        'an A2A record outlived its task',
      );
    });
  });

  it('is swept at start-up when its task is gone', async () => {
    await withBureau(async ({ bureau, handle }) => {
      const kv = bureau.internals.kv as ConditionalTextValueStore;
      await createA2ATaskRecords(kv).create({
        recordVersion: 1,
        taskId: 'long-gone',
        contextId: 'context-gone',
        incarnation: 'incarnation-gone',
        history: [{ messageId: 'm-1', parts: [{ text: 'secret' }] }],
        replyRecorded: false,
      });

      handle();

      await waitForCondition(
        async () => (await createA2ATaskRecords(kv).read('long-gone')) === undefined,
        'the orphaned record was never swept',
      );
    });
  });
});

describe('a deadline-expired task, which no run backs', () => {
  it('keeps no A2A record, so retention removing the task leaves nothing to delete', async () => {
    await withBureau(async ({ bureau, handle }) => {
      const expired = await sendOn(
        handle(),
        'too late',
        { metadata: { [COMMAND_RECEIPTS_EXTENSION_URI]: { deadline: '2000-01-01T00:00:00Z' } } },
        { 'A2A-Extensions': COMMAND_RECEIPTS_EXTENSION_URI },
      );

      // The task's own record keeps the message, and a read creates no side record either.
      expect(expired.id).toStartWith('agent-run-expired-');
      expect(await bureau.internals.kv?.list(A2A_TASK_RECORD_KEY_PREFIX)).toEqual([]);
      expect(await bureau.internals.kv?.list(A2A_CONTEXT_INDEX_KEY_PREFIX)).toEqual([]);
    });
  });
});

describe('retention removing a task whose run the Bureau no longer holds', () => {
  it('deletes the task’s A2A record, as removing its run does', async () => {
    await withBureau(async ({ bureau, handle, runtime }) => {
      handle();
      // A task a restart left runless: its record is the registry's alone, and so is the A2A record.
      await bureau.internals.taskRegistry.recordAdmission({
        taskId: 'runless-task',
        contextId: 'runless-context',
        incarnation: '',
        agentName: 'asker',
        owner: 'api-key:alice',
        message: 'private words',
      });
      await bureau.internals.taskRegistry.recordSettled('runless-task', {
        at: runtime.clock.nowISO(),
        status: 'failed',
        finishReason: 'deadline-exceeded',
        message: 'ended',
      });
      const records = createA2ATaskRecords(bureau.internals.kv as ConditionalTextValueStore);
      await records.create({
        recordVersion: 1,
        taskId: 'runless-task',
        contextId: 'runless-context',
        incarnation: '',
        history: [{ messageId: 'm-1', parts: [{ text: 'private words' }] }],
        replyRecorded: true,
      });

      runtime.setTime(Date.parse(ORIGIN) + 3 * DAY_MS);
      await bureau.maintain();

      expect(await bureau.internals.taskRegistry.record('runless-task')).toBeUndefined();
      await waitForCondition(
        async () => (await records.read('runless-task')) === undefined,
        'the A2A record outlived its task',
      );
    });
  });
});

describe('the start-up sweep', () => {
  it('keeps the record of a task the store still holds', async () => {
    await withBureau(async ({ bureau, handle }) => {
      const live = await sendOn(handle(), 'still here');
      const records = createA2ATaskRecords(bureau.internals.kv as ConditionalTextValueStore);
      // Sweeps list records in key order, so once this later key is gone the live one was examined.
      await records.create({
        recordVersion: 1,
        taskId: 'zz-gone',
        contextId: 'context-gone',
        incarnation: 'incarnation-gone',
        history: [],
        replyRecorded: true,
      });

      handle();

      await waitForCondition(
        async () => (await records.read('zz-gone')) === undefined,
        'the orphaned record was never swept',
      );
      const kept = await records.read(live.id);
      expect(kept?.history.length).toBeGreaterThan(0);
    });
  });
});

describe('clearing a deleted context', () => {
  it('leaves the history of a context created again under the same id', async () => {
    await withBureau(async ({ bureau, handle }) => {
      const handler = handle();
      const before = await sendOn(handler, 'first life');
      await bureau.contexts.delete(before.contextId);
      const reborn = await sendOn(handler, 'second life', { contextId: before.contextId });
      const records = createA2ATaskRecords(bureau.internals.kv as ConditionalTextValueStore);
      const born = await records.read(reborn.id);
      const earlier = await records.read(before.id);
      // Two real, different incarnations of one context id.
      expect(earlier?.incarnation).toBeTruthy();
      expect(born?.incarnation).toBeTruthy();
      expect(born?.incarnation).not.toBe(earlier?.incarnation);

      // The deleted incarnation's cleanup arriving after the context was created again, as a slow
      // or retried cleanup does: it reaches the first life's task and not the second's.
      await records.clearContext(before.contextId, earlier?.incarnation ?? '');

      const cleared = await records.read(before.id);
      const kept = await records.read(reborn.id);
      expect(cleared?.history).toEqual([]);
      expect(kept?.history).toHaveLength(2);
    });
  });
});

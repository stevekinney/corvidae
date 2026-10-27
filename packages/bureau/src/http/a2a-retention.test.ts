/**
 * A task's A2A record leaves with its task (COR-903): when task retention deletes a task through
 * the run store, `run.removed` deletes the record beside it.
 */
import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import { createAgent } from '@lostgradient/operative';
import { describe, expect, it } from 'bun:test';

import { createMemoryAssetStorage } from '../assets/storage';
import { createBureau } from '../create-bureau';
import { createSqliteStorageFixture } from '../test/storage-fixtures';
import { A2A_TASK_RECORD_KEY_PREFIX } from './a2a-task-record.ts';
import { createBureauHandler } from './create-bureau-handler.ts';
import type { AgentDefinitions } from '../agent-catalog';

const ORIGIN = '2026-10-22T00:00:00.000Z';
const DAY_MS = 86_400_000;

describe('the A2A record’s lifetime', () => {
  it('is deleted when task retention removes its task', async () => {
    const runtime = createManualRuntimeServices({ origin: ORIGIN });
    const fixture = createSqliteStorageFixture({ runtime });
    const bureau = await createBureau<AgentDefinitions>({
      id: 'retention-bureau',
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
      const handler = createBureauHandler(bureau, {
        unauthenticatedAccess: 'allow',
        publish: ['asker'],
        publicUrl: 'http://localhost',
      });
      const response = await handler(
        new Request('http://localhost/a2a/asker', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'A2A-Version': '1.0' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'SendMessage',
            params: { message: { messageId: 'm-1', role: 'ROLE_USER', parts: [{ text: 'hi' }] } },
          }),
        }),
      );
      const body = (await response.json()) as {
        result: { task: { id: string; status: { state: string } } };
      };
      expect(body.result.task.status.state).toBe('TASK_STATE_COMPLETED');
      const key = `${A2A_TASK_RECORD_KEY_PREFIX}${encodeURIComponent(body.result.task.id)}`;
      expect(await bureau.internals.kv?.get(key)).not.toBeNull();

      runtime.setTime(Date.parse(ORIGIN) + 3 * DAY_MS);
      // The first pass sweeps the run-creation binding; the next deletes the task it held.
      await bureau.runDurableMaintenance();
      await bureau.runDurableMaintenance();

      expect(bureau.getRun(body.result.task.id)).toBeUndefined();
      expect(await bureau.internals.kv?.get(key)).toBeNull();
    } finally {
      await bureau.dispose();
      await fixture.dispose();
    }
  });
});

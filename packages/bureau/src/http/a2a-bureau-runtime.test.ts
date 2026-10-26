/**
 * The A2A mount runs on the Bureau's own runtime (COR-1661): a command's deadline is read against
 * the Bureau's clock, and the send ledger prunes on it, so a custom `BureauOptions.runtime`
 * governs the adapter as it governs the Bureau.
 */
import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import { createAgent } from '@lostgradient/operative';
import { describe, expect, it } from 'bun:test';

import type { AgentDefinitions } from '../agent-catalog';
import { createMemoryAssetStorage } from '../assets/storage';
import { createBureau } from '../create-bureau';
import { createSqliteStorageFixture } from '../test/storage-fixtures';
import { COMMAND_RECEIPTS_EXTENSION_URI } from './a2a-command-receipts.ts';
import { A2A_SEND_LEDGER_KEY_PREFIX } from './a2a-request-handler.ts';
import { createBureauHandler } from './create-bureau-handler.ts';
import { type Json } from './a2a-mount.test-support.ts';

const ORIGIN = '2026-10-22T00:00:00.000Z';
const HOUR_MS = 3_600_000;

async function withManualBureau(
  body: (context: {
    runtime: ReturnType<typeof createManualRuntimeServices>;
    handler: (request: Request) => Promise<Response>;
    kv: NonNullable<Awaited<ReturnType<typeof createBureau>>['kv']>;
  }) => Promise<void>,
): Promise<void> {
  const runtime = createManualRuntimeServices({ origin: ORIGIN });
  const fixture = createSqliteStorageFixture({ runtime });
  const bureau = await createBureau<AgentDefinitions>({
    id: 'runtime-bureau',
    agents: {
      asker: createAgent({
        name: 'asker',
        generate: async () => ({ content: 'done', toolCalls: [] }),
      }),
    },
    runtime,
    storage: fixture.configuration,
    durableExecution: true,
    durableOwnership: { ownership: 'none' },
    durableBackgroundTasks: 'manual',
    assets: { storage: createMemoryAssetStorage() },
  });
  try {
    const handler = createBureauHandler(bureau, {
      unauthenticatedAccess: 'allow',
      publish: ['asker'],
      publicUrl: 'http://localhost',
    });
    await body({ runtime, handler, kv: bureau.kv as NonNullable<typeof bureau.kv> });
  } finally {
    await bureau.dispose();
    await fixture.dispose();
  }
}

async function send(
  handler: (request: Request) => Promise<Response>,
  messageId: string,
  receipts: object = {},
): Promise<Json> {
  const response = await handler(
    new Request('http://localhost/a2a/asker', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'A2A-Version': '1.0',
        'A2A-Extensions': COMMAND_RECEIPTS_EXTENSION_URI,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'SendMessage',
        params: {
          message: {
            messageId,
            role: 'ROLE_USER',
            parts: [{ text: 'hi' }],
            metadata: { [COMMAND_RECEIPTS_EXTENSION_URI]: receipts },
          },
        },
      }),
    }),
  );
  return response.json();
}

describe('the A2A mount on a Bureau with its own runtime', () => {
  it('reads a command deadline against the Bureau’s clock', async () => {
    await withManualBureau(async ({ handler }) => {
      // An hour after the Bureau's clock, though long past the process's own.
      const body = await send(handler, 'm-deadline', { deadline: '2026-10-22T01:00:00Z' });

      const receipt = body.result.task.metadata[COMMAND_RECEIPTS_EXTENSION_URI].receipt;
      expect(receipt.state).not.toBe('expired');
    });
  });

  it('prunes the send ledger on the Bureau’s clock', async () => {
    await withManualBureau(async ({ runtime, handler, kv }) => {
      await send(handler, 'm-first');
      expect(await kv.list(A2A_SEND_LEDGER_KEY_PREFIX)).toHaveLength(1);

      // A day and an hour later on the Bureau's clock: the binding is past its retention and the
      // next claim, an hour on from the last prune, drops it.
      runtime.setTime(Date.parse(ORIGIN) + 25 * HOUR_MS);
      await send(handler, 'm-second');

      const keys = await kv.list(A2A_SEND_LEDGER_KEY_PREFIX);
      expect(keys.some((key) => key.includes('m-first'))).toBe(false);
      expect(keys.some((key) => key.includes('m-second'))).toBe(true);
    });
  });
});

/**
 * COR-2009 — a chat the host stops records why it ended. A run that a Bureau's shutdown aborts
 * leaves `lastRunEndReason: 'host-stopped'` on its session, and `bureau.contexts.get` and
 * `bureau.contexts.list` read it as `endReason`, so a chat list can say Ended and why ("interrupted
 * by a restart"). A chat whose run ended on its own, and one that ran again since, has none.
 */
import { createAgent, stopWhen } from '@lostgradient/operative';
import { createToolbox } from 'armorer';
import { afterEach, describe, expect, test } from 'bun:test';

import type { AgentDefinitions } from './agent-catalog';
import { createBureau } from './create-bureau';
import { createOperationHandler, unauthenticatedLocalAuthContext } from '@lostgradient/weft';

import { buildBureauHandlerHost } from './http/create-bureau-handler';
import { contextsGetOperation, contextsListOperation } from './http/management/contexts-operations';
import { waitForCondition } from './test';
import {
  createSqliteStorageFixture,
  type PersistentBureauStorageFixture,
} from './test/storage-fixtures';
import type { Bureau } from './types';

const bureaus: Bureau<AgentDefinitions>[] = [];
const databases: PersistentBureauStorageFixture[] = [];

afterEach(async () => {
  for (const bureau of bureaus.splice(0)) await bureau.dispose();
  for (const database of databases.splice(0)) await database.dispose();
});

/** An agent whose first answer waits until its run is aborted, and whose later ones answer at once. */
function holdingFirstAnswer(generating: PromiseWithResolvers<void>) {
  let calls = 0;
  return createAgent({
    name: 'assistant',
    generate: ({ signal }) => {
      calls += 1;
      if (calls > 1) return Promise.resolve({ content: 'Done.', toolCalls: [] });
      generating.resolve();
      return new Promise<never>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
    toolbox: createToolbox([]),
    stopWhen: stopWhen.noToolCalls(),
  });
}

function answering() {
  return createAgent({
    name: 'assistant',
    generate: async () => ({ content: 'Renamed.', toolCalls: [] }),
    toolbox: createToolbox([]),
    stopWhen: stopWhen.noToolCalls(),
  });
}

async function open(
  database: PersistentBureauStorageFixture,
  agent: ReturnType<typeof answering>,
  first: boolean,
) {
  const bureau = await createBureau<AgentDefinitions>({
    agents: { assistant: agent },
    storage: first ? database.storage : database.open(),
    durable: true,
    durableOwnership: { ownership: 'none' },
  });
  bureaus.push(bureau);
  return bureau;
}

async function contextView(bureau: Bureau<AgentDefinitions>, contextId: string) {
  const handler = createOperationHandler({
    operations: [contextsGetOperation, contextsListOperation],
    host: buildBureauHandlerHost(bureau, []),
    authenticate: async () => unauthenticatedLocalAuthContext(),
    publicPaths: [],
  });
  const call = async (method: string, params: unknown) => {
    const response = await handler(
      new Request('http://localhost/jsonrpc', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      }),
    );
    return (await response.json()) as { result?: Record<string, unknown> };
  };
  const got = await call('bureau.contexts.get', { contextId });
  const detail = got.result;
  const page = await call('bureau.contexts.list', {});
  const listed = (page.result?.['contexts'] as Array<Record<string, unknown>> | undefined)?.find(
    (context) => context['id'] === contextId,
  );
  return { detail, listed };
}

describe('the end reason of a chat', () => {
  test('a chat whose run the host stopped reads host-stopped after the restart', async () => {
    const database = createSqliteStorageFixture();
    databases.push(database);
    const generating = Promise.withResolvers<void>();
    const bureau = await open(database, holdingFirstAnswer(generating), true);
    const run = await bureau.tasks.start('assistant', 'Rename the billing tables');
    await generating.promise;

    await bureau.shutdown({ policy: 'abort' });

    const restarted = await open(database, answering(), false);
    await restarted.recovery();
    const { detail, listed } = await contextView(restarted, run.contextId);
    expect(detail).toMatchObject({ id: run.contextId, endReason: 'host-stopped' });
    expect(listed).toMatchObject({ endReason: 'host-stopped', activity: 'idle' });
  });

  test('a chat whose run ended on its own has no end reason', async () => {
    const database = createSqliteStorageFixture();
    databases.push(database);
    const bureau = await open(database, answering(), true);
    const run = await bureau.tasks.start('assistant', 'Rename the billing tables');
    await run.result();
    await waitForCondition(async () => {
      const view = await contextView(bureau, run.contextId);
      return view.detail?.['messageCount'] === 2;
    }, 'the finished chat to be saved');

    const { detail, listed } = await contextView(bureau, run.contextId);
    expect(detail).toMatchObject({ endReason: null });
    expect(listed).toMatchObject({ endReason: null });
  });

  test('a chat the host stopped loses its end reason once it runs again', async () => {
    const database = createSqliteStorageFixture();
    databases.push(database);
    const generating = Promise.withResolvers<void>();
    const agent = holdingFirstAnswer(generating);
    const bureau = await open(database, agent, true);
    const run = await bureau.tasks.start('assistant', 'Rename the billing tables');
    await generating.promise;
    await bureau.shutdown({ policy: 'abort' });

    const restarted = await open(database, agent, false);
    await restarted.recovery();
    const again = await restarted.tasks.start('assistant', 'Try again', {
      contextId: run.contextId,
    });
    await again.result();
    await waitForCondition(async () => {
      const view = await contextView(restarted, run.contextId);
      return view.detail?.['endReason'] === null;
    }, 'the next run to clear the end reason');
  });
});

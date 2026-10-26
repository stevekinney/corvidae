/**
 * Interop of Weft's A2A peer client (COR-905) with Bureau's own A2A mount (COR-1670): the client
 * reads a published agent's card, sends it a message, follows the task to where it stops,
 * continues one that asked for input, and cancels one that never ends.
 */
import { createAgent, type GenerateFunction } from '@lostgradient/operative';
import { createA2APeerClient } from '@lostgradient/weft/a2a';
import { describe, expect, it } from 'bun:test';

import { waitForCondition } from '../test';
import { parksThenAnswers } from './a2a-mount.test-support.ts';
import { type OpenedBureau, openBureau } from './management/management-fixtures.test-support.ts';

const ORIGIN = 'https://agents.example.test';

async function withPeer(
  generate: GenerateFunction,
  body: (peer: {
    opened: OpenedBureau;
    client: ReturnType<typeof createA2APeerClient>;
  }) => Promise<void>,
  options: { humanInput?: boolean } = {},
): Promise<void> {
  const opened = await openBureau({
    agents: { asker: createAgent({ name: 'asker', description: 'Answers.', generate }) },
    publish: ['asker'],
    ...(options.humanInput === true ? { humanInput: true } : {}),
    handlerOptions: { publicUrl: ORIGIN },
  });
  try {
    const client = createA2APeerClient({
      url: `${ORIGIN}/a2a/asker`,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) =>
        opened.handler(new Request(input, init))) as typeof fetch,
      authenticate: async () => ({ 'X-API-Key': 'alice-key' }),
      attempts: 1,
      taskTimeoutMs: 10_000,
    });
    await body({ opened, client });
  } finally {
    await opened.dispose();
  }
}

describe('the peer client against a Bureau A2A mount', () => {
  it('reads the published agent’s card', async () => {
    await withPeer(
      async () => ({ content: 'ok', toolCalls: [] }),
      async ({ client }) => {
        const card = await client.card();

        expect(card.name).toBe('asker');
        expect(card.cardUrl).toBe(`${ORIGIN}/a2a/asker/.well-known/agent-card.json`);
      },
    );
  });

  it('sends a message and follows the task to its answer', async () => {
    await withPeer(
      async () => ({ content: 'the answer', toolCalls: [] }),
      async ({ client }) => {
        const task = await client.send({ text: 'question' });
        const outcome = await task.result();

        expect(outcome.state).toBe('completed');
        expect(outcome.taskId).not.toBe('');
        expect(JSON.stringify([outcome.message, outcome.artifacts])).toContain('the answer');
        expect(outcome.provenance.agentName).toBe('asker');
      },
    );
  });

  it('continues a task that asked for input, by its task id', async () => {
    await withPeer(
      parksThenAnswers(),
      async ({ client }) => {
        const opening = await client.send({ text: 'start' });
        const first = await opening.result();
        expect(first.state).toBe('input-required');

        const continuing = await client.send({
          text: 'blue',
          taskId: first.taskId,
          contextId: first.contextId,
        });
        const second = await continuing.result();

        expect(second.state).toBe('completed');
        expect(second.taskId).toBe(first.taskId);
      },
      { humanInput: true },
    );
  });

  it('cancels a task that never ends', async () => {
    await withPeer(
      ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
      async ({ opened, client }) => {
        const task = await client.send({ text: 'park' });

        const outcome = await task.cancel('not needed');

        // Bureau answers CancelTask once the cancel is requested, while the run is still stopping,
        // so the client reports the cancel it made as unconfirmed; the task then does stop.
        expect(outcome.state).toBe('canceled');
        expect(outcome.cancelConfirmed).toBe(false);
        expect(outcome.cancelError).toContain('working');
        await waitForCondition(async () => {
          const view = await opened.bureau.tasks.get(task.taskId);
          return view?.status === 'canceled';
        }, 'the Bureau task never stopped');
      },
    );
  });
});

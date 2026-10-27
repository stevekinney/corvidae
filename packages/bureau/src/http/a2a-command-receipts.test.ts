/**
 * The command-receipts extension on A2A sends (COR-903, part 2b): each response carries the
 * command's receipt and the task's revision, a reused `messageId` and a stale `expectedRevision`
 * are typed errors, and a deadline bounds the command.
 */
import { createAgent, type GenerateFunction } from '@lostgradient/operative';
import { describe, expect, it } from 'bun:test';

import {
  type OpenedBureau,
  openBureau,
  parkingUntilAborted,
} from './management/management-fixtures.test-support.ts';
import {
  COMMAND_RECEIPTS_EXTENSION_URI,
  readCommandReceiptsRequest,
} from './a2a-command-receipts.ts';

// A JSON-RPC body read back from the wire: each test asserts the shape it needs.
type Json = any;

const ACTIVE = { 'A2A-Extensions': COMMAND_RECEIPTS_EXTENSION_URI };

let counter = 0;
function message(text: string, extra: Json = {}): Json {
  counter += 1;
  return { messageId: `r-${counter}`, role: 'ROLE_USER', parts: [{ text }], ...extra };
}

function answering(content: string): GenerateFunction {
  return async () => ({ content, toolCalls: [] });
}

function parksThenAnswers(): GenerateFunction {
  let calls = 0;
  return async () => {
    calls += 1;
    return calls === 1
      ? {
          content: '',
          toolCalls: [
            {
              id: 'wait-1',
              name: 'requestHumanInput',
              arguments: { signalName: 'human-response', prompt: 'Which?' },
            },
          ],
        }
      : { content: 'done', toolCalls: [] };
  };
}

async function withA2A<T>(
  generate: GenerateFunction,
  body: (opened: OpenedBureau) => Promise<T>,
  options: { second?: boolean } = {},
): Promise<T> {
  const opened = await openBureau({
    agents: {
      asker: createAgent({ name: 'asker', generate }),
      ...(options.second === true ? { other: createAgent({ name: 'other', generate }) } : {}),
    },
    publish: options.second === true ? ['asker', 'other'] : ['asker'],
    durableHistory: true,
    handlerOptions: { publicUrl: 'http://localhost' },
  });
  try {
    return await body(opened);
  } finally {
    await opened.dispose();
  }
}

async function send(
  opened: OpenedBureau,
  params: Json,
  headers: Record<string, string> = ACTIVE,
  agent = 'asker',
): Promise<Json> {
  const response = await opened.handler(
    new Request(`http://localhost/a2a/${agent}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'A2A-Version': '1.0',
        'X-API-Key': 'alice-key',
        ...headers,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'SendMessage', params }),
    }),
  );
  return response.json();
}

function receiptOf(body: Json): Json {
  return body.result.task.metadata?.[COMMAND_RECEIPTS_EXTENSION_URI];
}

describe('the command-receipts extension', () => {
  it('is declared on the card of a Bureau with durable stores', async () => {
    await withA2A(answering('done'), async (opened) => {
      const response = await opened.handler(
        new Request('http://localhost/a2a/asker/.well-known/agent-card.json'),
      );
      const card: Json = await response.json();
      expect(card.capabilities.extensions.map((entry: Json) => entry.uri)).toContain(
        COMMAND_RECEIPTS_EXTENSION_URI,
      );
    });
  });

  it('reports a new task’s receipt, observed once the task has ended, and only when active', async () => {
    await withA2A(answering('done'), async (opened) => {
      const original = message('go');
      const active = await send(opened, { message: original });
      const plain = await send(opened, { message: message('go') }, {});

      expect(receiptOf(active)).toMatchObject({
        receipt: { state: 'observed', commandId: original.messageId },
      });
      expect(receiptOf(plain)).toBeUndefined();
    });
  });

  it('returns the original receipt to an exact retry, and a typed conflict to a changed payload', async () => {
    await withA2A(answering('done'), async (opened) => {
      const original = message('once');
      const first = await send(opened, { message: original });
      const retry = await send(opened, { message: original });
      const conflict = await send(opened, {
        message: { ...original, parts: [{ text: 'changed' }] },
      });
      const plainConflict = await send(
        opened,
        { message: { ...original, parts: [{ text: 'changed' }] } },
        {},
      );

      expect(retry.result.task.id).toBe(first.result.task.id);
      expect(receiptOf(retry).receipt.state).toBe('observed');
      expect(conflict.error.code).toBe(-32602);
      expect(conflict.error.data).toEqual([
        {
          '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
          reason: 'CONFLICT',
          domain: 'bureau',
          metadata: {
            commandId: original.messageId,
            taskId: first.result.task.id,
            receiptState: 'applied',
          },
        },
      ]);
      expect(plainConflict.error.code).toBe(-32602);
      expect(plainConflict.error.data[0].domain).toBe('a2a-protocol.org');
    });
  });

  it('refuses a continuation with a stale expectedRevision, typed and changing nothing', async () => {
    await withA2A(parksThenAnswers(), async (opened) => {
      const parked = await send(opened, { message: message('start') });
      const task = parked.result.task;
      const revision = receiptOf(parked).revision;
      expect(typeof revision).toBe('string');

      const stale = await send(opened, {
        message: message('blue', {
          taskId: task.id,
          metadata: { [COMMAND_RECEIPTS_EXTENSION_URI]: { expectedRevision: `${revision}-old` } },
        }),
      });

      expect(stale.error.code).toBe(-32602);
      expect(stale.error.data[0]).toMatchObject({
        reason: 'STALE_REVISION',
        domain: 'bureau',
        metadata: {
          taskId: task.id,
          expectedRevision: `${revision}-old`,
          currentRevision: revision,
        },
      });
      const view = await opened.bureau.internals.taskRegistry.get(task.id);
      expect(view?.status).toBe('input-required');
    });
  });

  it('records a new task whose deadline has passed as failed and expired, starting no run', async () => {
    await withA2A(answering('done'), async (opened) => {
      const late = await send(opened, {
        message: message('too late', {
          metadata: {
            [COMMAND_RECEIPTS_EXTENSION_URI]: { deadline: '2000-01-01T00:00:00Z' },
          },
        }),
      });

      expect(late.result.task.status.state).toBe('TASK_STATE_FAILED');
      expect(receiptOf(late).receipt).toMatchObject({
        state: 'expired',
        reason: 'deadline-exceeded',
      });
      expect(opened.bureau.getRun(late.result.task.id)).toBeUndefined();
    });
  });

  it('gives one command sent to two agents after its deadline a task of each', async () => {
    await withA2A(
      answering('done'),
      async (opened) => {
        const late = message('too late', {
          metadata: { [COMMAND_RECEIPTS_EXTENSION_URI]: { deadline: '2000-01-01T00:00:00Z' } },
        });
        const first = await send(opened, { message: late });
        const second = await send(opened, { message: late }, ACTIVE, 'other');
        expect(second.result.task.id).not.toBe(first.result.task.id);
        const stored = await opened.bureau.internals.taskRegistry.get(second.result.task.id);
        expect(stored?.agentName).toBe('other');
      },
      { second: true },
    );
  });

  it('finishes an expired task’s settlement and record when the first attempt stopped short', async () => {
    await withA2A(answering('done'), async (opened) => {
      const late = message('too late', {
        metadata: { [COMMAND_RECEIPTS_EXTENSION_URI]: { deadline: '2000-01-01T00:00:00Z' } },
      });
      const tasks = opened.bureau.internals.taskRegistry;
      const settle = tasks.recordSettled.bind(tasks);
      let failed = false;
      tasks.recordSettled = async (...input: Parameters<typeof settle>) => {
        if (!failed) {
          failed = true;
          throw new Error('storage fault');
        }
        return settle(...input);
      };
      await send(opened, { message: late });
      const retry = await send(opened, { message: late });
      expect(retry.result.task.status.state).toBe('TASK_STATE_FAILED');
      expect(receiptOf(retry).receipt.state).toBe('expired');
    });
  });

  it('leaves a waiting task waiting when a continuation’s deadline has passed', async () => {
    await withA2A(parksThenAnswers(), async (opened) => {
      const started = await send(opened, { message: message('start') });
      const parked = started.result.task;

      const late = await send(opened, {
        message: message('blue', {
          taskId: parked.id,
          metadata: {
            [COMMAND_RECEIPTS_EXTENSION_URI]: { deadline: '2000-01-01T00:00:00Z' },
          },
        }),
      });

      expect(late.result.task.status.state).toBe('TASK_STATE_INPUT_REQUIRED');
      expect(receiptOf(late).receipt.state).toBe('expired');
    });
  });

  it('answers TIMEOUT when the deadline passes while a blocking send waits, and the task goes on', async () => {
    await withA2A(parkingUntilAborted, async (opened) => {
      const deadline = new Date(Date.now() + 300).toISOString();
      const timedOut = await send(opened, {
        message: message('slow', { metadata: { [COMMAND_RECEIPTS_EXTENSION_URI]: { deadline } } }),
      });

      expect(timedOut.error.code).toBe(-32603);
      expect(timedOut.error.data[0]).toMatchObject({ reason: 'TIMEOUT', domain: 'bureau' });
      const view = await opened.bureau.internals.taskRegistry.get(
        timedOut.error.data[0].metadata.taskId,
      );
      expect(view?.status).toBe('working');
    });
  });

  it('refuses malformed receipts metadata with -32602', async () => {
    await withA2A(answering('done'), async (opened) => {
      const refused = await send(opened, {
        message: message('x', {
          metadata: { [COMMAND_RECEIPTS_EXTENSION_URI]: { deadline: 'tomorrow' } },
        }),
      });
      expect(refused.error.code).toBe(-32602);
    });
  });
});

describe('readCommandReceiptsRequest', () => {
  const read = (deadline: string) =>
    readCommandReceiptsRequest({ [COMMAND_RECEIPTS_EXTENSION_URI]: { deadline } });

  it('refuses a deadline whose fields are out of range or name a day that does not exist', () => {
    for (const deadline of [
      '2026-13-01T00:00:00Z',
      '2026-01-01T99:00:00Z',
      '2026-02-30T00:00:00Z',
      '2026-01-01T00:00:00+25:00',
    ]) {
      expect(() => read(deadline)).toThrow(/RFC 3339/);
    }
    expect(read('2026-02-28T12:30:00+02:00').deadline).toBe(Date.parse('2026-02-28T10:30:00Z'));
  });

  it('accepts the leap second the published schema permits', () => {
    expect(read('1990-12-31T23:59:60Z').deadline).toBe(Date.parse('1990-12-31T23:59:59Z'));
  });
});

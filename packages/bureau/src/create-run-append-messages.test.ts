/**
 * COR-855 — `createRun` takes the rows to append (`appendMessages`) as well as,
 * or instead of, a single user `message`, and says whether the Bureau can keep
 * the receipts an idempotent run needs (`hasDurableEngine`).
 */
import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import { waitForRunState, createAgent } from '@lostgradient/operative';
import { MemoryStorage, textValueStore, yieldToPortableEventLoop } from '@lostgradient/weft';
import { createToolbox, type Tool } from 'armorer';
import { describe, expect, it } from 'bun:test';
import {
  appendMessages,
  createConversationHistory,
  type Message,
  type MessageInput,
} from 'conversationalist';

import { BureauLedgerConflictError } from './command-ledger';
import { BureauError, createBureau } from './create-bureau';
import { createSqliteStorageFixture } from './test/storage-fixtures';
import type { Bureau } from './types';
import type { AgentDefinitions } from './agent-catalog';

const ORIGIN = '2026-10-13T00:00:00.000Z';

/** Built rows, as an adapter would hand them over: ids and content parts of their own. */
function builtRows(now: string, ...inputs: Array<MessageInput & { id: string }>): Message[] {
  const history = appendMessages(createConversationHistory({ id: 'scratch' }), ...inputs, {
    now: () => now,
  });
  return history.ids.map((id) => history.messages[id]!);
}

async function settle(bureau: Bureau, runId: string): Promise<void> {
  await waitForRunState(bureau, runId);
  for (let turn = 0; turn < 10; turn++) await yieldToPortableEventLoop();
}

const userRow = (id: string, ...parts: string[]): MessageInput & { id: string } => ({
  id,
  role: 'user',
  content: parts.map((text) => ({ type: 'text' as const, text })),
});

describe('createRun appendMessages', () => {
  it('appends the rows verbatim, after the system prompt, and the run answers them', async () => {
    const seen: Array<ReadonlyArray<Message>> = [];
    const bureau = await createBureau<AgentDefinitions>({
      agents: {
        default: createAgent({
          generate: async (context) => {
            seen.push(context.conversation.getMessages({ includeHidden: true }));
            return { content: 'Done.', toolCalls: [] };
          },
          instructions: 'You are helpful.',
        }),
      },
      persistence: textValueStore(new MemoryStorage()),
    });
    try {
      const run = await bureau.createRun({
        agentName: 'default',
        appendMessages: builtRows(ORIGIN, userRow('client-row-1', 'first part', 'second part')),
      });
      await settle(bureau, run.id);

      const rows = seen[0]!;
      expect(rows.map((row) => row.role)).toEqual(['system', 'user']);
      expect(rows[1]!.id).toBe('client-row-1');
      expect(rows[1]!.content).toEqual([
        { type: 'text', text: 'first part' },
        { type: 'text', text: 'second part' },
      ]);
      const session = await bureau.getSession(run.sessionId);
      expect(session?.conversationHistory.ids).toContain('client-row-1');
    } finally {
      await bureau.dispose();
    }
  });

  it('refuses rows that leave the conversation ending in an assistant row', async () => {
    const bureau = await createBureau<AgentDefinitions>({
      agents: {
        default: createAgent({ generate: async () => ({ content: 'Done.', toolCalls: [] }) }),
      },
      persistence: textValueStore(new MemoryStorage()),
    });
    try {
      const rows = builtRows(ORIGIN, userRow('u-1', 'hi'), {
        id: 'a-1',
        role: 'assistant',
        content: 'hello',
      });

      const error = await bureau.createRun({ agentName: 'default', appendMessages: rows }).then(
        () => undefined,
        (rejection: unknown) => rejection,
      );

      expect((error as BureauError).code).toBe('BAD_REQUEST');
      expect(bureau.listRuns()).toHaveLength(0);
    } finally {
      await bureau.dispose();
    }
  });

  it('refuses an appendMessages that is not a list of messages', async () => {
    const bureau = await createBureau<AgentDefinitions>({
      agents: {
        default: createAgent({ generate: async () => ({ content: 'Done.', toolCalls: [] }) }),
      },
    });
    try {
      for (const bad of ['text', [{ role: 'user' }], [null]]) {
        const error = await bureau
          .createRun({ agentName: 'default', appendMessages: bad as never })
          .then(
            () => undefined,
            (rejection: unknown) => rejection,
          );
        expect((error as BureauError).code).toBe('BAD_REQUEST');
      }
    } finally {
      await bureau.dispose();
    }
  });

  it('refuses a row whose id the session already holds', async () => {
    const bureau = await createBureau<AgentDefinitions>({
      agents: {
        default: createAgent({ generate: async () => ({ content: 'Done.', toolCalls: [] }) }),
      },
      persistence: textValueStore(new MemoryStorage()),
    });
    try {
      const first = await bureau.createRun({
        agentName: 'default',
        appendMessages: builtRows(ORIGIN, userRow('same', 'a')),
      });
      await settle(bureau, first.id);

      const error = await bureau
        .createRun({
          agentName: 'default',
          sessionId: first.sessionId,
          appendMessages: builtRows(ORIGIN, userRow('same', 'b')),
        })
        .then(
          () => undefined,
          (rejection: unknown) => rejection,
        );

      expect((error as BureauError).code).toBe('BAD_REQUEST');
    } finally {
      await bureau.dispose();
    }
  });
});

describe('createRun appendMessages and the task it admits', () => {
  it('records the text of the appended user row as the task’s originating message, across a restart', async () => {
    const runtime = createManualRuntimeServices({ origin: ORIGIN });
    const fixture = createSqliteStorageFixture({ runtime });
    const open = () =>
      createBureau<AgentDefinitions>({
        agents: {
          default: createAgent({
            generate: async () => ({ content: 'Done.', toolCalls: [] }),
            toolbox: createToolbox<readonly Tool[]>([]),
          }),
        },
        runtime,
        storage: fixture.configuration,
        durableExecution: true,
        durableOwnership: { ownership: 'none' },
      });
    try {
      const first = await open();
      const run = await first.createRun({
        agentName: 'default',
        principal: 'alice',
        appendMessages: builtRows(ORIGIN, userRow('client-row-1', 'plan ', 'my trip')),
      });
      await settle(first, run.id);
      await first.dispose();

      const second = await open();
      try {
        const history = await second.tasks.history(run.id);
        expect(history?.map((message) => message.text)).toEqual(['plan my trip']);
      } finally {
        await second.dispose();
      }
    } finally {
      await fixture.dispose();
    }
  });
});

describe('createRun appendMessages under a run-creation request id', () => {
  async function withDurableBureau(body: (bureau: Bureau) => Promise<void>): Promise<void> {
    const runtime = createManualRuntimeServices({ origin: ORIGIN });
    const fixture = createSqliteStorageFixture({ runtime });
    const bureau = await createBureau<AgentDefinitions>({
      agents: {
        default: createAgent({
          generate: async () => ({ content: 'Done.', toolCalls: [] }),
          toolbox: createToolbox<readonly Tool[]>([]),
        }),
      },
      runtime,
      storage: fixture.configuration,
      durableExecution: true,
      durableOwnership: { ownership: 'none' },
    });
    try {
      await body(bureau);
    } finally {
      await bureau.dispose();
      await fixture.dispose();
    }
  }

  const request = (rows: ReadonlyArray<Message>) => ({
    agentName: 'default',
    principal: 'alice',
    runCreationRequestId: 'request-1',
    sessionId: 'session-1',
    appendMessages: rows,
  });

  it('treats a retry with the same rows as the same command, whatever stamped them', async () => {
    await withDurableBureau(async (bureau) => {
      const first = await bureau.createRun(
        request(builtRows('2026-10-13T00:00:00.000Z', userRow('row-1', 'hello'))),
      );
      const retry = await bureau.createRun(
        request(builtRows('2026-10-13T00:05:00.000Z', userRow('row-1', 'hello'))),
      );

      expect(retry.id).toBe(first.id);
    });
  });

  it('refuses a retry whose rows differ', async () => {
    await withDurableBureau(async (bureau) => {
      await bureau.createRun(request(builtRows(ORIGIN, userRow('row-1', 'hello'))));

      const error = await bureau
        .createRun(request(builtRows(ORIGIN, userRow('row-1', 'goodbye'))))
        .then(
          () => undefined,
          (rejection: unknown) => rejection,
        );

      expect(error).toBeInstanceOf(BureauLedgerConflictError);
    });
  });

  it('does not mistake a request with no message for one with an empty message', async () => {
    await withDurableBureau(async (bureau) => {
      const rows = builtRows(ORIGIN, userRow('row-1', 'hello'));
      await bureau.createRun(request(rows));

      const error = await bureau.createRun({ ...request(rows), message: 'and also this' }).then(
        () => undefined,
        (rejection: unknown) => rejection,
      );

      expect(error).toBeInstanceOf(BureauLedgerConflictError);
    });
  });
});

describe('Bureau.hasDurableEngine', () => {
  it('is false without a durable engine and true with one', async () => {
    const plain = await createBureau<AgentDefinitions>({
      agents: {
        default: createAgent({ generate: async () => ({ content: '', toolCalls: [] }) }),
      },
    });
    try {
      expect(plain.hasDurableEngine).toBe(false);
    } finally {
      await plain.dispose();
    }

    const runtime = createManualRuntimeServices({ origin: ORIGIN });
    const fixture = createSqliteStorageFixture({ runtime });
    const durable = await createBureau<AgentDefinitions>({
      agents: {
        default: createAgent({ generate: async () => ({ content: '', toolCalls: [] }) }),
      },
      runtime,
      storage: fixture.configuration,
      durableExecution: true,
      durableOwnership: { ownership: 'none' },
    });
    try {
      expect(durable.hasDurableEngine).toBe(true);
    } finally {
      await durable.dispose();
      await fixture.dispose();
    }
  });
});

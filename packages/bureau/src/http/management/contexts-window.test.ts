/**
 * COR-1937 — `bureau.contexts.window` reports how full a context's window is: categories that sum
 * to the estimate, the provider's own count when a step reported one, and the window of the model
 * the context would answer on. It answers for a running chat without waiting on the run, and
 * authorizes exactly as `bureau.contexts.get` does.
 */
import {
  createAgent,
  createModelCatalog,
  type GenerateFunction,
  withBackendDescriptors,
} from '@lostgradient/operative';
import { MemoryStorage } from '@lostgradient/storage';
import { describe, expect, it } from 'bun:test';

import { waitForCondition, waitForTaskState } from '../../test';
import type { ContextWindowReport } from '../../types.ts';
import { modelsOf, noopTool, OPUS_5, OPUS_5_5 } from '../../testing/model-override.test-support.ts';
import {
  openBureau,
  type OpenedBureau,
  OWNER,
  parkingUntilAborted,
  rpc,
  type RpcBody,
} from './management-fixtures.test-support.ts';

const rows = createModelCatalog().descriptors;
const row = (choice: { provider: string; model: string }) => {
  const found = rows.find((candidate) => candidate.model === choice.model);
  if (found === undefined) throw new Error(`The default catalog has no ${choice.model} row.`);
  return found;
};
/** Two rows with windows that tell them apart; the default catalog gives both a million. */
const SMALL = { ...row(OPUS_5), contextWindowTokens: 111_000 };
const LARGE = { ...row(OPUS_5_5), contextWindowTokens: 222_000 };

/** Reports `usage` on its only step, and answers at once. */
const reporting: GenerateFunction = async () => ({
  content: 'Done.',
  toolCalls: [],
  usage: { prompt: 40, completion: 6, total: 46, cacheReadTokens: 900, cacheCreationTokens: 60 },
});

const chooser = createAgent({
  name: 'chooser',
  instructions: 'You are a careful chooser.',
  tools: { noop: noopTool },
  // The agent's default is the small window; the large one is allowed.
  generate: withBackendDescriptors(reporting, [SMALL]),
  allowedCandidates: [OPUS_5, OPUS_5_5],
});

const parked = createAgent({
  name: 'parked',
  instructions: 'You wait.',
  generate: parkingUntilAborted,
});

async function withBureau<T>(body: (opened: OpenedBureau) => Promise<T>): Promise<T> {
  const opened = await openBureau({
    agents: { chooser, parked },
    bureauOptions: { models: modelsOf([SMALL, LARGE]) },
  });
  try {
    return await body(opened);
  } finally {
    await opened.dispose();
  }
}

const windowOf = (opened: OpenedBureau, contextId: string, key = 'alice-key'): Promise<RpcBody> =>
  rpc(opened.handler, 'bureau.contexts.window', { contextId }, key);

/** A finished chat, with its session saved. */
async function finishedChat(opened: OpenedBureau, principal: string = OWNER.alice) {
  const run = await opened.bureau.tasks.start('chooser', 'Which one?', { principal });
  await waitForTaskState(opened.bureau, run.id);
  await waitForCondition(async () => {
    const session = await opened.bureau.contexts.get(run.contextId);
    return Object.values(session?.conversationHistory.messages ?? {}).some(
      (message) => message.role === 'assistant',
    );
  }, 'session saved');
  return run;
}

const reportOf = (body: RpcBody): ContextWindowReport =>
  body.result as unknown as ContextWindowReport;

describe('bureau.contexts.window', () => {
  it('splits a finished chat into categories that sum to usedEstimated', async () => {
    await withBureau(async (opened) => {
      const run = await finishedChat(opened);

      const body = await windowOf(opened, run.contextId);

      expect(body.error).toBeUndefined();
      const report = reportOf(body);
      expect(report.categories.map((category) => category.name)).toEqual([
        'system',
        'tools',
        'messages',
        'memory',
        'attachments',
      ]);
      expect(report.usedEstimated).toBe(
        report.categories.reduce((total, category) => total + category.tokens, 0),
      );
      const tokens = Object.fromEntries(
        report.categories.map((category) => [category.name, category.tokens]),
      );
      expect(tokens['system']).toBeGreaterThan(0);
      expect(tokens['tools']).toBeGreaterThan(0);
      expect(tokens['messages']).toBeGreaterThan(0);
      expect(tokens['memory']).toBe(0);
      expect(tokens['attachments']).toBe(0);
    });
  });

  it('reports the provider’s input tokens for the latest step, cache included', async () => {
    await withBureau(async (opened) => {
      const run = await finishedChat(opened);

      const report = reportOf(await windowOf(opened, run.contextId));

      expect(report.usedReported).toBe(40 + 900 + 60);
    });
  });

  it('reports usedReported null for a chat whose step reported no usage', async () => {
    await withBureau(async (opened) => {
      const run = await opened.bureau.tasks.start('parked', 'wait', { principal: OWNER.alice });
      await waitForCondition(
        () => opened.bureau.tasks.detail(run.id)?.status === 'running',
        'run started',
      );

      const report = reportOf(await windowOf(opened, run.contextId));

      expect(report.usedReported).toBeNull();
    });
  });

  it('takes maxTokens from the catalog row of the agent’s default model, then of the steered one', async () => {
    await withBureau(async (opened) => {
      const run = await finishedChat(opened);
      expect(reportOf(await windowOf(opened, run.contextId)).maxTokens).toBe(111_000);

      const steered = await rpc(
        opened.handler,
        'bureau.contexts.steer',
        { contextId: run.contextId, commandId: 'switch', override: OPUS_5_5 },
        'alice-key',
      );
      expect(steered.result).toMatchObject({ outcome: 'accepted' });

      expect(reportOf(await windowOf(opened, run.contextId)).maxTokens).toBe(222_000);
    });
  });

  it('estimates a chat with no run from its agent’s definition', async () => {
    await withBureau(async (opened) => {
      const run = await finishedChat(opened);
      const fork = await rpc(
        opened.handler,
        'bureau.contexts.fork',
        { contextId: run.contextId, commandId: 'empty', throughMessageId: null },
        'alice-key',
      );
      const contextId = fork.result?.['contextId'] as string;

      const report = reportOf(await windowOf(opened, contextId));

      const tokens = Object.fromEntries(
        report.categories.map((category) => [category.name, category.tokens]),
      );
      // The instructions and the tool schema come from the definition; there is nothing else yet.
      expect(tokens['system']).toBeGreaterThan(0);
      expect(tokens['tools']).toBeGreaterThan(0);
      expect(tokens['messages']).toBe(0);
      expect(report.usedReported).toBeNull();
      expect(report.usedEstimated).toBe(
        report.categories.reduce((total, category) => total + category.tokens, 0),
      );
    });
  });

  it('answers for a running chat without waiting on the run', async () => {
    await withBureau(async (opened) => {
      const run = await opened.bureau.tasks.start('parked', 'wait', { principal: OWNER.alice });
      await waitForCondition(
        () => opened.bureau.tasks.detail(run.id)?.status === 'running',
        'run started',
      );

      const body = await windowOf(opened, run.contextId);

      expect(body.error).toBeUndefined();
      expect(reportOf(body).usedEstimated).toBeGreaterThan(0);
      // The run is still parked: the read neither finished it nor waited for it.
      expect(opened.bureau.tasks.detail(run.id)?.status).toBe('running');
    });
  });

  it('answers another owner’s context and a missing one as NotFound, and an operator’s read in full', async () => {
    await withBureau(async (opened) => {
      const run = await finishedChat(opened);

      const denied = await windowOf(opened, run.contextId, 'bob-key');
      const missing = await windowOf(opened, 'no-such-context');
      const operator = await windowOf(opened, run.contextId, 'operator-key');

      expect(denied.error?.data).toMatchObject({ weftCode: 'NotFound' });
      expect(missing.error?.data).toMatchObject({ weftCode: 'NotFound' });
      expect(denied.error?.message).toBe(
        missing.error?.message?.replace('no-such-context', run.contextId),
      );
      expect(operator.error).toBeUndefined();
      expect(reportOf(operator).usedEstimated).toBeGreaterThan(0);
    });
  });

  it('reads the latest step’s usage from the durable checkpoint once the run is no longer held in memory', async () => {
    const storage = new MemoryStorage();
    const first = await openBureau({
      agents: { chooser },
      storage,
      bureauOptions: { models: modelsOf([SMALL, LARGE]) },
    });
    const run = await finishedChat(first);
    await first.dispose();

    // A restarted Bureau holds no run state for the finished task; its checkpoint remains.
    const second = await openBureau({
      agents: { chooser },
      storage,
      bureauOptions: { models: modelsOf([SMALL, LARGE]) },
    });
    try {
      expect(second.bureau.tasks.detail(run.id)).toBeUndefined();

      const report = reportOf(await windowOf(second, run.contextId));

      expect(report.usedReported).toBe(40 + 900 + 60);
    } finally {
      await second.dispose();
    }
  });

  it('reads the same report in process as over the wire', async () => {
    await withBureau(async (opened) => {
      const run = await finishedChat(opened);

      const direct = await opened.bureau.contexts.window(run.contextId);
      const wire = reportOf(await windowOf(opened, run.contextId));

      expect(direct).toEqual(wire);
      expect(await opened.bureau.contexts.window('no-such-context')).toBeUndefined();
      expect(
        await opened.bureau.contexts.window(run.contextId, { incarnation: 'another-incarnation' }),
      ).toBeUndefined();
    });
  });
});

/**
 * Executable copy of the Quick Start example in this package's README.
 *
 * The example test reproduces the documented example as written. Only the
 * imports (`./index` stands in for `@lostgradient/bureau`), the SQLite path (a
 * per-process temporary file, removed afterwards), and the `generate` differ: the
 * README declares one, and the test passes a mock in its place. The test
 * also waits for the run's session save before disposing; see
 * `terminalSessionSaved`. Every result the README claims in a comment is
 * asserted. Change the example and this test together.
 */

import type { GenerateFunction } from '@lostgradient/operative';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { type BureauContexts, createBureau, type TaskHandle } from './index';
import { createAgent } from '@lostgradient/operative';
import type { AgentDefinitions } from './agent-catalog';
import { createSqliteStorageFixture, type PersistentBureauStorageFixture } from './test/storage-fixtures';

let database: PersistentBureauStorageFixture;

beforeEach(() => {
  database = createSqliteStorageFixture();
});

afterEach(async () => {
  await database.dispose();
});

/**
 * Stands in for the README's Anthropic provider: answers every step without
 * calling a tool.
 */
const answerWithoutTools: GenerateFunction = async () => ({
  content: 'Q3 revenue grew while costs held flat.',
  toolCalls: [],
});

/**
 * Resolves once Bureau has saved the run's terminal status to its session.
 *
 * Bureau starts that save after `run.completed` without tracking it, so
 * `dispose()` does not wait for it. Disposing the moment the run completes can
 * stop the durable event producer before the save's outbox entry is recorded,
 * and Bureau then reports the entry as not durably recorded. That shutdown race
 * is separate from the README's wait, so these tests step around it.
 */
async function terminalSessionSaved(
  bureau: { readonly contexts: Pick<BureauContexts, 'get'> },
  run: Pick<TaskHandle, 'id' | 'contextId'>,
): Promise<void> {
  for (;;) {
    const session = await bureau.contexts.get(run.contextId);
    const metadata = session?.metadata;
    if (metadata?.['lastRunId'] === run.id && metadata['lastRunStatus'] !== 'running') return;
    await Bun.sleep(5);
  }
}

describe('README — Quick Start', () => {
  it('waits for the run to finish through a subscription it closes on the terminal action', async () => {
    const bureau = await createBureau<AgentDefinitions>({
      agents: { summarizer: createAgent({ generate: answerWithoutTools }) },
      storage: database.storage,
    });

    const run = await bureau.tasks.start('summarizer', 'Summarize the Q3 report.');
    expect(bureau.tasks.detail(run.id)?.status).toBe('running');

    // Wait for completion via the live event surface. A run records many actions
    // before it finishes, so keep the subscription open until this run's terminal
    // action arrives, then close it.
    await new Promise<void>((resolve) => {
      const subscription = bureau.subscribe('action', ({ action }) => {
        if (action.runId !== run.id) return;
        if (action.type === 'run.completed' || action.type === 'run.aborted') {
          subscription.unsubscribe();
          resolve();
        }
      });
    });

    const detail = bureau.tasks.detail(run.id);
    // One of the README's `"stop-condition" | "maximum-steps" | …`: the agent's default stop
    // condition ends the run on the first answer that calls no tool.
    expect(detail?.finishReason).toBe('stop-condition');

    await terminalSessionSaved(bureau, run);
    await bureau.dispose();
  });

  it('cannot wait with `once`, because `once` detaches after the first action of any type', async () => {
    const bureau = await createBureau<AgentDefinitions>({
      agents: {
        default: createAgent({ generate: answerWithoutTools }),
      },
      storage: database.storage,
    });
    const everyAction: string[] = [];
    const settled = Promise.withResolvers<void>();
    bureau.addEventListener('action', ({ action }) => {
      everyAction.push(action.type);
      if (action.type === 'run.completed') settled.resolve();
    });
    const heardByOnce: string[] = [];
    bureau.once('action', ({ action }) => heardByOnce.push(action.type));

    const run = await bureau.tasks.start('default', 'Summarize the Q3 report.');
    await settled.promise;

    expect(heardByOnce).toEqual(['run.started']);
    expect(everyAction[0]).toBe('run.started');
    expect(everyAction.at(-1)).toBe('run.completed');

    await terminalSessionSaved(bureau, run);
    await bureau.dispose();
  });
});

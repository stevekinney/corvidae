/**
 * COR-1937 premise probe: where does a provider-reported input figure live after a step, per step,
 * on a session? The brief assumed it is stored on the session; this pins what is true, so the
 * `contexts.window` design reads from a source that exists.
 *
 * Findings, each pinned below:
 *
 * 1. The session's committed assistant row carries no `tokenUsage` on the non-streaming path
 *    (`packages/operative/src/run-step-row.ts` `commitAssistantRow`, lines 62 to 70, appends
 *    `{ role, content, metadata }` only). Only the streaming path writes it
 *    (`packages/operative/src/streaming/streaming-row.ts:428`).
 * 2. Each step's usage is on its `StepResult` (`packages/operative/src/types.ts:395`), and
 *    `bureau.tasks.detail(id).stepDetails[n].usage` shows it (`serialization.ts:274`), for a task
 *    this process still holds.
 * 3. A durable Bureau also keeps each step's usage in its checkpoint, cache counters included
 *    (`contexts-window.test.ts` reads it back after a restart).
 */
import { createAgent } from '@lostgradient/operative';
import { describe, expect, it } from 'bun:test';

import { waitForCondition } from '../test';
import { openBureau, OWNER } from '../http/management/management-fixtures.test-support.ts';

describe('where a step’s reported usage is kept (COR-1937 probe)', () => {
  it('is on the task’s step record and not on the session’s assistant row', async () => {
    const answering = createAgent({
      name: 'answering',
      generate: async () => ({
        content: 'Done.',
        toolCalls: [],
        usage: { prompt: 1234, completion: 56, total: 1290, cacheReadTokens: 100 },
      }),
    });
    const opened = await openBureau({ agents: { answering } });
    try {
      const run = await opened.bureau.tasks.start('answering', 'hello', {
        principal: OWNER.alice,
      });
      await run.result();

      const stepUsage = opened.bureau.tasks.detail(run.id)?.stepDetails.map((step) => step.usage);
      // The session is saved after the run settles, so wait for the assistant row to land.
      const assistantRows = async () => {
        const session = await opened.bureau.contexts.get(run.contextId);
        return Object.values(session?.conversationHistory.messages ?? {}).filter(
          (message) => message.role === 'assistant',
        );
      };
      await waitForCondition(async () => {
        const saved = await assistantRows();
        return saved.length === 1;
      }, 'assistant row saved');
      const rows = await assistantRows();

      expect(stepUsage).toEqual([
        { prompt: 1234, completion: 56, total: 1290, cacheReadTokens: 100 },
      ]);
      expect(rows[0]?.tokenUsage).toBeUndefined();
    } finally {
      await opened.dispose();
    }
  });
});

/**
 * COR-2524 — a run cancelled from a process that does not hold it settles with the cost of the
 * steps it completed, and a run's `RUN_FINISHED` carries its cost.
 *
 * Two Bureaus share one SQLite store: A holds a run, and B cancels it. B holds no cost estimate (the
 * run's pricing and checkpoint are A's), and A, seeing B's terminal commit, writes nothing of the
 * run's end, so the figure on the task is the last one A recorded after a step: the cost of the
 * steps it completed, never `0` and never `null` for a priced run.
 */
import { EventType } from '@ag-ui/core';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { afterEach, describe, expect, it, spyOn } from 'bun:test';

import { runAgentInput, startRequest } from './http/ag-ui-fixtures.test-support.ts';
import { FrameReader } from './http/ag-ui-stream.test-support.ts';
import { createBureauHandler } from './http/create-bureau-handler.ts';
import { createSqliteStorageFixture } from './test/storage-fixtures.ts';
import { agentFileText, KNOWN_MODEL } from './testing/agent-file-fixtures.test-support.ts';
import {
  type FileBureauHarness,
  startFileBureau,
} from './testing/agent-file-bureau.test-support.ts';
import { createVendorCatalog } from './testing/vendor-catalog.test-support.ts';

const PRICING = createVendorCatalog().descriptors.find(
  (row) => row.model === 'claude-opus-5-5',
)!.pricing!;
const STEP = { prompt: 50_000, completion: 10_000, total: 60_000 };
const STEP_COST =
  (STEP.prompt / 1_000_000) * PRICING.inputPerMillionTokens +
  (STEP.completion / 1_000_000) * PRICING.outputPerMillionTokens;
const TOOL_CALL = [{ name: 'lookup-order', arguments: {} }];

/** A renewal interval short enough that each Bureau hears the other's commits promptly. */
const OWNERSHIP = {
  ownership: 'workflow-lease',
  workflowClaimTtlMs: 30_000,
  workflowClaimRenewIntervalMs: 25,
} as const;

const AGENT = agentFileText({ model: KNOWN_MODEL, tools: '[lookup-order]' });

function heldSecondStep() {
  const reached = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  let generations = 0;
  return {
    reached: reached.promise,
    release: gate.resolve,
    script: async () => {
      generations += 1;
      if (generations === 1) return { content: '', usage: STEP, toolCalls: TOOL_CALL };
      reached.resolve();
      await gate.promise;
      return { content: 'late', usage: STEP };
    },
  };
}

const harnesses: FileBureauHarness[] = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0).toReversed()) await harness.dispose();
});

describe('the cost of a run cancelled from another process (COR-2524)', () => {
  it('(d) records the cost of the steps the holder completed, and the holder adds nothing after', async () => {
    const warnings: unknown[] = [];
    const emitWarning = spyOn(process, 'emitWarning').mockImplementation((warning) => {
      warnings.push(warning);
    });
    const fixture = createSqliteStorageFixture({});
    try {
      const model = heldSecondStep();
      const holder = await startFileBureau({
        scripts: { 'claude-opus-5-5': model.script as never },
        overrides: { id: 'cost-peers', storage: fixture.storage, durableOwnership: OWNERSHIP },
      });
      harnesses.push(holder);
      const peer = await startFileBureau({
        directory: holder.directory,
        overrides: { id: 'cost-peers', storage: fixture.open(), durableOwnership: OWNERSHIP },
      });
      harnesses.push(peer);
      await holder.put('helper.md', AGENT);
      await holder.bureau.agents.refresh();

      const task = await holder.bureau.tasks.start('helper', 'Go.');
      await model.reached;
      await waitUntil(async () => (await peer.bureau.tasks.get(task.id))?.usage !== null);

      const cancelled = await peer.bureau.tasks.cancel(task.id);
      expect(cancelled.receipt).not.toBe('rejected');
      await waitUntil(async () => (await peer.bureau.tasks.get(task.id))?.status === 'canceled');
      // The canceller wrote the settlement and no figure: the one on the record is the holder's.
      const settled = await peer.bureau.tasks.get(task.id);
      expect(settled?.usage?.costUsd).toBeCloseTo(STEP_COST, 10);
      expect(settled?.usage?.totalTokens).toBe(STEP.total);

      // The holder's held step ends after the cancel and records nothing: the figure stands.
      model.release();
      await waitUntil(() => holder.bureau.tasks.detail(task.id)?.status !== 'running');
      await holder.bureau.internals.taskRegistry.flush();
      const afterwards = await peer.bureau.tasks.get(task.id);
      expect(afterwards?.status).toBe('canceled');
      expect(afterwards?.usage).toEqual(settled?.usage ?? null);
    } finally {
      await Promise.all(
        harnesses
          .splice(0)
          .toReversed()
          .map((harness) => harness.dispose()),
      );
      await fixture.dispose();
      emitWarning.mockRestore();
    }
    for (const warning of warnings) {
      expect((warning as Error).name).toBe('WeftWorkflowClaimLostWarning');
    }
  });
});

describe('RUN_FINISHED carries the run’s cost (COR-2524)', () => {
  async function finishedOf(options: {
    readonly model: string;
    readonly catalog?: ReturnType<typeof createVendorCatalog>['descriptors'];
  }) {
    const harness = await startFileBureau({
      scripts: { [options.model.split('/')[1]!]: () => ({ content: 'Done.', usage: STEP }) },
      overrides: {
        id: 'run-finished-cost',
        durable: true,
        ...(options.catalog === undefined ? {} : { models: { catalog: options.catalog } }),
      },
    });
    harnesses.push(harness);
    await harness.put('helper.md', agentFileText({ model: options.model }));
    await harness.bureau.agents.refresh();
    const handler = createBureauHandler(harness.bureau, {
      unauthenticatedAccess: 'allow',
      agUi: {},
    });
    const reader = new FrameReader(
      await handler(startRequest(runAgentInput({ threadId: 'thread-1' }), {}, 'helper')),
    );
    const frames = await reader.rest();
    const finished = frames
      .map((frame) => frame.event)
      .find((event) => event.type === EventType.RUN_FINISHED);
    expect(finished).toBeDefined();
    return finished as unknown as { usage: Array<Record<string, unknown>> };
  }

  it('says the dollars for a priced run', async () => {
    const finished = await finishedOf({ model: KNOWN_MODEL });
    expect(finished.usage[0]).toMatchObject({
      inputTokens: STEP.prompt,
      outputTokens: STEP.completion,
      totalTokens: STEP.total,
    });
    expect(finished.usage[0]!['costUsd']).toBeCloseTo(STEP_COST, 10);
  });

  it('says null, not zero, for a run on a model with no catalog price', async () => {
    const finished = await finishedOf({
      model: 'openai/gpt-4.1',
      catalog: createVendorCatalog().descriptors.map((row) =>
        row.model === 'gpt-4.1' ? { ...row, pricing: undefined } : row,
      ),
    });
    expect(finished.usage[0]!['costUsd']).toBeNull();
    expect(finished.usage[0]!['totalTokens']).toBe(STEP.total);
  });
});

/**
 * COR-1707 — a durable `tasks.start` with a `commandId` and a caller `signal`: the run starts
 * executing once its workflow is prepared, before its receipt is recorded, so the signal must
 * reach the run from that point and not only once the receipt write returns. A receipt write
 * that fails leaves no task running that its caller was told failed to start.
 *
 * Each scenario holds the ledger's receipt write (the entry moving to `completed`) at the
 * storage layer, and holds the agent's first generate call, so the order of abort, generate,
 * and receipt write is the test's to choose rather than the scheduler's.
 */
import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import { createAgent, type GenerateFunction, stopWhen } from '@lostgradient/operative';
import { type BatchOperation, resolveStorage, type Storage } from '@lostgradient/weft';
import { createTool, createToolbox, type Tool } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import type { AgentDefinitions } from './agent-catalog';
import { RunCreationReceiptUnrecordedError } from './command-ledger';
import { createBureau } from './create-bureau';
import { createSqliteStorageFixture } from './test/storage-fixtures';
import { rejectionOf } from './testing/promise-outcome.test-support.ts';
import type { Bureau, BureauDiagnostic } from './types';

const ORIGIN = '2026-10-27T00:00:00.000Z';
const LEDGER_ENTRY_PREFIX = 'command-ledger:v1:entry:';
const WRITE_VERBS = new Set<PropertyKey>(['put', 'batch', 'conditionalBatch']);
const decoder = new TextDecoder();

/** The ledger entries a storage write call is about to put, decoded. */
function ledgerEntriesOf(verb: string, args: readonly unknown[]): unknown[] {
  const puts: { key: string; value: Uint8Array }[] =
    verb === 'put'
      ? [{ key: args[0] as string, value: args[1] as Uint8Array }]
      : ((verb === 'batch' ? args[0] : args[1]) as BatchOperation[]).flatMap((operation) =>
          operation.type === 'put' ? [operation] : [],
        );
  return puts
    .filter((put) => put.key.startsWith(LEDGER_ENTRY_PREFIX))
    .map((put) => JSON.parse(decoder.decode(put.value)) as unknown);
}

function isCompletedRunEntry(entry: unknown): entry is { claim: { runId: string } } {
  return (
    typeof entry === 'object' &&
    entry !== null &&
    Reflect.get(entry, 'state') === 'completed' &&
    typeof Reflect.get(Reflect.get(entry, 'claim') as object, 'runId') === 'string'
  );
}

/**
 * Holds the first receipt write on `storage` until `release()`: it then lands, or, with
 * `outcome: 'reject'`, fails without reaching the backend. `held` resolves with the run the
 * receipt is for once the write is intercepted.
 */
function holdReceiptWrite(
  storage: Storage,
  outcome: 'land' | 'reject',
): { storage: Storage; held: Promise<string>; release(): void } {
  let markHeld: (runId: string) => void = () => {};
  const held = new Promise<string>((resolve) => {
    markHeld = resolve;
  });
  let release: () => void = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let armed = true;
  const wrapped = new Proxy(storage, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      if (!WRITE_VERBS.has(property)) return value.bind(target);
      return async (...args: unknown[]) => {
        const receipt = armed
          ? ledgerEntriesOf(String(property), args).find(isCompletedRunEntry)
          : undefined;
        if (receipt !== undefined) {
          armed = false;
          markHeld(receipt.claim.runId);
          await released;
          if (outcome === 'reject') throw new Error('The receipt write failed.');
        }
        return Reflect.apply(value, target, args) as unknown;
      };
    },
  });
  return { storage: wrapped, held, release: () => release() };
}

/**
 * An agent whose first generate call waits for `releaseGenerate()` and asks for the `record`
 * tool, and whose next call ends the run. `toolCalls` counts the tool's executions.
 */
function heldToolAgent(): {
  generate: GenerateFunction;
  tool: Tool;
  generateCalls(): number;
  toolCalls(): number;
  releaseGenerate(): void;
} {
  let generateCalls = 0;
  let toolCalls = 0;
  let releaseGenerate: () => void = () => {};
  const released = new Promise<void>((resolve) => {
    releaseGenerate = resolve;
  });
  return {
    generate: async ({ step }) => {
      generateCalls += 1;
      await released;
      return step === 0
        ? { content: '', toolCalls: [{ name: 'record', arguments: {} }] }
        : { content: 'done', toolCalls: [] };
    },
    tool: createTool({
      name: 'record',
      description: 'Records that it ran.',
      input: z.object({}),
      execute: async () => {
        toolCalls += 1;
        return {};
      },
    }),
    generateCalls: () => generateCalls,
    toolCalls: () => toolCalls,
    releaseGenerate: () => releaseGenerate(),
  };
}

interface Scenario {
  readonly bureau: Bureau;
  readonly agent: ReturnType<typeof heldToolAgent>;
  readonly receipt: ReturnType<typeof holdReceiptWrite>;
  readonly diagnostics: readonly BureauDiagnostic[];
}

async function withScenario(
  outcome: 'land' | 'reject',
  body: (scenario: Scenario) => Promise<void>,
): Promise<void> {
  const runtime = createManualRuntimeServices({ origin: ORIGIN });
  const fixture = createSqliteStorageFixture({ runtime });
  const storage = await resolveStorage(fixture.configuration);
  const receipt = holdReceiptWrite(storage, outcome);
  const agent = heldToolAgent();
  const diagnostics: BureauDiagnostic[] = [];
  const bureau = await createBureau<AgentDefinitions>({
    agents: {
      default: createAgent({
        generate: agent.generate,
        toolbox: createToolbox<readonly Tool[]>([agent.tool]),
        stopWhen: stopWhen.noToolCalls(),
      }),
    },
    runtime,
    storage: receipt.storage,
    durable: true,
    durableOwnership: { ownership: 'none' },
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });
  try {
    await body({ bureau, agent, receipt, diagnostics });
  } finally {
    receipt.release();
    agent.releaseGenerate();
    await bureau.dispose();
    storage[Symbol.dispose]();
    await fixture.dispose();
  }
}

const START = { principal: 'alice', commandId: 'request-1' } as const;

describe('tasks.start with a commandId and a signal, around the receipt write', () => {
  it('aborts the run before any tool executes when the signal fires during a slow receipt write', async () => {
    await withScenario('land', async ({ bureau, agent, receipt }) => {
      const controller = new AbortController();
      const starting = bureau.tasks.start('default', 'Reconcile.', {
        ...START,
        signal: controller.signal,
      });
      const runId = await receipt.held;

      controller.abort('the caller gave up');
      agent.releaseGenerate();
      // The run settles while its receipt write is still held: the abort reached it.
      const settled = await bureau.tasks.wait(runId);
      receipt.release();
      const task = await starting;
      const result = await task.result();

      expect([settled?.status, agent.toolCalls(), result.finishReason]).toEqual([
        'cancelled',
        0,
        'aborted',
      ]);
    });
  });

  it('aborts the run, and rejects with the run named, when the receipt write fails', async () => {
    await withScenario('reject', async ({ bureau, agent, receipt }) => {
      const starting = bureau.tasks.start('default', 'Reconcile.', START);
      const runId = await receipt.held;

      receipt.release();
      const error = await rejectionOf(starting);
      agent.releaseGenerate();
      const settled = await bureau.tasks.wait(runId);

      expect(error).toBeInstanceOf(RunCreationReceiptUnrecordedError);
      expect((error as RunCreationReceiptUnrecordedError).runId).toBe(runId);
      // No task is left running for a caller that was told the start failed.
      expect([settled?.status, agent.toolCalls()]).toEqual(['cancelled', 0]);
    });
  });

  it('does nothing when the signal fires after the task settled', async () => {
    await withScenario('land', async ({ bureau, agent, receipt, diagnostics }) => {
      const controller = new AbortController();
      agent.releaseGenerate();
      receipt.release();
      const task = await bureau.tasks.start('default', 'Reconcile.', {
        ...START,
        signal: controller.signal,
      });
      const result = await task.result();

      controller.abort('too late');

      expect([result.finishReason, agent.toolCalls()]).toEqual(['stop-condition', 1]);
      const workflow = await bureau.tasks.workflow(task.id);
      expect(workflow?.status).toBe('completed');
      expect(bureau.tasks.detail(task.id)?.status).toBe('completed');
      expect(diagnostics).toEqual([]);
    });
  });

  it('executes nothing when the signal is already aborted at the call', async () => {
    await withScenario('land', async ({ bureau, agent, receipt }) => {
      const controller = new AbortController();
      controller.abort('cancelled before the start');
      agent.releaseGenerate();
      receipt.release();
      const task = await bureau.tasks.start('default', 'Reconcile.', {
        ...START,
        signal: controller.signal,
      });
      const result = await task.result();

      expect([result.finishReason, agent.generateCalls(), agent.toolCalls()]).toEqual([
        'aborted',
        0,
        0,
      ]);
    });
  });
});

/**
 * COR-2097 — `workflow.version-mismatch` reaches the feed when a Bureau recovers a run that was
 * checkpointed under another workflow version than the one it registers now. The engine reports it
 * from a callback while recovery runs, before the Bureau's emitter has a listener, so it is held
 * and delivered once. A run recovered under the same version publishes nothing.
 */
import { createAgent, stopWhen, WorkflowVersionMismatchEvent } from '@lostgradient/operative';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { createTool, createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import type { AgentDefinitions } from './agent-catalog';
import type { Bureau } from './bureau-types/facade';
import { bufferWorkflowVersionMismatches } from './bureau-event-forwarders';
import { createBureau } from './create-bureau';
import { createSqliteStorageFixture } from './test/storage-fixtures';

interface Envelope {
  readonly kind: string;
  readonly payload: Record<string, unknown>;
}

async function mismatches(bureau: Bureau): Promise<Envelope[]> {
  const found: Envelope[] = [];
  for await (const envelope of bureau.internals.eventFeed.feed.replay()) {
    const { kind, payload } = envelope as unknown as Envelope;
    if (kind === 'workflow.version-mismatch') found.push({ kind, payload });
  }
  return found;
}

const next = createTool({
  name: 'next',
  description: 'continue',
  input: z.object({}),
  execute: async () => 'ok',
});

/** Bureau A checkpoints a run under `v1` and hangs; B then recovers it under `registered`. */
async function recoverUnder(registered: string) {
  const database = createSqliteStorageFixture();
  let reachedStep1 = false;
  const bureauA = await createBureau<AgentDefinitions>({
    agents: {
      default: createAgent({
        generate: async ({ step }) => {
          if (step === 0)
            return { content: 'A step 0', toolCalls: [{ name: 'next', arguments: {} }] };
          reachedStep1 = true;
          return new Promise<never>(() => {});
        },
        toolbox: createToolbox([next]),
        stopWhen: stopWhen.noToolCalls(),
      }),
    },
    storage: database.storage,
    durable: true,
    durableOwnership: { ownership: 'none' },
    workflowVersion: 'v1',
    onDiagnostic: () => undefined,
  });
  const run = await bureauA.tasks.start('default', 'Recover me under a new version');
  await waitUntil(() => reachedStep1, { message: 'A reached its second step' });
  // A is left running, as a process that died would leave it: B finds the run still owned.
  const steps: number[] = [];
  const bureauB = await createBureau<AgentDefinitions>({
    agents: {
      default: createAgent({
        generate: async ({ step }) => {
          steps.push(step);
          return { content: `B recovered step ${step}`, toolCalls: [] };
        },
        toolbox: createToolbox([next]),
        stopWhen: stopWhen.noToolCalls(),
      }),
    },
    storage: database.open(),
    durable: true,
    durableOwnership: { ownership: 'none' },
    workflowVersion: registered,
    onDiagnostic: () => undefined,
  });
  return {
    run,
    bureauB,
    steps,
    async finish() {
      await bureauB.dispose();
      await bureauA.dispose();
      await database.dispose();
    },
  };
}

describe('workflow.version-mismatch on the feed (COR-2097)', () => {
  it('is published once, with the workflow and the two versions, for a run recovered under another version', async () => {
    const { run, bureauB, steps, finish } = await recoverUnder('v2');
    try {
      await waitUntil(() => steps.includes(1), { message: 'B resumed the run' });

      const found = await mismatches(bureauB);
      expect(found).toHaveLength(1);
      expect(found[0]?.payload).toEqual({
        workflowId: run.id,
        storedVersion: 'v1',
        registeredVersion: 'v2',
      });
    } finally {
      await finish();
    }
  });

  it('publishes nothing for a run recovered under the version it was checkpointed with', async () => {
    const { bureauB, steps, finish } = await recoverUnder('v1');
    try {
      await waitUntil(() => steps.includes(1), { message: 'B resumed the run' });

      expect(await mismatches(bureauB)).toEqual([]);
    } finally {
      await finish();
    }
  });
});

describe('the buffer the engine reports into (COR-2097)', () => {
  const event = (id: string) => new WorkflowVersionMismatchEvent(id, 'v1', 'v2');

  it('holds what was reported before anyone listened, and gives it to the first listener only', () => {
    const buffer = bufferWorkflowVersionMismatches();
    buffer.push(event('w1'));
    buffer.push(event('w2'));

    const first: string[] = [];
    const second: string[] = [];
    buffer.listen((held) => first.push(held.runId));
    buffer.listen((held) => second.push(held.runId));
    buffer.push(event('w3'));

    expect(first).toEqual(['w1', 'w2', 'w3']);
    expect(second).toEqual(['w3']);
  });

  it('stops delivering to a listener that has stopped', () => {
    const buffer = bufferWorkflowVersionMismatches();
    const seen: string[] = [];
    const stop = buffer.listen((held) => seen.push(held.runId));

    buffer.push(event('w1'));
    stop();
    buffer.push(event('w2'));

    expect(seen).toEqual(['w1']);
  });
});

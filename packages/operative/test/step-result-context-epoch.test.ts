import { createTestToolbox, createTool } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';
import { z } from 'zod';

import { noToolCalls } from '../src/conditions/predicates';
import { createContextEpochSealer } from '../src/context-epoch';
import { createActiveRun } from '../src/create-run';
import { createModelCatalog } from '../src/providers/model-catalog.ts';
import { createSelectionGate } from '../src/selection-gate';
import { createMockGenerate } from '../src/test/index';

const lookup = createTool({
  name: 'lookup',
  description: 'Looks something up',
  input: z.object({}),
  execute: async () => 'found',
});

function generate() {
  return createMockGenerate([
    { content: '', toolCalls: [{ name: 'lookup', arguments: {} }] },
    { content: 'Done.', toolCalls: [] },
  ]);
}

/** COR-768 — each step names the effective-context epoch its generate attempt sealed. */
describe('StepResult.contextEpochId', () => {
  it('names the epoch sealed for the attempt that produced each step', async () => {
    let next = 0;
    const sealer = createContextEpochSealer({ newEpochId: () => `epoch-${++next}` });
    const sealed: string[] = [];
    const result = await createActiveRun({
      generate: generate(),
      toolbox: createTestToolbox([lookup]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      contextEpoch: {
        seal: (input) => {
          const epoch = sealer.seal(input);
          sealed.push(epoch.epochId);
          return epoch;
        },
        current: () => sealer.current(),
      },
    }).result;
    expect(result.steps.map((step) => step.contextEpochId)).toEqual(sealed);
    expect(sealed).toEqual(['epoch-1', 'epoch-2']);
  });

  it('is absent when the run seals no epoch', async () => {
    const result = await createActiveRun({
      generate: generate(),
      toolbox: createTestToolbox([lookup]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
    }).result;
    expect(result.steps.every((step) => !('contextEpochId' in step))).toBe(true);
  });

  it('names the epoch of a mutated provider retry, which is what the response used', async () => {
    let next = 0;
    const sealer = createContextEpochSealer({ newEpochId: () => `epoch-${++next}` });
    let calls = 0;
    const result = await createActiveRun({
      generate: async () => {
        calls += 1;
        if (calls === 1) throw new Error('transient');
        return { content: 'Done.', toolCalls: [] };
      },
      toolbox: createTestToolbox([lookup]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      contextEpoch: sealer,
      retry: {
        attempts: 2,
        sleep: async () => {},
        // A mutation the sealer sees as a context change, so it seals a successor epoch.
        mutate: (context) => {
          const conversation = new Conversation(context.conversation.current);
          conversation.appendSystemMessage('Retrying with less context.');
          return { ...context, conversation };
        },
      },
    }).result;
    expect(result.steps[0]?.contextEpochId).toBe(sealer.current()?.epochId);
    expect(result.steps[0]?.contextEpochId).not.toBe('epoch-1');
  });
});

/** COR-1810 — each step keeps why it ran on its model and what that model saw. */
describe('StepResult.planReason and StepResult.effectiveContext', () => {
  const NOW = '2026-09-02T12:00:00.000Z';

  it('keeps the effective context of the attempt that produced each step, as ids and digests', async () => {
    const sealer = createContextEpochSealer({
      newEpochId: (() => {
        let next = 0;
        return () => `epoch-${++next}`;
      })(),
    });
    const conversation = new Conversation();
    conversation.appendUserMessage('PRIVATE-QUESTION-5e2a');
    const result = await createActiveRun({
      generate: generate(),
      toolbox: createTestToolbox([lookup]),
      conversation,
      stopWhen: noToolCalls(),
      contextEpoch: sealer,
    }).result;

    expect(result.steps.map((step) => step.effectiveContext?.epochId)).toEqual([
      'epoch-1',
      'epoch-2',
    ]);
    const second = result.steps[1]!.effectiveContext!;
    // The second step's request carried the question, the first answer, and the tool result.
    expect(second.messageCount).toBeGreaterThan(result.steps[0]!.effectiveContext!.messageCount);
    expect(second.messages.at(0)?.role).toBe('user');
    expect(second.truncated).toBe(false);
    expect(JSON.stringify(result.steps.map((step) => step.effectiveContext))).not.toContain(
      'PRIVATE-QUESTION-5e2a',
    );
  });

  it('keeps the plan’s reason on the step, and none when the run has no plan', async () => {
    const catalog = createModelCatalog({ now: () => NOW });
    const anthropic = catalog.descriptors.find((row) => row.provider === 'anthropic')!;
    const gate = createSelectionGate({
      request: () => ({
        agentName: 'agent',
        catalogRevision: 1,
        policyRevision: 1,
        availabilitySnapshotRevision: 1,
      }),
      options: () => ({
        catalog: {
          revision: 1,
          descriptors: [anthropic],
          generatedAt: NOW,
          stale: false,
          projection: 'privileged',
        },
        now: () => NOW,
        newPlanId: () => 'plan-1',
      }),
    });
    gate.revalidate();

    const planned = await createActiveRun({
      generate: generate(),
      toolbox: createTestToolbox([lookup]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      selection: gate,
    }).result;
    const unplanned = await createActiveRun({
      generate: generate(),
      toolbox: createTestToolbox([lookup]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
    }).result;

    expect(planned.steps.map((step) => step.planReason?.code)).toEqual(['policy', 'policy']);
    expect(unplanned.steps.every((step) => !('planReason' in step))).toBe(true);
    expect(unplanned.steps.every((step) => !('effectiveContext' in step))).toBe(true);
  });
});

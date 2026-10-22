import { createTestToolbox, createTool } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';
import { z } from 'zod';

import { noToolCalls } from '../src/conditions/predicates';
import { createContextEpochSealer } from '../src/context-epoch';
import { createActiveRun } from '../src/create-run';
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
});

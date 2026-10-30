/**
 * COR-1872 — a durable run records each tool call's versioned id, and a call resumed after a
 * restart runs only that version: when the toolbox no longer holds it, recovery reports
 * `version-mismatch` for the call's approval and the tool never runs.
 */
import {
  createAgent,
  createCheckpointStore,
  createMockGenerate,
  stopWhen,
} from '@lostgradient/operative';
import { MemoryStorage, textValueStore } from '@lostgradient/storage';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { createTool, createToolbox, type Toolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import type { AgentDefinitions } from './agent-catalog';
import { createBureau, PinnedToolUnavailableError } from './index';
import type { BureauDiagnostic } from './types';
import { waitForTaskState } from './test';

const APPROVAL_SECRET = 'pinned-tool-secret';

function chargeToolbox(version: string, charges: string[]): Toolbox {
  return createToolbox(
    [
      createTool({
        namespace: 'billing',
        name: 'charge-card',
        version,
        description: 'Charge a payment card',
        input: z.object({ cents: z.number() }),
        async execute({ cents }) {
          charges.push(`${version}:${cents}`);
          return { charged: cents };
        },
      }),
    ],
    {
      approvalSecret: APPROVAL_SECRET,
      policy: {
        beforeExecute() {
          return {
            allow: false,
            status: 'needs_approval',
            reason: 'Operator approval required',
            action: { message: 'Approve charge' },
          };
        },
      },
    },
  ) as unknown as Toolbox;
}

describe('pinned tool calls', () => {
  it('records billing:charge-card@1.0.0 and reports version-mismatch when only 2.0.0 is loaded after a restart', async () => {
    const storage = new MemoryStorage();
    const charges: string[] = [];
    const bureauA = await createBureau<AgentDefinitions>({
      agents: {
        default: createAgent({
          generate: createMockGenerate([
            {
              content: '',
              toolCalls: [{ id: 'pinned-call', name: 'charge-card', arguments: { cents: 250 } }],
            },
          ]),
          toolbox: chargeToolbox('1.0.0', charges),
          stopWhen: stopWhen.toolOutcome('action_required'),
        }),
      },
      storage,
      durable: true,
    });
    const run = await bureauA.tasks.start('default', 'Charge the customer');
    await waitForTaskState(bureauA, run.id);
    await waitUntil(() => bureauA.reviews.list().length === 1);
    await bureauA.dispose();

    const steps = await createCheckpointStore(textValueStore(storage)).loadSteps(run.id);
    expect(steps.flatMap((step) => step.toolCalls)).toEqual([
      expect.objectContaining({
        id: 'pinned-call',
        name: 'charge-card',
        toolId: 'billing:charge-card@1.0.0',
      }),
    ]);

    const diagnostics: BureauDiagnostic[] = [];
    const bureauB = await createBureau<AgentDefinitions>({
      agents: {
        default: createAgent({
          generate: createMockGenerate([{ content: 'done', toolCalls: [] }]),
          toolbox: chargeToolbox('2.0.0', charges),
          stopWhen: stopWhen.noToolCalls(),
        }),
      },
      storage,
      durable: true,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    try {
      const recovery = diagnostics.find((diagnostic) => diagnostic.scope === 'approval-recovery');
      expect(recovery?.message).toContain('version-mismatch: billing:charge-card@1.0.0');
      expect(recovery?.cause).toBeInstanceOf(PinnedToolUnavailableError);
      expect(recovery?.cause).toMatchObject({
        code: 'CONFLICT',
        reason: 'version-mismatch',
        toolId: 'billing:charge-card@1.0.0',
        candidates: ['billing:charge-card@2.0.0'],
      });
      expect(bureauB.reviews.list()).toEqual([]);
      expect(charges).toEqual([]);
    } finally {
      await bureauB.dispose();
    }
  });
});

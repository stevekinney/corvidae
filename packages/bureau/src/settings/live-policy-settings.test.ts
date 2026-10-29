/**
 * COR-1710 — `modelPolicy`, `decisions.*`, and `children.delegation.defaultTimeToLiveMilliseconds`
 * are read by the next plan, decision, task, or dispatch, not fixed when the Bureau was built.
 * Every Bureau here runs on a manual clock.
 */
import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import {
  type BackendDescriptor,
  createAgent,
  createMockGenerate,
  createModelCatalog,
  type DecisionModel,
  type GenerateContext,
  type GenerateFunction,
  stopWhen,
  withBackendDescriptors,
} from '@lostgradient/operative';
import { createToolbox } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';

import type { AgentDefinitions } from '../agent-catalog.ts';
import { createBureau } from '../create-bureau.ts';
import { runTask } from '../test/index.ts';
import type { Bureau, BureauOptions } from '../types.ts';
import { MemoryStorage } from '@lostgradient/storage';

const ORIGIN = '2026-10-13T00:00:00.000Z';

const bureaus: Bureau<AgentDefinitions>[] = [];
afterEach(async () => {
  for (const bureau of bureaus.splice(0)) await bureau.dispose();
});

async function open(
  options: Partial<BureauOptions<AgentDefinitions>> = {},
): Promise<Bureau<AgentDefinitions>> {
  const bureau = await createBureau<AgentDefinitions>({
    agents: {
      default: createAgent({
        generate: async () => ({ content: 'done', toolCalls: [] }),
        toolbox: createToolbox([]),
        stopWhen: stopWhen.noToolCalls(),
      }),
    },
    runtime: createManualRuntimeServices({ origin: ORIGIN }),
    storage: new MemoryStorage(),
    durable: true,
    ...options,
  });
  bureaus.push(bureau);
  return bureau;
}

async function change(bureau: Bureau<AgentDefinitions>, patch: Record<string, unknown>) {
  const { revision } = await bureau.settings.get();
  expect(await bureau.settings.update(patch, { expectedRevision: revision })).toMatchObject({
    outcome: 'applied',
  });
}

const anthropicDescriptor = createModelCatalog().descriptors.find(
  (row) => row.provider === 'anthropic',
)!;

/** An agent pinned to an Anthropic model, so a plan for it names that provider. */
const pinned = () =>
  createAgent({
    generate: withBackendDescriptors(createMockGenerate([]), [anthropicDescriptor]),
    name: 'pinned',
  });

describe('modelPolicy', () => {
  it('the next plan is stamped with the new policy revision and judged under its invariants', async () => {
    const bureau = await open({ agents: { pinned: pinned() } });
    const before = bureau.models.plan({ agentName: 'pinned' });
    expect(before).toMatchObject({ outcome: 'selected', policyRevision: 0 });

    await change(bureau, {
      modelPolicy: { policyRevision: 7, deployment: { deniedProviders: ['anthropic'] } },
    });

    const after = bureau.models.plan({ agentName: 'pinned' });
    expect(after.policyRevision).toBe(7);
    expect(after.outcome).not.toBe('selected');
  });

  it('the next plan applies a user profile added after the Bureau was built', async () => {
    const bureau = await open({
      agents: { pinned: pinned() },
      modelPolicy: { policyRevision: 1 },
    });
    expect(bureau.models.plan({ agentName: 'pinned', principal: 'bob' }).outcome).toBe('selected');

    await change(bureau, {
      modelPolicy: { policyRevision: 2, users: { bob: { deniedProviders: ['anthropic'] } } },
    });

    expect(bureau.models.plan({ agentName: 'pinned', principal: 'bob' }).outcome).not.toBe(
      'selected',
    );
    expect(bureau.models.plan({ agentName: 'pinned', principal: 'carol' }).outcome).toBe(
      'selected',
    );
  });
});

const seed = createModelCatalog().descriptors.find((row) => row.model === 'claude-haiku-5-5')!;

function row(provider: BackendDescriptor['provider'], model: string): BackendDescriptor {
  return { ...seed, provider, model, aliases: [] };
}

describe('decisions.fallbackModel', () => {
  it('the next decide runs on the new row', async () => {
    const generated: BackendDescriptor[] = [];
    const generate = createMockGenerate([
      { content: '{"answer":true}', toolCalls: [] },
      { content: '{"answer":true}', toolCalls: [] },
    ]);
    const bureau = await open({
      models: {
        catalog: [row('anthropic', 'first'), row('openai', 'second')],
        generate: (descriptor: BackendDescriptor): GenerateFunction => {
          generated.push(descriptor);
          return generate;
        },
      },
      decisions: { fallbackModel: 'anthropic/first' },
    });
    await bureau.decisions.decide({ kind: 'boolean', question: 'Is it?' });
    expect(generated.map((descriptor) => descriptor.model)).toEqual(['first']);

    await change(bureau, { 'decisions.fallbackModel': 'openai/second' });
    await bureau.decisions.decide({ kind: 'boolean', question: 'Is it?' });
    expect(generated.map((descriptor) => descriptor.model)).toEqual(['first', 'second']);
  });
});

describe('decisions.maximumPerTask', () => {
  it('the next task is capped at the new count', async () => {
    const asked: string[] = [];
    const model: DecisionModel = {
      name: 'scripted/model',
      kinds: new Set(['boolean']),
      decide: async (request) => {
        asked.push(request.question);
        return { value: true, provider: 'scripted', model: 'model' };
      },
    };
    const results: unknown[] = [];
    const generate: GenerateFunction = async (context: GenerateContext) => {
      if (context.step > 0) {
        results.push(context.conversation.getMessages().at(-1)?.toolResult?.content);
      }
      if (context.step >= 3) return { content: 'done', toolCalls: [] };
      return {
        content: '',
        toolCalls: [
          {
            id: `call-${context.step}`,
            name: 'decide',
            arguments: { kind: 'boolean', question: `Question ${context.step}?` },
          },
        ],
      };
    };
    const bureau = await open({
      agents: {
        worker: createAgent({
          generate,
          toolbox: createToolbox([]),
          stopWhen: stopWhen.noToolCalls(),
        }),
      },
      decisions: { model, maximumPerTask: 3 },
    });

    await runTask(bureau, 'worker', 'first');
    expect(asked).toHaveLength(3);

    asked.length = 0;
    results.length = 0;
    await change(bureau, { 'decisions.maximumPerTask': 1 });
    await runTask(bureau, 'worker', 'second');
    expect(asked).toEqual(['Question 0?']);
    expect(JSON.stringify(results[1])).toContain('"refusal":"maximum-per-task"');
  });
});

describe('children.delegation.defaultTimeToLiveMilliseconds', () => {
  it('the next dispatch issues a grant that lives the new time', async () => {
    const runtime = createManualRuntimeServices({ origin: ORIGIN });
    const bureau = await open({
      runtime,
      agents: {
        default: createAgent({
          generate: () => new Promise<never>(() => {}),
          toolbox: createToolbox([]),
        }),
        worker: createAgent({
          name: 'worker',
          generate: () => new Promise<never>(() => {}),
          toolbox: createToolbox([]),
          stopWhen: stopWhen.noToolCalls(),
        }),
      },
      children: { delegation: { secret: 'children-secret', defaultTimeToLiveMilliseconds: 1_000 } },
    });
    const parent = await bureau.tasks.start('default', 'plan');
    const grantLifetime = async (childRunId: string): Promise<number | undefined> => {
      const dispatched = await bureau.children.dispatch({
        parentRunId: parent.id,
        agentName: 'worker',
        input: 'work',
        childRunId,
      });
      if (dispatched.outcome !== 'started') throw new Error('expected a started child');
      return dispatched.grant === undefined
        ? undefined
        : dispatched.grant.expiresAt - runtime.clock.now();
    };

    expect(await grantLifetime('child-before')).toBe(1_000);

    await change(bureau, { 'children.delegation.defaultTimeToLiveMilliseconds': 60_000 });
    expect(await grantLifetime('child-after')).toBe(60_000);
  });
});

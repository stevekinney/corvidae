/**
 * COR-1996 — the model policy binds the language-model fallback of `bureau.decisions`. A row the
 * deployment or the Bureau forbids is skipped when the fallback is chosen; a decision is refused
 * with a `ModelPolicyDeniedError`, before any provider is called, only when the policy leaves no
 * row. The policy is read at each decision, so a change applies to the next one.
 */
import {
  type BackendDescriptor,
  createMockGenerate,
  createModelCatalog,
  type GenerateFunction,
} from '@lostgradient/operative';
import { MemoryStorage } from '@lostgradient/storage';
import { afterEach, describe, expect, it } from 'bun:test';

import { createBureau } from '../create-bureau.ts';
import { ModelPolicyDeniedError } from '../file-agent-generate.ts';
import type { BureauModelPolicyOptions } from '../model-policy.ts';
import type { Bureau } from '../types.ts';

const bureaus: Bureau[] = [];
afterEach(async () => {
  for (const bureau of bureaus.splice(0)) await bureau.dispose();
});

const seed = createModelCatalog().descriptors.find((row) => row.model === 'claude-haiku-5-5')!;

function row(
  provider: BackendDescriptor['provider'],
  model: string,
  pricing: readonly [number, number],
): BackendDescriptor {
  return {
    ...seed,
    provider,
    model,
    aliases: [],
    availability: 'available',
    pricing: {
      inputPerMillionTokens: pricing[0],
      outputPerMillionTokens: pricing[1],
      currency: 'USD',
    },
  };
}

const PREFERRED = row('anthropic', 'preferred', [0.1, 0.5]);
const CHEAPER = row('openai', 'cheaper', [0.01, 0.01]);
const DEAR = row('openai', 'dear', [5, 5]);

async function open(
  catalog: readonly BackendDescriptor[],
  modelPolicy: BureauModelPolicyOptions | undefined,
) {
  const generated: BackendDescriptor[] = [];
  let calls = 0;
  const reply = createMockGenerate(
    Array.from({ length: 4 }, () => ({ content: '{"answer":true}', toolCalls: [] })),
  );
  const bureau = await createBureau({
    storage: new MemoryStorage(),
    durable: true,
    ...(modelPolicy === undefined ? {} : { modelPolicy }),
    models: {
      catalog,
      generate: (descriptor: BackendDescriptor): GenerateFunction => {
        generated.push(descriptor);
        return (context) => {
          calls += 1;
          return reply(context);
        };
      },
    },
    decisions: { fallbackModel: 'anthropic/preferred' },
  });
  bureaus.push(bureau);
  return { bureau, generated, calls: () => calls };
}

const BOOLEAN = { kind: 'boolean', question: 'Is it?' } as const;

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

describe('the decision fallback under a model policy', () => {
  it('skips a forbidden preferred row and answers with the cheapest row the policy allows', async () => {
    const { bureau, generated } = await open([PREFERRED, DEAR, CHEAPER], {
      deployment: { deniedModels: ['preferred', 'cheaper'] },
      policyRevision: 2,
    });

    await bureau.decisions.decide(BOOLEAN);

    expect(generated.map((descriptor) => descriptor.model)).toEqual(['dear']);
  });

  it('still uses the preferred row when the policy forbids only another', async () => {
    const { bureau, generated } = await open([PREFERRED, CHEAPER], {
      bureau: { deniedModels: ['cheaper'] },
      policyRevision: 2,
    });

    await bureau.decisions.decide(BOOLEAN);

    expect(generated.map((descriptor) => descriptor.model)).toEqual(['preferred']);
  });

  it('refuses with a ModelPolicyDeniedError naming the row and calls no provider when the policy leaves none', async () => {
    const { bureau, generated, calls } = await open([PREFERRED, CHEAPER], {
      deployment: { deniedModels: ['preferred', 'cheaper'] },
      policyRevision: 7,
    });

    const failure = await rejection(bureau.decisions.decide(BOOLEAN));

    expect(failure).toBeInstanceOf(ModelPolicyDeniedError);
    expect(failure).toMatchObject({
      provider: 'anthropic',
      model: 'preferred',
      layer: 'deployment',
      policyRevision: 7,
    });
    expect(generated).toEqual([]);
    expect(calls()).toBe(0);
  });

  it('reads the policy at each decision', async () => {
    const { bureau, generated } = await open([PREFERRED, CHEAPER], undefined);

    await bureau.decisions.decide(BOOLEAN);
    const { revision } = await bureau.settings.get();
    const applied = await bureau.settings.update(
      { modelPolicy: { deployment: { deniedModels: ['preferred'] }, policyRevision: 2 } },
      { expectedRevision: revision },
    );
    expect(applied.outcome).toBe('applied');
    await bureau.decisions.decide(BOOLEAN);

    expect(generated.map((descriptor) => descriptor.model)).toEqual(['preferred', 'cheaper']);
  });
});

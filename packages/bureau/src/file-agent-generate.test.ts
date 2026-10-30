/**
 * COR-1559 — the generate a file agent runs with picks its model for every step from that step's
 * steering alone: no earlier step's override, no session lookup, and never the default when the
 * model it was told to use cannot be used.
 */
import {
  type BackendDescriptor,
  BudgetExceededError,
  createModelCatalog,
  type GenerateContext,
  type GenerateFunction,
  readBackendDescriptors,
  withBackendDescriptors,
} from '@lostgradient/operative';
import { describe, expect, it } from 'bun:test';

import { createFileAgentGenerate, ModelOverrideUnusableError } from './file-agent-generate';

const rows = createModelCatalog().descriptors;
const row = (provider: string, model: string): BackendDescriptor => {
  const found = rows.find(
    (candidate) => candidate.provider === provider && candidate.model === model,
  );
  if (found === undefined) throw new Error(`The catalog has no ${provider}/${model}.`);
  return found;
};

const DEFAULT = row('anthropic', 'claude-opus-5-5');
const OPUS_5 = row('anthropic', 'claude-opus-5');
const GPT = row('openai', 'gpt-4.1');

/** A step's context carrying only the steering a test names. */
function step(steering?: { model?: string; modelProvider?: string; provider?: string }) {
  return (steering === undefined
    ? {}
    : { steering: { paused: false, configVersion: 1, ...steering } }) as unknown as GenerateContext;
}

function harness(allowed: BackendDescriptor[], resolveFailsFor?: string, costBudgeted = false) {
  const used: string[] = [];
  const resolved: string[] = [];
  const generateFor =
    (descriptor: BackendDescriptor): GenerateFunction =>
    async () => {
      used.push(`${descriptor.provider}/${descriptor.model}`);
      return { content: descriptor.model, toolCalls: [] };
    };
  const generate = createFileAgentGenerate({
    defaultDescriptor: DEFAULT,
    defaultGenerate: withBackendDescriptors(generateFor(DEFAULT), [DEFAULT]),
    allowed: () => allowed,
    costBudgeted,
    resolveGenerate: (descriptor) => {
      if (descriptor.model === resolveFailsFor) throw new Error('no credentials');
      resolved.push(descriptor.model);
      return generateFor(descriptor);
    },
  });
  return { generate, used, resolved };
}

describe('a file agent’s generate', () => {
  it('uses the default model when a step carries no model steering', async () => {
    const { generate, used } = harness([DEFAULT, OPUS_5]);

    await generate(step());
    await generate(step({ provider: 'openai' }));

    expect(used).toEqual(['anthropic/claude-opus-5-5', 'anthropic/claude-opus-5-5']);
  });

  it('uses the model each step’s own steering names, not an earlier or later step’s', async () => {
    const { generate, used } = harness([DEFAULT, OPUS_5, GPT]);

    await generate(step({ model: 'gpt-4.1', modelProvider: 'openai' }));
    await generate(step());
    await generate(step({ model: 'claude-opus-5' }));
    await generate(step({ model: 'gpt-4.1' }));

    expect(used).toEqual([
      'openai/gpt-4.1',
      'anthropic/claude-opus-5-5',
      'anthropic/claude-opus-5',
      'openai/gpt-4.1',
    ]);
  });

  it('matches the provider as well as the model when the steering names one', async () => {
    const twin: BackendDescriptor = { ...DEFAULT, provider: 'openai' };
    const { generate, used } = harness([DEFAULT, twin]);

    await generate(step({ model: 'claude-opus-5-5', modelProvider: 'openai' }));

    expect(used).toEqual(['openai/claude-opus-5-5']);
  });

  it('resolves a model’s generate once and reuses it', async () => {
    const { generate, resolved } = harness([DEFAULT, OPUS_5]);

    await generate(step({ model: 'claude-opus-5' }));
    await generate(step({ model: 'claude-opus-5' }));

    expect(resolved).toEqual(['claude-opus-5']);
  });

  it('does not resolve the default again when a step names it', async () => {
    const { generate, resolved, used } = harness([DEFAULT, OPUS_5]);

    await generate(step({ model: 'claude-opus-5-5', modelProvider: 'anthropic' }));

    expect(resolved).toEqual([]);
    expect(used).toEqual(['anthropic/claude-opus-5-5']);
  });

  it('fails with a typed error naming the model when it is no longer allowed, and calls nothing', async () => {
    const { generate, used } = harness([DEFAULT]);

    const failure = await generate(step({ model: 'gpt-4.1', modelProvider: 'openai' })).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(ModelOverrideUnusableError);
    expect((failure as ModelOverrideUnusableError).model).toBe('gpt-4.1');
    expect((failure as ModelOverrideUnusableError).provider).toBe('openai');
    expect((failure as ModelOverrideUnusableError).message).toContain('gpt-4.1');
    expect(used).toEqual([]);
  });

  it('ends a budgeted run before asking an unpriced row that a provider-less switch to the default name reaches', async () => {
    // The probe: an unpriced twin ahead of the default serves the default's own model name, so the
    // run's name-keyed pricing counts the step at the default's rate while the twin runs it.
    const twin: BackendDescriptor = { ...DEFAULT, provider: 'twin', pricing: undefined };
    const { generate, used } = harness([twin, DEFAULT], undefined, true);

    const failure = await generate(step({ model: DEFAULT.model })).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(BudgetExceededError);
    expect((failure as Error).message).toContain('"twin"');
    expect((failure as Error).message).toContain(DEFAULT.model);
    expect(used).toEqual([]);
  });

  it('runs the same unpriced row when the agent has no budget', async () => {
    const twin: BackendDescriptor = { ...DEFAULT, provider: 'twin', pricing: undefined };
    const { generate, used } = harness([twin, DEFAULT]);

    await generate(step({ model: DEFAULT.model }));

    expect(used).toEqual(['twin/claude-opus-5-5']);
  });

  it('fails with a typed error naming the model when the resolver now throws for it', async () => {
    const { generate, used } = harness([DEFAULT, OPUS_5], 'claude-opus-5');

    const failure = await generate(step({ model: 'claude-opus-5' })).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(ModelOverrideUnusableError);
    expect((failure as ModelOverrideUnusableError).message).toContain('claude-opus-5');
    expect((failure as ModelOverrideUnusableError).cause).toBeInstanceOf(Error);
    expect(used).toEqual([]);
  });

  it('keeps the default model’s descriptors, so the agent reads as the one it was', () => {
    const { generate } = harness([DEFAULT]);

    expect(readBackendDescriptors(generate).map((descriptor) => descriptor.model)).toEqual([
      'claude-opus-5-5',
    ]);
  });
});

/**
 * COR-1709 — `bureau.decisions.decide`: which model answers a kind, how the language-model
 * fallback is chosen from the catalog, and what the `decision.made` audit record holds.
 */
import { sha256HexSync } from '@lostgradient/cryptography';
import {
  type BackendDescriptor,
  createMockGenerate,
  createModelCatalog,
  type DecisionKind,
  type DecisionModel,
  DecisionSchemaError,
  type GenerateFunction,
} from '@lostgradient/operative';
import { afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { canonicalJson } from '../command-ledger.ts';
import { BureauError, createBureau } from '../create-bureau.ts';
import type { Bureau, BureauOptions } from '../types.ts';
import { MemoryStorage } from '@lostgradient/storage';

const bureaus: Bureau[] = [];
afterEach(async () => {
  for (const bureau of bureaus.splice(0)) await bureau.dispose();
});

const seed = createModelCatalog().descriptors.find((row) => row.model === 'claude-haiku-5-5')!;

/** A catalog row that differs from the seed in what a test varies. */
function row(
  provider: BackendDescriptor['provider'],
  model: string,
  overrides: Partial<Pick<BackendDescriptor, 'availability' | 'structuredOutput' | 'pricing'>> = {},
  pricing?: readonly [number, number],
): BackendDescriptor {
  return {
    ...seed,
    provider,
    model,
    aliases: [],
    ...overrides,
    ...(pricing === undefined
      ? {}
      : {
          pricing: {
            inputPerMillionTokens: pricing[0],
            outputPerMillionTokens: pricing[1],
            currency: 'USD',
          },
        }),
  };
}

type Opened = {
  readonly bureau: Bureau;
  /** The catalog rows `models.generate` was asked to set up, in order. */
  readonly generated: BackendDescriptor[];
  readonly generate: ReturnType<typeof createMockGenerate>;
};

async function open(
  options: {
    readonly catalog?: readonly BackendDescriptor[];
    readonly replies?: readonly string[];
    readonly withoutGenerate?: boolean;
    readonly throwsFor?: string;
    readonly decisions?: BureauOptions['decisions'];
  } = {},
): Promise<Opened> {
  const generated: BackendDescriptor[] = [];
  const generate = createMockGenerate(
    (options.replies ?? ['{"answer":true}']).map((content) => ({ content, toolCalls: [] })),
  );
  const bureau = await createBureau({
    storage: new MemoryStorage(),
    durable: true,
    models: {
      ...(options.catalog === undefined ? {} : { catalog: options.catalog }),
      ...(options.withoutGenerate === true
        ? {}
        : {
            generate: (descriptor: BackendDescriptor): GenerateFunction => {
              if (descriptor.model === options.throwsFor) throw new Error('no credentials');
              generated.push(descriptor);
              return generate;
            },
          }),
    },
    ...(options.decisions === undefined ? {} : { decisions: options.decisions }),
  });
  bureaus.push(bureau);
  return { bureau, generated, generate };
}

function hostModel(kinds: readonly DecisionKind[]): DecisionModel & { readonly asked: string[] } {
  const asked: string[] = [];
  return {
    name: 'host/model',
    kinds: new Set(kinds),
    asked,
    decide: async (request) => {
      asked.push(request.kind);
      return { value: request.kind === 'boolean' ? false : 'a', provider: 'host', model: 'model' };
    },
  };
}

const CHOICE = {
  kind: 'choice',
  question: 'Which?',
  options: [
    { key: 'a', label: 'The first' },
    { key: 'b', label: 'The second' },
  ],
} as const;

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

describe('routing a decision by kind', () => {
  it('sends a kind the configured model serves to that model and nothing else', async () => {
    const model = hostModel(['boolean']);
    const { bureau, generate } = await open({ decisions: { model } });

    const decision = await bureau.decisions.decide({ kind: 'boolean', question: 'Is it?' });

    expect(decision).toMatchObject({ value: false, provider: 'host' });
    expect(model.asked).toEqual(['boolean']);
    expect(generate.callCount).toBe(0);
  });

  it('sends a kind absent from the configured model’s kinds to the fallback', async () => {
    const model = hostModel(['boolean']);
    const { bureau, generated } = await open({
      decisions: { model },
      replies: ['{"key":"b"}'],
    });

    const decision = await bureau.decisions.decide(CHOICE);

    expect(decision).toMatchObject({
      value: 'b',
      provider: 'anthropic',
      model: 'claude-haiku-5-5',
    });
    expect(model.asked).toEqual([]);
    expect(generated.map((descriptor) => descriptor.model)).toEqual(['claude-haiku-5-5']);
  });

  it('answers a boolean, a choice, a scale, and a structured request from the fallback', async () => {
    const { bureau } = await open({
      replies: ['{"answer":true}', '{"key":"a"}', '{"level":2}', '{"name":"x"}'],
    });

    const boolean = await bureau.decisions.decide({ kind: 'boolean', question: 'Is it?' });
    const choice = await bureau.decisions.decide(CHOICE);
    const scale = await bureau.decisions.decide({
      kind: 'scale',
      question: 'How?',
      levels: ['no', 'a bit', 'yes'],
    });
    expect([boolean.value, choice.value, scale.value]).toEqual([true, 'a', 2]);
    const structured = await bureau.decisions.decide({
      kind: 'structured',
      question: 'Name it',
      schema: z.object({ name: z.string() }),
    });
    expect(structured.value).toEqual({ name: 'x' });
  });
});

describe('choosing the fallback row', () => {
  it('uses the configured fallbackModel when it is eligible, priced or not', async () => {
    const catalog = [
      row('anthropic', 'cheap', {}, [0.01, 0.01]),
      row('openai', 'chosen', { pricing: undefined }),
    ];
    const { bureau, generated } = await open({
      catalog,
      decisions: { fallbackModel: 'openai/chosen' },
    });

    await bureau.decisions.decide({ kind: 'boolean', question: 'Is it?' });

    expect(generated.map((descriptor) => descriptor.model)).toEqual(['chosen']);
  });

  it('falls to the cheapest eligible row when the preferred row is unavailable', async () => {
    const catalog = [
      row('anthropic', 'claude-haiku-5-5', { availability: 'unavailable' }, [0.1, 0.5]),
      row('openai', 'unpriced', { pricing: undefined }),
      row('openai', 'no-structured-output', { structuredOutput: false }, [0.01, 0.01]),
      row('openai', 'unavailable-cheap', { availability: 'unavailable' }, [0.01, 0.01]),
      row('openai', 'dear', {}, [5, 5]),
      row('gemini', 'cheaper-output', { availability: 'unknown' }, [1, 2]),
      row('gemini', 'cheapest-input', {}, [1, 3]),
    ];
    const { bureau, generated } = await open({ catalog });

    await bureau.decisions.decide({ kind: 'boolean', question: 'Is it?' });

    // Input price ties between the last two; the lower output price wins.
    expect(generated.map((descriptor) => descriptor.model)).toEqual(['cheaper-output']);
  });

  it('breaks a full price tie by catalog order', async () => {
    const catalog = [
      row('openai', 'second-in-name-first-in-order', {}, [1, 1]),
      row('openai', 'first-in-name', {}, [1, 1]),
    ];
    const { bureau, generated } = await open({ catalog });

    await bureau.decisions.decide({ kind: 'boolean', question: 'Is it?' });

    expect(generated.map((descriptor) => descriptor.model)).toEqual([
      'second-in-name-first-in-order',
    ]);
  });

  it('falls to the cheapest row when the preferred row has no structured output', async () => {
    const catalog = [
      row('anthropic', 'claude-haiku-5-5', { structuredOutput: false }, [0.1, 0.5]),
      row('openai', 'other', {}, [2, 2]),
    ];
    const { bureau, generated } = await open({ catalog });

    await bureau.decisions.decide({ kind: 'boolean', question: 'Is it?' });

    expect(generated.map((descriptor) => descriptor.model)).toEqual(['other']);
  });
});

describe('a decision nothing can answer', () => {
  async function notConfigured(promise: Promise<unknown>): Promise<BureauError> {
    const error = await rejection(promise);
    expect(error).toBeInstanceOf(BureauError);
    expect((error as BureauError).code).toBe('NOT_CONFIGURED');
    expect((error as BureauError).subject).toBe('generate');
    return error as BureauError;
  }

  it('rejects NOT_CONFIGURED when no catalog row is eligible', async () => {
    const catalog = [
      row('openai', 'unavailable', { availability: 'unavailable' }, [1, 1]),
      row('openai', 'unpriced', { pricing: undefined }),
    ];
    const { bureau, generate } = await open({ catalog });

    await notConfigured(bureau.decisions.decide({ kind: 'boolean', question: 'Is it?' }));
    expect(generate.callCount).toBe(0);
  });

  it('rejects NOT_CONFIGURED when models.generate is absent', async () => {
    const { bureau } = await open({ withoutGenerate: true });

    await notConfigured(bureau.decisions.decide({ kind: 'boolean', question: 'Is it?' }));
  });

  it('rejects NOT_CONFIGURED when models.generate throws for the chosen row', async () => {
    const { bureau } = await open({ throwsFor: 'claude-haiku-5-5' });

    await notConfigured(bureau.decisions.decide({ kind: 'boolean', question: 'Is it?' }));
  });

  it('still answers a kind the configured model serves when the fallback cannot', async () => {
    const { bureau } = await open({
      withoutGenerate: true,
      decisions: { model: hostModel(['boolean']) },
    });

    const served = await bureau.decisions.decide({ kind: 'boolean', question: 'Is it?' });
    expect(served.value).toBe(false);
    await notConfigured(bureau.decisions.decide(CHOICE));
  });
});

describe('a request or an answer that is not valid', () => {
  it('rejects a malformed request as BAD_REQUEST before any model is asked', async () => {
    const { bureau, generate } = await open();

    const error = await rejection(
      bureau.decisions.decide({ kind: 'choice', question: 'Which?', options: [] }),
    );

    expect(error).toBeInstanceOf(BureauError);
    expect((error as BureauError).code).toBe('BAD_REQUEST');
    expect(generate.callCount).toBe(0);
  });

  it('propagates DecisionSchemaError when the answer fails twice', async () => {
    const { bureau, generate } = await open({ replies: ['nonsense', 'still nonsense'] });

    const error = await rejection(bureau.decisions.decide({ kind: 'boolean', question: 'Is it?' }));

    expect(error).toBeInstanceOf(DecisionSchemaError);
    expect(generate.callCount).toBe(2);
  });

  it('rejects a bad decisions option at construction', async () => {
    for (const decisions of [
      { maximumPerTask: 0 },
      { fallbackModel: 'no-slash' },
      { model: {} },
    ] as never[]) {
      const error = await rejection(createBureau({ storage: new MemoryStorage(), decisions }));
      expect((error as BureauError).code).toBe('BAD_REQUEST');
    }
    const error = await rejection(
      createBureau({ storage: new MemoryStorage(), decide: true as never }),
    );
    expect((error as BureauError).code).toBe('BAD_REQUEST');
  });
});

describe('the decision.made audit record', () => {
  const CONTEXT = 'CONTEXT-SENTINEL-5c1e';
  const VALUE = 'VALUE-SENTINEL-93ab';

  it('names kind, provider, model, principal and the schema digest, and never context or value', async () => {
    const { bureau } = await open({ replies: [JSON.stringify({ verdict: VALUE })] });
    const schema = z.object({ verdict: z.string() });

    const decision = await bureau.decisions.decide(
      { kind: 'structured', question: 'Verdict?', context: CONTEXT, schema },
      { principal: 'api-key:alice' },
    );
    expect(decision.value).toEqual({ verdict: VALUE });

    const records = (await bureau.internals.auditTrail?.query({ type: 'decision.made' })) ?? [];
    expect(records).toHaveLength(1);
    const [record] = records;
    expect(record).toMatchObject({
      type: 'decision.made',
      principal: 'api-key:alice',
      detail: {
        kind: 'structured',
        provider: 'anthropic',
        model: 'claude-haiku-5-5',
        schemaSha256: sha256HexSync(canonicalJson(z.toJSONSchema(schema, { io: 'input' }))),
      },
    });
    const stored = JSON.stringify(record);
    expect(stored).not.toContain(CONTEXT);
    expect(stored).not.toContain(VALUE);
    expect(stored).not.toContain('Verdict?');
    expect(Object.keys(record!.detail as object).toSorted()).toEqual([
      'kind',
      'model',
      'provider',
      'schemaSha256',
    ]);

    // The served, redacted view keeps the same four fields.
    const served = await bureau.audit.query({ type: 'decision.made' });
    expect(served.records[0]?.detail).toMatchObject({
      kind: 'structured',
      model: 'claude-haiku-5-5',
    });
    expect(JSON.stringify(served)).not.toContain(CONTEXT);
  });

  it('carries no schema digest for a typed kind, and files the record under the task when given one', async () => {
    const { bureau } = await open();

    await bureau.decisions.decide({ kind: 'boolean', question: 'Is it?' }, { taskId: 'task-9' });

    const [record] = (await bureau.internals.auditTrail?.query({ runId: 'task-9' })) ?? [];
    expect(record?.type).toBe('decision.made');
    expect(record?.detail).toEqual({
      kind: 'boolean',
      provider: 'anthropic',
      model: 'claude-haiku-5-5',
    });
  });

  it('writes no record when the decision fails', async () => {
    const { bureau } = await open({ replies: ['x', 'y'] });

    await rejection(bureau.decisions.decide({ kind: 'boolean', question: 'Is it?' }));

    expect(await bureau.internals.auditTrail?.query({ type: 'decision.made' })).toEqual([]);
  });
});

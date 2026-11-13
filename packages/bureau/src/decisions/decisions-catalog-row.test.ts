/**
 * COR-2154 — `decisions.model` names a catalog row (`<provider>/<model>`). A request goes native
 * when the row declares its kind, through the row's `generate` when it has structured output, and
 * to `decisions.fallbackModel` otherwise. An absent or unavailable row counts as absent, so the
 * fallback answers; a real provider error rejects, and the model policy judges the chosen row.
 */
import {
  type BackendDescriptor,
  createMockGenerate,
  createModelCatalog,
  type DecisionKind,
  type DecisionModel,
  type GenerateFunction,
} from '@lostgradient/operative';
import { MemoryStorage } from '@lostgradient/storage';
import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import type { Bureau } from '../bureau-types/facade.ts';
import { createBureau } from '../create-bureau.ts';
import { ModelPolicyDeniedError } from '../file-agent-generate.ts';
import type { BureauModelPolicyOptions } from '../model-policy.ts';

const bureaus: Bureau[] = [];
afterEach(async () => {
  for (const bureau of bureaus.splice(0)) await bureau.dispose();
});

const seed = createModelCatalog().descriptors.find((row) => row.model === 'claude-haiku-5-5')!;

/** The row the fallback uses: it is priced, available, and structured. */
const FALLBACK_ROW: BackendDescriptor = {
  ...seed,
  provider: 'anthropic',
  model: 'claude-haiku-5-5',
  aliases: [],
  availability: 'available',
  structuredOutput: true,
};

function chosenRow(
  overrides: Partial<BackendDescriptor> & { readonly decisionKinds?: readonly DecisionKind[] } = {},
): BackendDescriptor {
  const { decisionKinds, ...rest } = overrides;
  return {
    ...seed,
    provider: 'typesafe',
    model: 'jev',
    aliases: [],
    availability: 'available',
    structuredOutput: false,
    ...(decisionKinds === undefined ? {} : { decisions: { kinds: decisionKinds, only: true } }),
    ...rest,
  };
}

/** The catalog stamps and freezes the rows it is given, so a row is compared by its name. */
const named = (rows: readonly BackendDescriptor[]): string[] =>
  rows.map((row) => `${row.provider}/${row.model}`);

type Opened = {
  readonly bureau: Bureau;
  /** The rows the fallback and adapter `generate` was asked to set up, in order. */
  readonly generated: BackendDescriptor[];
  /** The rows `models.decide` was asked to set up, in order. */
  readonly decided: BackendDescriptor[];
  /** The kinds the native model answered, in order. */
  readonly nativeAsked: string[];
};

async function open(
  options: {
    readonly catalog: readonly BackendDescriptor[];
    readonly model?: string;
    readonly nativeError?: Error;
    readonly withoutDecide?: boolean;
    readonly modelPolicy?: BureauModelPolicyOptions;
  } = { catalog: [] },
): Promise<Opened> {
  const generated: BackendDescriptor[] = [];
  const decided: BackendDescriptor[] = [];
  const nativeAsked: string[] = [];
  const generate = createMockGenerate(
    Array.from({ length: 6 }, () => ({ content: '{"answer":true}', toolCalls: [] })),
  );
  const bureau = await createBureau({
    storage: new MemoryStorage(),
    durable: true,
    models: {
      catalog: options.catalog,
      generate: (row): GenerateFunction => {
        generated.push(row);
        return generate;
      },
      ...(options.withoutDecide === true
        ? {}
        : {
            decide: (row: BackendDescriptor): DecisionModel => {
              decided.push(row);
              return {
                name: `${row.provider}/${row.model}`,
                kinds: new Set(row.decisions?.kinds ?? []),
                decide: async (request) => {
                  nativeAsked.push(request.kind);
                  if (options.nativeError !== undefined) throw options.nativeError;
                  return { value: true, provider: row.provider, model: row.model };
                },
              };
            },
          }),
    },
    ...(options.modelPolicy === undefined ? {} : { modelPolicy: options.modelPolicy }),
    decisions: options.model === undefined ? {} : { model: options.model },
  });
  bureaus.push(bureau);
  return { bureau, generated, decided, nativeAsked };
}

describe('answering with the row decisions.model names', () => {
  it('answers a kind the row declares natively, and never builds its generate', async () => {
    const row = chosenRow({ decisionKinds: ['boolean'] });
    const { bureau, generated, decided, nativeAsked } = await open({
      catalog: [FALLBACK_ROW, row],
      model: 'typesafe/jev',
    });

    const decision = await bureau.decisions.decide({ kind: 'boolean', question: 'Is it?' });

    expect(decision).toMatchObject({ value: true, provider: 'typesafe', model: 'jev' });
    expect(named(decided)).toEqual(['typesafe/jev']);
    expect(nativeAsked).toEqual(['boolean']);
    expect(generated).toEqual([]);
  });

  it('answers a structured request through the row’s generate when it has structured output and does not declare the kind', async () => {
    const row = chosenRow({ decisionKinds: ['boolean'], structuredOutput: true });
    const { bureau, generated, decided } = await open({
      catalog: [FALLBACK_ROW, row],
      model: 'typesafe/jev',
    });

    const decision = await bureau.decisions.decide({
      kind: 'structured',
      question: 'Name it',
      schema: z.object({ answer: z.boolean() }),
    });

    expect(decision.value).toEqual({ answer: true });
    expect(named(generated)).toEqual(['typesafe/jev']);
    expect(decided).toEqual([]);
  });

  it('answers with the fallback when the row neither declares the kind nor has structured output', async () => {
    const row = chosenRow({ decisionKinds: ['boolean'], structuredOutput: false });
    const { bureau, generated, nativeAsked } = await open({
      catalog: [FALLBACK_ROW, row],
      model: 'typesafe/jev',
    });

    await bureau.decisions.decide({
      kind: 'structured',
      question: 'Name it',
      schema: z.object({ answer: z.boolean() }),
    });

    expect(named(generated)).toEqual(['anthropic/claude-haiku-5-5']);
    expect(nativeAsked).toEqual([]);
  });

  it('answers with the fallback, not a needs-setup refusal, while the chosen row is unavailable (no key saved)', async () => {
    const row = chosenRow({ decisionKinds: ['boolean'], availability: 'unavailable' });
    const { bureau, generated, decided } = await open({
      catalog: [FALLBACK_ROW, row],
      model: 'typesafe/jev',
    });

    const decision = await bureau.decisions.decide({ kind: 'boolean', question: 'Is it?' });

    expect(decision.provider).toBe('anthropic');
    expect(decided).toEqual([]);
    expect(named(generated)).toEqual(['anthropic/claude-haiku-5-5']);
  });

  it('answers with the fallback when the chosen row is not in the catalog', async () => {
    const { bureau, generated } = await open({ catalog: [FALLBACK_ROW], model: 'typesafe/jev' });

    await bureau.decisions.decide({ kind: 'boolean', question: 'Is it?' });

    expect(named(generated)).toEqual(['anthropic/claude-haiku-5-5']);
  });

  it('answers through the row’s generate, not a refusal, when the host supplied no models.decide', async () => {
    const row = chosenRow({ decisionKinds: ['boolean'], structuredOutput: true });
    const { bureau, generated } = await open({
      catalog: [FALLBACK_ROW, row],
      model: 'typesafe/jev',
      withoutDecide: true,
    });

    const decision = await bureau.decisions.decide({ kind: 'boolean', question: 'Is it?' });

    expect(decision.value).toBe(true);
    expect(named(generated)).toEqual(['typesafe/jev']);
  });

  it('rejects with the provider’s own error and does not ask the fallback', async () => {
    const row = chosenRow({ decisionKinds: ['boolean'] });
    const failure = new Error('429 from the provider');
    const { bureau, generated } = await open({
      catalog: [FALLBACK_ROW, row],
      model: 'typesafe/jev',
      nativeError: failure,
    });

    expect(
      await rejectionOf(bureau.decisions.decide({ kind: 'boolean', question: 'Is it?' })),
    ).toBe(failure);
    expect(generated).toEqual([]);
  });

  it('refuses a chosen row the model policy forbids instead of answering with the fallback', async () => {
    const row = chosenRow({ decisionKinds: ['boolean'] });
    const { bureau, generated, decided } = await open({
      catalog: [FALLBACK_ROW, row],
      model: 'typesafe/jev',
      modelPolicy: { deployment: { deniedModels: ['jev'] }, policyRevision: 1 },
    });

    expect(
      await rejectionOf(bureau.decisions.decide({ kind: 'boolean', question: 'Is it?' })),
    ).toBeInstanceOf(ModelPolicyDeniedError);
    expect(decided).toEqual([]);
    expect(generated).toEqual([]);
  });
});

/** The `detail` of every `decision.made` record, in order. */
async function recorded(bureau: Bureau): Promise<unknown[]> {
  const records = (await bureau.internals.auditTrail?.query({ type: 'decision.made' })) ?? [];
  return records.map((record) => record.detail);
}

describe('the decision.made record names the answering row and how it answered (COR-2155)', () => {
  it('records a native answer', async () => {
    const row = chosenRow({ decisionKinds: ['boolean'] });
    const { bureau } = await open({ catalog: [FALLBACK_ROW, row], model: 'typesafe/jev' });

    await bureau.decisions.decide({ kind: 'boolean', question: 'Is it?' });

    expect(await recorded(bureau)).toEqual([
      {
        kind: 'boolean',
        provider: 'typesafe',
        model: 'jev',
        outcome: 'answered',
        row: 'typesafe/jev',
        path: 'native',
      },
    ]);
  });

  it('records an adapter answer', async () => {
    const row = chosenRow({ decisionKinds: ['boolean'], structuredOutput: true });
    const { bureau } = await open({ catalog: [FALLBACK_ROW, row], model: 'typesafe/jev' });

    await bureau.decisions.decide({
      kind: 'structured',
      question: 'Name it',
      schema: z.object({ answer: z.boolean() }),
    });

    const [detail] = await recorded(bureau);
    expect(detail).toMatchObject({ outcome: 'answered', row: 'typesafe/jev', path: 'adapter' });
  });

  it('records a fallback answer', async () => {
    const { bureau } = await open({ catalog: [FALLBACK_ROW], model: 'typesafe/jev' });

    await bureau.decisions.decide({ kind: 'boolean', question: 'Is it?' });

    const [detail] = await recorded(bureau);
    expect(detail).toMatchObject({
      outcome: 'answered',
      row: 'anthropic/claude-haiku-5-5',
      path: 'fallback',
    });
  });

  it('records the provider error of a native answer and rethrows it', async () => {
    const row = chosenRow({ decisionKinds: ['boolean'] });
    const failure = new Error('429 from the provider');
    const { bureau } = await open({
      catalog: [FALLBACK_ROW, row],
      model: 'typesafe/jev',
      nativeError: failure,
    });

    expect(
      await rejectionOf(bureau.decisions.decide({ kind: 'boolean', question: 'Is it?' })),
    ).toBe(failure);

    expect(await recorded(bureau)).toEqual([
      { kind: 'boolean', outcome: 'error', reason: 'Error', row: 'typesafe/jev', path: 'native' },
    ]);
  });

  it('records a refusal by the model policy with the row it forbade', async () => {
    const row = chosenRow({ decisionKinds: ['boolean'] });
    const { bureau } = await open({
      catalog: [FALLBACK_ROW, row],
      model: 'typesafe/jev',
      modelPolicy: { deployment: { deniedModels: ['jev'] }, policyRevision: 1 },
    });

    expect(
      await rejectionOf(bureau.decisions.decide({ kind: 'boolean', question: 'Is it?' })),
    ).toBeInstanceOf(ModelPolicyDeniedError);

    expect(await recorded(bureau)).toEqual([
      {
        kind: 'boolean',
        outcome: 'refused',
        reason: 'model-policy-denied',
        row: 'typesafe/jev',
      },
    ]);
  });
});

describe('saving decisions.model', () => {
  it('accepts a known provider’s row before its key exists, and refuses a name no row has', async () => {
    const row = chosenRow({ decisionKinds: ['boolean'], availability: 'unavailable' });
    const { bureau } = await open({ catalog: [FALLBACK_ROW, row] });
    const { revision } = await bureau.settings.get();

    const refused = await bureau.settings.update(
      { 'decisions.model': 'nope/none' },
      { expectedRevision: revision },
    );
    expect(refused).toMatchObject({ outcome: 'rejected', reason: 'invalid-value' });

    const accepted = await bureau.settings.update(
      { 'decisions.model': 'typesafe/jev' },
      { expectedRevision: revision },
    );
    expect(accepted).toMatchObject({ outcome: 'applied' });
    const snapshot = await bureau.settings.get();
    expect(snapshot.values['decisions.model']).toBe('typesafe/jev');
  });

  it('refuses the retired catalog name', async () => {
    const { bureau } = await open({ catalog: [FALLBACK_ROW] });
    const { revision } = await bureau.settings.get();

    const result = await bureau.settings.update(
      { 'decisions.model': 'catalog' },
      { expectedRevision: revision },
    );

    expect(result).toMatchObject({ outcome: 'rejected', reason: 'invalid-value' });
  });
});

/**
 * COR-1709 — `bureau.decisions.decide` over a real Bureau and its handler: the scope that gates it,
 * a `structured` request given as JSON Schema, a retry that asks the model again, the faults, and
 * what the audit record leaves out.
 */
import {
  type BackendDescriptor,
  createMockGenerate,
  createModelCatalog,
  type GenerateFunction,
} from '@lostgradient/operative';
import { afterEach, describe, expect, it } from 'bun:test';

import type { BureauModelPolicyOptions } from '../../model-policy.ts';
import { BUREAU_HANDLER_OPERATIONS } from '../create-bureau-handler.ts';
import { decisionsDecideOperation, decisionsModelsOperation } from './decisions-operations.ts';
import {
  openBureau,
  type OpenedBureau,
  type RpcBody,
  rpc,
} from './management-fixtures.test-support.ts';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const CONTEXT = 'CONTEXT-SENTINEL-77de';
const VALUE = 'VALUE-SENTINEL-1b42';
const SCHEMA = {
  type: 'object',
  properties: { verdict: { type: 'string' } },
  required: ['verdict'],
  additionalProperties: false,
};

async function open(
  replies: readonly string[],
  options: {
    readonly withoutGenerate?: boolean;
    readonly modelPolicy?: BureauModelPolicyOptions;
  } = {},
): Promise<{ opened: OpenedBureau; generate: ReturnType<typeof createMockGenerate> }> {
  const generate = createMockGenerate(replies.map((content) => ({ content, toolCalls: [] })));
  const opened = await openBureau({
    bureauOptions: {
      models:
        options.withoutGenerate === true ? {} : { generate: (): GenerateFunction => generate },
      ...(options.modelPolicy === undefined ? {} : { modelPolicy: options.modelPolicy }),
    },
  });
  cleanups.push(() => opened.dispose());
  return { opened, generate };
}

const decide = (opened: OpenedBureau, key: string, params: Record<string, unknown>) =>
  rpc(opened.handler, 'bureau.decisions.decide', { commandId: 'c1', ...params }, key);

const STRUCTURED = {
  kind: 'structured',
  question: 'Verdict?',
  context: CONTEXT,
  schema: SCHEMA,
};

describe('bureau.decisions.decide', () => {
  it('is served, and requires bureau.decisions:write', () => {
    expect(BUREAU_HANDLER_OPERATIONS).toContain(decisionsDecideOperation);
  });

  it('refuses a caller without the scope and asks no model', async () => {
    const { opened, generate } = await open(['{"answer":true}']);

    for (const key of ['alice-key', 'tasks-operator-key', 'audit-reader-key']) {
      const refused = await decide(opened, key, { kind: 'boolean', question: 'Is it?' });
      expect(refused.result).toBeUndefined();
      expect(refused.error?.data).toMatchObject({ httpStatus: 403 });
    }
    expect(generate.callCount).toBe(0);
  });

  it('returns a decision for a JSON Schema structured request', async () => {
    const { opened } = await open([JSON.stringify({ verdict: VALUE })]);

    const answered = await decide(opened, 'decisions-writer-key', STRUCTURED);

    expect(answered.error).toBeUndefined();
    expect(answered.result).toMatchObject({
      value: { verdict: VALUE },
      provider: 'anthropic',
      model: 'claude-haiku-5-5',
    });
  });

  it('answers the typed kinds', async () => {
    const { opened } = await open(['{"answer":true}', '{"key":"b"}', '{"level":1}']);

    const results: RpcBody[] = [
      await decide(opened, 'decisions-writer-key', { kind: 'boolean', question: 'Is it?' }),
      await decide(opened, 'decisions-writer-key', {
        kind: 'choice',
        question: 'Which?',
        options: [
          { key: 'a', label: 'A' },
          { key: 'b', label: 'B' },
        ],
      }),
      await decide(opened, 'decisions-writer-key', {
        kind: 'scale',
        question: 'How?',
        levels: ['no', 'yes'],
      }),
    ];

    expect(results.map((body) => body.result?.['value'])).toEqual([true, 'b', 1]);
  });

  it('asks the model again on a retry under the same commandId', async () => {
    const { opened, generate } = await open(['{"answer":true}', '{"answer":false}']);

    const first = await decide(opened, 'decisions-writer-key', {
      commandId: 'retry-1',
      kind: 'boolean',
      question: 'Is it?',
    });
    const second = await decide(opened, 'decisions-writer-key', {
      commandId: 'retry-1',
      kind: 'boolean',
      question: 'Is it?',
    });

    expect(generate.callCount).toBe(2);
    expect([first.result?.['value'], second.result?.['value']]).toEqual([true, false]);
  });

  it('records the caller as principal and never the context or the value', async () => {
    const { opened } = await open([JSON.stringify({ verdict: VALUE })]);

    await decide(opened, 'decisions-writer-key', STRUCTURED);

    const records =
      (await opened.bureau.internals.auditTrail?.query({ type: 'decision.made' })) ?? [];
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      principal: 'api-key:decisions-writer',
      detail: { kind: 'structured', provider: 'anthropic', model: 'claude-haiku-5-5' },
    });
    expect(records[0]?.detail).toHaveProperty('schemaSha256');
    const stored = JSON.stringify(records);
    expect(stored).not.toContain(CONTEXT);
    expect(stored).not.toContain(VALUE);
  });

  it('refuses a malformed request or schema as invalid params', async () => {
    const { opened, generate } = await open([]);

    for (const params of [
      { kind: 'choice', question: 'Which?', options: [] },
      { kind: 'structured', question: 'Q?', schema: { type: 'string', pattern: 'a' } },
      { kind: 'structured', question: 'Q?' },
      { kind: 'boolean', question: ' ' },
    ]) {
      const refused = await decide(opened, 'decisions-writer-key', params);
      expect(refused.error?.data).toMatchObject({ httpStatus: 400 });
    }
    expect(generate.callCount).toBe(0);
  });

  it('answers a deployment with no model able to answer as an unsupported capability', async () => {
    const { opened } = await open([], { withoutGenerate: true });

    const refused = await decide(opened, 'decisions-writer-key', {
      kind: 'boolean',
      question: 'Is it?',
    });

    expect(refused.error?.data).toMatchObject({ capability: 'generate' });
  });

  it('answers an answer that fails validation twice as unprocessable', async () => {
    const { opened } = await open(['nonsense', 'nonsense']);

    const refused = await decide(opened, 'decisions-writer-key', {
      kind: 'boolean',
      question: 'Is it?',
    });

    expect(refused.error?.data).toMatchObject({ httpStatus: 422, reason: 'decision-schema' });
  });

  it('answers a policy that forbids every model able to answer as unprocessable, and calls no provider', async () => {
    const forbidden = createModelCatalog().descriptors.map((descriptor) => descriptor.model);
    const { opened, generate } = await open([], {
      modelPolicy: { deployment: { deniedModels: forbidden }, policyRevision: 3 },
    });

    const refused = await decide(opened, 'decisions-writer-key', {
      kind: 'boolean',
      question: 'Is it?',
    });

    expect(refused.error?.data).toMatchObject({
      httpStatus: 422,
      reason: 'model-policy-denied',
    });
    expect(refused.error?.message).toContain('model policy');
    expect(generate.callCount).toBe(0);
  });
});

const seed = createModelCatalog().descriptors.find((row) => row.model === 'claude-haiku-5-5')!;

/** A catalog row with explicit capability and price: no vendor catalog is relied on (COR-2151). */
function row(
  provider: string,
  model: string,
  overrides: Partial<BackendDescriptor> = {},
): BackendDescriptor {
  return {
    ...seed,
    provider,
    model,
    aliases: [],
    availability: 'available',
    structuredOutput: true,
    decisions: undefined,
    pricing: { inputPerMillionTokens: 1, outputPerMillionTokens: 5, currency: 'USD' },
    ...overrides,
  };
}

async function openWithCatalog(
  catalog: readonly BackendDescriptor[],
  options: {
    readonly fallbackModel?: string;
    /** The `decisions.model` the Bureau starts with: a catalog row written `<provider>/<model>`. */
    readonly model?: string;
    readonly modelPolicy?: BureauModelPolicyOptions;
  } = {},
): Promise<OpenedBureau> {
  const decisions = {
    ...(options.fallbackModel === undefined ? {} : { fallbackModel: options.fallbackModel }),
    ...(options.model === undefined ? {} : { model: options.model }),
  };
  const opened = await openBureau({
    bureauOptions: {
      models: { catalog, generate: (): GenerateFunction => createMockGenerate([]) },
      decisions,
      ...(options.modelPolicy === undefined ? {} : { modelPolicy: options.modelPolicy }),
    },
  });
  cleanups.push(() => opened.dispose());
  return opened;
}

const models = (opened: OpenedBureau, key = 'settings-reader-key') =>
  rpc(opened.handler, 'bureau.decisions.models', {}, key);

/** The rows `bureau.decisions.models` answers a caller that may read the settings. */
async function answeredRows(
  opened: OpenedBureau,
): Promise<{ model: string; answering: boolean; fallback: boolean }[]> {
  const answered = await models(opened);
  return (answered.result?.['rows'] ?? []) as {
    model: string;
    answering: boolean;
    fallback: boolean;
  }[];
}

/** The names of the rows marked by `field`. */
const marked = (
  rows: readonly { model: string; answering: boolean; fallback: boolean }[],
  field: 'answering' | 'fallback',
): string[] => rows.filter((entry) => entry[field]).map((entry) => entry.model);

describe('bureau.decisions.models', () => {
  it('is served, beside bureau.decisions.decide', () => {
    expect(BUREAU_HANDLER_OPERATIONS).toContain(decisionsModelsOperation);
  });

  it('lists an available row, a needs-setup row and a decision-only row, and marks the one that answers', async () => {
    const opened = await openWithCatalog([
      row('acme', 'priced-dear', {
        pricing: { inputPerMillionTokens: 9, outputPerMillionTokens: 9, currency: 'USD' },
      }),
      row('acme', 'priced-cheap', {
        pricing: { inputPerMillionTokens: 1, outputPerMillionTokens: 1, currency: 'USD' },
      }),
      row('ollama', 'local', { availability: 'unavailable' }),
      row('typesafe', 'jev', {
        structuredOutput: false,
        decisions: { kinds: ['boolean'], only: true },
      }),
      // Neither native nor structured: it cannot decide, so it is not listed.
      row('acme', 'chat-only', { structuredOutput: false }),
    ]);

    const answered = await models(opened);

    expect(answered.error).toBeUndefined();
    expect(answered.result?.['rows']).toEqual([
      {
        provider: 'acme',
        model: 'priced-dear',
        availability: 'available',
        decisionOnly: false,
        answering: false,
        fallback: false,
      },
      {
        provider: 'acme',
        model: 'priced-cheap',
        availability: 'available',
        decisionOnly: false,
        answering: true,
        fallback: true,
      },
      {
        provider: 'ollama',
        model: 'local',
        availability: 'needs-setup',
        decisionOnly: false,
        answering: false,
        fallback: false,
      },
      {
        provider: 'typesafe',
        model: 'jev',
        availability: 'available',
        decisionOnly: true,
        answering: false,
        fallback: false,
      },
    ]);
  });

  it('marks the row decisions.model names as answering while it is available, and the fallback still as the fallback', async () => {
    const opened = await openWithCatalog(
      [
        row('acme', 'cheap', {
          pricing: { inputPerMillionTokens: 1, outputPerMillionTokens: 1, currency: 'USD' },
        }),
        row('typesafe', 'jev', {
          structuredOutput: false,
          decisions: { kinds: ['boolean'], only: true },
        }),
      ],
      { model: 'typesafe/jev' },
    );

    const rows = await answeredRows(opened);

    expect(marked(rows, 'answering')).toEqual(['jev']);
    expect(marked(rows, 'fallback')).toEqual(['cheap']);
  });

  it('leaves the answering to the fallback while the row decisions.model names needs setup, or is not in the catalog', async () => {
    for (const row_ of [
      row('typesafe', 'jev', {
        availability: 'unavailable',
        structuredOutput: false,
        decisions: { kinds: ['boolean'], only: true },
      }),
      row('typesafe', 'other'),
    ]) {
      const opened = await openWithCatalog(
        [
          row('acme', 'cheap', {
            pricing: { inputPerMillionTokens: 1, outputPerMillionTokens: 1, currency: 'USD' },
          }),
          row_,
        ],
        { model: 'typesafe/jev' },
      );

      const rows = await answeredRows(opened);

      expect(marked(rows, 'answering')).toEqual(['cheap']);
      expect(marked(rows, 'fallback')).toEqual(['cheap']);
    }
  });

  it('marks no row as answering while the model policy forbids the row decisions.model names, which refuses every decision', async () => {
    const opened = await openWithCatalog(
      [
        row('acme', 'cheap', {
          pricing: { inputPerMillionTokens: 1, outputPerMillionTokens: 1, currency: 'USD' },
        }),
        row('typesafe', 'jev', {
          structuredOutput: false,
          decisions: { kinds: ['boolean'], only: true },
        }),
      ],
      {
        model: 'typesafe/jev',
        modelPolicy: { deployment: { deniedModels: ['jev'] }, policyRevision: 1 },
      },
    );

    const rows = await answeredRows(opened);

    // The forbidden row is left out of the list; nothing answers, though the fallback is chosen.
    expect(rows.map((entry) => entry.model)).toEqual(['cheap']);
    expect(marked(rows, 'answering')).toEqual([]);
    expect(marked(rows, 'fallback')).toEqual(['cheap']);
  });

  it('marks the configured fallback row when it is eligible, in place of a cheaper one', async () => {
    const opened = await openWithCatalog(
      [
        row('acme', 'cheap', {
          pricing: { inputPerMillionTokens: 1, outputPerMillionTokens: 1, currency: 'USD' },
        }),
        row('acme', 'preferred', {
          pricing: { inputPerMillionTokens: 8, outputPerMillionTokens: 8, currency: 'USD' },
        }),
      ],
      { fallbackModel: 'acme/preferred' },
    );

    const rows = await answeredRows(opened);

    expect(marked(rows, 'fallback')).toEqual(['preferred']);
    expect(marked(rows, 'answering')).toEqual(['preferred']);
  });

  it('matches the configured fallback by an alias of a row, as the fallback itself does', async () => {
    const opened = await openWithCatalog(
      [
        row('acme', 'cheap', {
          pricing: { inputPerMillionTokens: 1, outputPerMillionTokens: 1, currency: 'USD' },
        }),
        row('acme', 'preferred-long-name', {
          aliases: [{ alias: 'preferred', resolvesTo: 'preferred-long-name' }] as never,
          pricing: { inputPerMillionTokens: 8, outputPerMillionTokens: 8, currency: 'USD' },
        }),
      ],
      { fallbackModel: 'acme/preferred' },
    );

    const rows = await answeredRows(opened);

    expect(marked(rows, 'fallback')).toEqual(['preferred-long-name']);
    expect(marked(rows, 'answering')).toEqual(['preferred-long-name']);
  });

  it('marks no row while nothing eligible and priced can answer, and leaves out a row the policy forbids', async () => {
    const opened = await openWithCatalog(
      [
        row('ollama', 'local', { availability: 'unavailable' }),
        row('acme', 'unpriced', { pricing: undefined }),
        row('acme', 'denied'),
      ],
      { modelPolicy: { deployment: { deniedModels: ['denied'] }, policyRevision: 1 } },
    );

    const rows = await answeredRows(opened);

    expect(rows.map((entry) => entry.model)).toEqual(['local', 'unpriced']);
    expect(marked(rows, 'answering')).toEqual([]);
    expect(marked(rows, 'fallback')).toEqual([]);
  });

  it('requires bureau.settings:read, and the decisions scope alone does not read it', async () => {
    const opened = await openWithCatalog([row('acme', 'one')]);

    for (const key of ['alice-key', 'decisions-writer-key', 'audit-reader-key']) {
      const refused = await models(opened, key);
      expect(refused.result).toBeUndefined();
      expect(refused.error?.data).toMatchObject({ httpStatus: 403 });
    }
    const allowed = await models(opened, 'settings-reader-key');
    expect(allowed.error).toBeUndefined();
  });
});

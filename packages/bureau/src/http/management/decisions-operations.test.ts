/**
 * COR-1709 — `bureau.decisions.decide` over a real Bureau and its handler: the scope that gates it,
 * a `structured` request given as JSON Schema, a retry that asks the model again, the faults, and
 * what the audit record leaves out.
 */
import {
  createMockGenerate,
  createModelCatalog,
  type GenerateFunction,
} from '@lostgradient/operative';
import { afterEach, describe, expect, it } from 'bun:test';

import type { BureauModelPolicyOptions } from '../../model-policy.ts';
import { BUREAU_HANDLER_OPERATIONS } from '../create-bureau-handler.ts';
import { decisionsDecideOperation } from './decisions-operations.ts';
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

import { quietFor, waitUntil } from '@lostgradient/testing/wait-until';
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import {
  createTool,
  createToolbox,
  type SignedPendingToolApproval,
  type ToolPolicyContext,
  type ToolSecretResolver,
} from '../src';
import { createToolResultCache } from '../src/idempotency/create-tool-result-cache';
import { fullInputKey } from '../src/idempotency/key-generators';
import { withIdempotency } from '../src/idempotency/with-idempotency';
import { createTestStore } from './idempotency/with-idempotency-fixtures';
import { expectNoPlaintext, findPlaintext, recordEveryEvent } from './secret-leak-scan';

// Only identifier characters, so an engine's JSON.parse error quotes all of it.
const secretValue = 'plaintextSecret9f3a';
const reference = { secretRef: 'review-9/token' };
const resolver: ToolSecretResolver = () => secretValue;
const requestContext = {
  authority: {
    principalId: 'principal-a',
    tenantId: 'tenant-a',
    ownerId: 'owner-a',
    capabilities: ['tools:execute'],
    authorizationRevision: 'authorization:1',
  },
  audience: 'tenant' as const,
  agentId: 'agent-a',
  runId: 'run-a',
};

const blockCeo = (seen: unknown[]) => ({
  beforeExecute: (context: ToolPolicyContext) => {
    seen.push(context.params);
    const to = (context.params as { to?: unknown }).to;
    return to === 'ceo@corp.com' ? { allow: false, reason: 'blocked recipient' } : { allow: true };
  },
});

describe('a schema check that throws on the plaintext', () => {
  const throwingSchemas = {
    'a transform that parses the value as JSON': z.string().transform((v) => JSON.parse(v)),
    'a transform that throws the value': z.string().transform((v): string => {
      throw new Error(`cannot use ${v}`);
    }),
    'a refinement that throws the value': z.string().refine((v) => {
      if (!v.startsWith('pk-')) throw new Error(`bad prefix in ${v}`);
      return true;
    }),
    'an async refinement that rejects with the value': z.string().refine(async (v) => {
      throw new Error(`rejected ${v}`);
    }),
  };

  for (const [label, credential] of Object.entries(throwingSchemas)) {
    it(`never shows the plaintext: ${label}`, async () => {
      const executed: unknown[] = [];
      const tool = createTool({
        name: 'throwing-check',
        description: 'validates a credential with a check that throws',
        input: z.object({ credential }),
        metadata: { acceptsSecrets: true },
        async execute(params) {
          executed.push(params);
          return 'ok';
        },
      });
      const toolbox = createToolbox([tool], { secretResolver: resolver });
      const events = recordEveryEvent(toolbox);
      const result = await toolbox.execute({
        id: 'throwing-1',
        name: 'throwing-check',
        arguments: { credential: reference },
      });

      expect(result.outcome).toBe('error');
      expect(result.error?.code).toBe('VALIDATION_ERROR');
      expect(executed).toEqual([]);
      expectNoPlaintext({ result, events }, secretValue);
    });
  }
});

describe('an issue path below a reference', () => {
  it('is clipped to the reference, so a key parsed out of the plaintext never shows', async () => {
    const secretKey = 'SECRETKEY7b21';
    const tool = createTool({
      name: 'keyed-credential',
      description: 'parses a credential into a keyed structure',
      input: z.object({
        label: z.string(),
        cred: z
          .string()
          .transform((value): unknown => JSON.parse(value))
          .pipe(z.record(z.string(), z.number())),
      }),
      metadata: { acceptsSecrets: true },
      async execute() {
        return 'ok';
      },
    });
    const toolbox = createToolbox([tool], {
      secretResolver: () => JSON.stringify({ [secretKey]: 'not a number' }),
    });
    const events = recordEveryEvent(toolbox);
    const result = await toolbox.execute({
      id: 'keyed-1',
      name: 'keyed-credential',
      arguments: { label: 'primary', cred: reference },
    });

    expect(result.error?.code).toBe('VALIDATION_ERROR');
    expect(result.error?.details).toEqual({
      issues: [expect.objectContaining({ path: ['cred'] })],
    });
    expectNoPlaintext({ result, events }, secretKey);
  });
});

describe('policy sees what a literal call would show it', () => {
  function sendTool(executed: unknown[]) {
    return createTool({
      name: 'send',
      description: 'sends a message',
      version: '1.0.0',
      input: z.object({ to: z.string().trim().toLowerCase(), token: z.string() }),
      metadata: { acceptsSecrets: true },
      async execute(params) {
        executed.push(params);
        return 'sent';
      },
    });
  }

  it('denies a reference-bearing call that a literal call with the same recipient is denied', async () => {
    const seen: unknown[] = [];
    const executed: unknown[] = [];
    const toolbox = createToolbox([sendTool(executed)], {
      secretResolver: resolver,
      policy: blockCeo(seen),
    });
    const literal = await toolbox.execute({
      id: 'literal',
      name: 'send',
      arguments: { to: ' CEO@corp.com ', token: 'literal' },
    });
    const referenced = await toolbox.execute({
      id: 'referenced',
      name: 'send',
      arguments: { to: ' CEO@corp.com ', token: reference },
    });

    expect(literal.error?.code).toBe('POLICY_DENIED');
    expect(referenced.error?.code).toBe('POLICY_DENIED');
    expect(executed).toEqual([]);
    expect(seen).toEqual([
      { to: 'ceo@corp.com', token: 'literal' },
      { to: 'ceo@corp.com', token: reference },
    ]);
  });

  it('applies defaults, coercions, and transforms to every field that is not a reference', async () => {
    const seen: unknown[] = [];
    const tool = createTool({
      name: 'transfer',
      description: 'moves money',
      input: z.object({
        to: z.string().trim().toLowerCase(),
        amount: z.coerce.number(),
        limit: z.number().default(100),
        token: z.string(),
      }),
      metadata: { acceptsSecrets: true },
      async execute() {
        return 'moved';
      },
    });
    const toolbox = createToolbox([tool], {
      secretResolver: resolver,
      policy: { beforeExecute: (context) => (seen.push(context.params), { allow: true }) },
    });
    const base = { to: ' Bob@Example.com ', amount: '12' };
    await toolbox.execute({ id: 'l', name: 'transfer', arguments: { ...base, token: 'literal' } });
    await toolbox.execute({ id: 'r', name: 'transfer', arguments: { ...base, token: reference } });

    const [literal, referenced] = seen as Array<Record<string, unknown>>;
    const { token: literalToken, ...literalRest } = literal ?? {};
    const { token: referencedToken, ...referencedRest } = referenced ?? {};
    expect(literalToken).toBe('literal');
    expect(referencedToken).toEqual(reference);
    expect(referencedRest).toEqual(literalRest);
    expect(referencedRest).toEqual({ to: 'bob@example.com', amount: 12, limit: 100 });
  });

  it('does so for a reference nested in an array element, a record, and an optional object', async () => {
    const seen: unknown[] = [];
    const executed: unknown[] = [];
    const tool = createTool({
      name: 'nested',
      description: 'nested references',
      input: z.object({
        recipients: z.array(
          z.object({ address: z.string().trim().toLowerCase(), key: z.string().min(4) }),
        ),
        headers: z.record(z.string(), z.string().trim()),
        auth: z.object({ scheme: z.string().toUpperCase(), token: z.string() }).optional(),
      }),
      metadata: { acceptsSecrets: true },
      async execute(params) {
        executed.push(params);
        return 'ok';
      },
    });
    const toolbox = createToolbox([tool], {
      secretResolver: resolver,
      policy: { beforeExecute: (context) => (seen.push(context.params), { allow: true }) },
    });
    const result = await toolbox.execute({
      id: 'nested-1',
      name: 'nested',
      arguments: {
        recipients: [
          { address: ' A@X.TEST ', key: reference },
          { address: ' B@X.TEST ', key: 'literal-key' },
        ],
        headers: { authorization: reference, accept: ' json ' },
        auth: { scheme: 'bearer', token: reference },
      },
    });

    expect(result.outcome).toBe('success');
    expect(seen).toEqual([
      {
        recipients: [
          { address: 'a@x.test', key: reference },
          { address: 'b@x.test', key: 'literal-key' },
        ],
        headers: { authorization: reference, accept: 'json' },
        auth: { scheme: 'BEARER', token: reference },
      },
    ]);
    expect(executed).toEqual([
      {
        recipients: [
          { address: 'a@x.test', key: secretValue },
          { address: 'b@x.test', key: 'literal-key' },
        ],
        headers: { authorization: secretValue, accept: 'json' },
        auth: { scheme: 'BEARER', token: secretValue },
      },
    ]);
  });

  it("never runs a position's own checks on the reference object at admission", async () => {
    const executed: unknown[] = [];
    const tool = createTool({
      name: 'strict-check',
      description: 'a credential check that throws on anything but a string',
      input: z.object({
        token: z.unknown().refine((value) => {
          if (typeof value !== 'string') throw new TypeError('the check saw a non-string');
          return true;
        }),
      }),
      metadata: { acceptsSecrets: true },
      async execute(params) {
        executed.push(params);
        return 'ok';
      },
    });
    const toolbox = createToolbox([tool], { secretResolver: resolver });
    const result = await toolbox.execute({
      id: 'strict-1',
      name: 'strict-check',
      arguments: { token: reference },
    });

    expect(result.outcome).toBe('success');
    expect(executed).toEqual([{ token: secretValue }]);
  });

  it('records a pending approval with the same non-reference arguments as a literal call', async () => {
    const executed: unknown[] = [];
    const toolbox = createToolbox([sendTool(executed)], {
      approvalSecret: 'approval-secret',
      secretResolver: resolver,
      policy: { beforeExecute: () => ({ status: 'needs_approval' as const, allow: false }) },
    });
    const literal = await toolbox.execute(
      { id: 'pl', name: 'send', arguments: { to: ' Bob@X.test ', token: 'literal' } },
      { requestContext },
    );
    const referenced = await toolbox.execute(
      { id: 'pr', name: 'send', arguments: { to: ' Bob@X.test ', token: reference } },
      { requestContext },
    );

    expect(literal.pendingApproval?.arguments).toEqual({ to: 'bob@x.test', token: 'literal' });
    expect(referenced.pendingApproval?.arguments).toEqual({ to: 'bob@x.test', token: reference });
    const resumed = await toolbox.resumeApproval(
      referenced.pendingApproval as SignedPendingToolApproval,
      { requestContext },
    );
    expect(resumed.outcome).toBe('success');
    expect(executed).toEqual([{ to: 'bob@x.test', token: secretValue }]);
    expectNoPlaintext([referenced, resumed], secretValue);
  });
});

describe('a reference the schema cannot place', () => {
  const unplaceable = {
    'under a union': z.object({
      message: z.union([
        z.object({ to: z.string().trim().toLowerCase(), token: z.string() }),
        z.object({ to: z.string(), token: z.unknown() }),
      ]),
    }),
    'under a transform of the enclosing object': z.object({
      message: z
        .object({ to: z.string(), token: z.string() })
        .transform((value) => ({ ...value, to: value.to.trim().toLowerCase() })),
    }),
  };

  for (const [label, input] of Object.entries(unplaceable)) {
    it(`fails admission before policy and resolution: ${label}`, async () => {
      const order: string[] = [];
      const tool = createTool({
        name: 'unplaceable',
        description: 'a schema with no single place for the reference',
        input,
        metadata: { acceptsSecrets: true },
        async execute() {
          order.push('execute');
          return 'sent';
        },
      });
      const toolbox = createToolbox([tool], {
        secretResolver: () => (order.push('resolve'), secretValue),
        policy: { beforeExecute: () => (order.push('policy'), { allow: true }) },
      });
      const result = await toolbox.execute({
        id: 'unplaceable-1',
        name: 'unplaceable',
        arguments: { message: { to: ' CEO@corp.com ', token: reference } },
      });

      expect(result.outcome).toBe('error');
      expect(result.error?.code).toBe('VALIDATION_ERROR');
      expect(order).toEqual([]);
    });
  }
});

describe('everything Armorer emits around a declaring tool', () => {
  it('adds no plaintext when the tool itself throws', async () => {
    const tool = createTool({
      name: 'clean-failure',
      description: 'fails without quoting its input',
      input: z.object({ to: z.string(), token: z.string() }),
      metadata: { acceptsSecrets: true },
      async execute() {
        throw new Error('upstream refused the request');
      },
    });
    const afterExecute: unknown[] = [];
    const toolbox = createToolbox([tool], {
      telemetry: true,
      secretResolver: resolver,
      policy: {
        beforeExecute: () => ({ allow: true }),
        afterExecute: (context) => {
          afterExecute.push(context);
        },
      },
    });
    const events = recordEveryEvent(toolbox);
    const result = await toolbox.execute({
      id: 'clean-1',
      name: 'clean-failure',
      arguments: { to: 'bob@x.test', token: reference },
    });

    expect(result.outcome).toBe('error');
    expect(result.errorMessage).toContain('upstream refused the request');
    expect(events.length).toBeGreaterThan(0);
    expectNoPlaintext({ result, events, afterExecute }, secretValue);
  });

  it('keeps the plaintext out of an idempotency record', async () => {
    const store = createTestStore();
    const tool = createTool({
      name: 'remembered',
      description: 'an idempotent tool that takes a secret',
      version: '1.0.0',
      input: z.object({}).passthrough(),
      metadata: { acceptsSecrets: true },
      idempotencyKey: (input: unknown) => fullInputKey(input),
      secretResolver: resolver,
      async execute(params) {
        return { length: String(Reflect.get(params, 'token')).length };
      },
    });
    const wrapped = withIdempotency(tool, {
      cache: createToolResultCache({ store, defaultTTL: 60_000 }),
      tenantId: 'tenant-a',
    });
    const first = await wrapped.execute({ token: reference }, { requestContext });
    const second = await wrapped.execute({ token: reference }, { requestContext });

    expect(first).toEqual({ length: secretValue.length });
    expect(second).toEqual(first);
    const keys = await store.list('');
    const records = await Promise.all(keys.map(async (key) => [key, await store.get(key)]));
    expect(records.length).toBeGreaterThan(0);
    expect(findPlaintext(records, secretValue)).toEqual([]);
  });
});

describe('cancellation while a secret is resolving', () => {
  it('never starts the tool once the call has been cancelled', async () => {
    const executed: unknown[] = [];
    let release: (value: string) => void = () => undefined;
    let asked = false;
    const tool = createTool({
      name: 'slow-secret',
      description: 'a tool whose secret resolves slowly',
      input: z.object({ token: z.string() }),
      metadata: { acceptsSecrets: true },
      async execute(params) {
        executed.push(params);
        return 'ran';
      },
    });
    const toolbox = createToolbox([tool], {
      secretResolver: () => {
        asked = true;
        return new Promise<string>((resolve) => {
          release = resolve;
        });
      },
    });
    const controller = new AbortController();
    const pending = toolbox.execute(
      { id: 'cancel-1', name: 'slow-secret', arguments: { token: reference } },
      { signal: controller.signal },
    );
    await waitUntil(() => asked);
    controller.abort(new Error('caller gave up'));
    const result = await pending;
    expect(result).toMatchObject({ outcome: 'error', errorCategory: 'cancelled' });

    release(secretValue);
    // The tool must never run; load can only delay a wrongful start, never advance it.
    await quietFor(20);
    expect(executed).toEqual([]);
  });
});

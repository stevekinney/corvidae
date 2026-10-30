import { waitUntil } from '@lostgradient/testing/wait-until';
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { expectPromiseToReject } from '../src/async-assertion-test-helpers';

import {
  combineToolboxes,
  createTool,
  createToolbox,
  isSecretReference,
  type SignedPendingToolApproval,
  type ToolContext,
  type ToolSecretResolutionContext,
  type ToolSecretResolver,
} from '../src';
import { findSecretReferences, replaceSecretReferences } from '../src/secrets';

const plaintext = 'sk-live-plaintext-9f3a';
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

const lookup: Record<string, string> = {
  'review-1/token': plaintext,
  'review-1/other': 'other-plaintext',
};
const lookupResolver: ToolSecretResolver = (reference) => {
  const value = Object.hasOwn(lookup, reference) ? lookup[reference] : undefined;
  if (value === undefined) throw new Error(`no such secret ${reference} (store detail)`);
  return value;
};

const anyInput = z.object({}).passthrough();

type Received = { params: unknown; context: ToolContext | undefined };

function recordingTool(name: string, accepts: boolean, received: Received[]) {
  return createTool({
    name,
    description: `Records what it receives (${name})`,
    version: '1.0.0',
    input: anyInput,
    metadata: accepts ? { acceptsSecrets: true } : {},
    async execute(params, context) {
      received.push({ params, context });
      return 'done';
    },
  });
}

describe('secretRef detection', () => {
  it('recognizes only a plain object whose sole key is a string secretRef', () => {
    expect(isSecretReference({ secretRef: 'a/b' })).toBe(true);
    expect(isSecretReference({ secretRef: 'a/b', label: 'x' })).toBe(false);
    expect(isSecretReference({ secretRef: 7 })).toBe(false);
    expect(isSecretReference({})).toBe(false);
    expect(isSecretReference(['secretRef'])).toBe(false);
    expect(
      isSecretReference(
        new (class Box {
          secretRef = 'a';
        })(),
      ),
    ).toBe(false);
    expect(isSecretReference(Object.assign(Object.create(null), { secretRef: 'a' }))).toBe(true);
    expect(isSecretReference(null)).toBe(false);
  });

  it('finds nested references with their paths and replaces them in a fresh copy', () => {
    const original = {
      auth: { token: { secretRef: 'review-1/token' } },
      list: ['plain', { secretRef: 'review-1/other' }, { secretRef: 'review-1/token' }],
      untouched: { secretRef: 'x', note: 'ordinary data' },
    };
    expect(findSecretReferences(original)).toEqual([
      { path: ['auth', 'token'], reference: 'review-1/token' },
      { path: ['list', 1], reference: 'review-1/other' },
      { path: ['list', 2], reference: 'review-1/token' },
    ]);
    const copy = replaceSecretReferences(
      original,
      new Map([
        ['review-1/token', 'T'],
        ['review-1/other', 'O'],
      ]),
    );
    expect(copy).toEqual({
      auth: { token: 'T' },
      list: ['plain', 'O', 'T'],
      untouched: { secretRef: 'x', note: 'ordinary data' },
    });
    expect(original.auth.token).toEqual({ secretRef: 'review-1/token' });
    expect(copy).not.toBe(original);
  });

  it('does not loop on a cyclic value', () => {
    const cyclic: Record<string, unknown> = { token: { secretRef: 'a' } };
    cyclic['self'] = cyclic;
    expect(findSecretReferences(cyclic)).toEqual([{ path: ['token'], reference: 'a' }]);
  });
});

describe('a tool that declares acceptsSecrets', () => {
  it('receives the plaintext for a nested secretRef while the call keeps the reference', async () => {
    const received: Received[] = [];
    const tool = recordingTool('declared', true, received);
    const toolbox = createToolbox([tool], { secretResolver: lookupResolver });
    const args = {
      auth: { token: { secretRef: 'review-1/token' }, scheme: 'bearer' },
      headers: [{ secretRef: 'review-1/other' }, 'plain'],
    };
    const result = await toolbox.execute({ id: 'call-1', name: 'declared', arguments: args });

    expect(result.outcome).toBe('success');
    expect(received).toHaveLength(1);
    expect(received[0]?.params).toEqual({
      auth: { token: plaintext, scheme: 'bearer' },
      headers: ['other-plaintext', 'plain'],
    });
    // The caller's arguments and the call the tool is shown both still hold the references.
    expect(args.auth.token).toEqual({ secretRef: 'review-1/token' });
    expect(received[0]?.context?.toolCall.arguments).toEqual(args);
    expect(JSON.stringify(received[0]?.context?.toolCall)).not.toContain(plaintext);
  });

  it('shows the reference, never the plaintext, in every recorded event and policy hook', async () => {
    const received: Received[] = [];
    const order: string[] = [];
    const seenByPolicy: unknown[] = [];
    const tool = createTool({
      name: 'recorded',
      description: 'records order',
      input: anyInput,
      metadata: { acceptsSecrets: true },
      async execute(params, context) {
        order.push('execute');
        received.push({ params, context });
        return { echoed: 'ok' };
      },
    });
    const toolbox = createToolbox([tool], {
      telemetry: true,
      secretResolver: (reference, context) => {
        order.push('resolve');
        return lookupResolver(reference, context);
      },
      policy: {
        beforeExecute: (context) => {
          order.push('beforeExecute');
          seenByPolicy.push(context.params, context.toolCall);
          return { allow: true };
        },
        afterExecute: (context) => {
          order.push('afterExecute');
          seenByPolicy.push(context.params, context.toolCall);
        },
      },
    });
    const events: unknown[] = [];
    for (const type of [
      'tool.started',
      'execute-start',
      'validate-success',
      'execute-success',
      'settled',
      'tool.finished',
    ] as const) {
      toolbox.addEventListener(type, (event) => {
        order.push(type);
        const detail = event as unknown as Record<string, unknown>;
        events.push({
          type,
          toolCall: detail['toolCall'],
          params: detail['params'],
          parsed: detail['parsed'],
        });
      });
    }
    const result = await toolbox.execute({
      id: 'call-2',
      name: 'recorded',
      arguments: { token: { secretRef: 'review-1/token' } },
    });

    expect(result.outcome).toBe('success');
    const recorded = JSON.stringify([events, seenByPolicy, result]);
    expect(recorded).toContain('review-1/token');
    expect(recorded).not.toContain(plaintext);
    // Recording and approval evaluation come first; the plaintext exists only from `resolve` on.
    expect(order.indexOf('tool.started')).toBeLessThan(order.indexOf('resolve'));
    expect(order.indexOf('validate-success')).toBeLessThan(order.indexOf('resolve'));
    expect(order.indexOf('beforeExecute')).toBeLessThan(order.indexOf('resolve'));
    expect(order.indexOf('resolve')).toBeLessThan(order.indexOf('execute'));
    expect(received[0]?.params).toEqual({ token: plaintext });
  });

  it('keeps the plaintext out of a pending approval and resolves it only once approved', async () => {
    const received: Received[] = [];
    const resolved: string[] = [];
    const tool = createTool({
      name: 'approved',
      description: 'needs approval and takes a string secret',
      version: '1.0.0',
      input: z.object({ apiKey: z.string().min(8) }),
      metadata: { acceptsSecrets: true },
      async execute(params, context) {
        received.push({ params, context });
        return 'done';
      },
    });
    const toolbox = createToolbox([tool], {
      approvalSecret: 'approval-secret',
      secretResolver: (reference, context) => {
        resolved.push(reference);
        return lookupResolver(reference, context);
      },
      policy: { beforeExecute: () => ({ status: 'needs_approval' as const, allow: false }) },
    });
    const paused = await toolbox.execute(
      { id: 'call-3', name: 'approved', arguments: { apiKey: { secretRef: 'review-1/token' } } },
      { requestContext },
    );

    expect(paused.outcome).toBe('action_required');
    expect(JSON.stringify(paused)).toContain('review-1/token');
    expect(JSON.stringify(paused)).not.toContain(plaintext);
    expect(resolved).toEqual([]);
    expect(received).toEqual([]);

    const resumed = await toolbox.resumeApproval(
      paused.pendingApproval as SignedPendingToolApproval,
      {
        requestContext,
      },
    );
    expect(resumed.outcome).toBe('success');
    expect(resolved).toEqual(['review-1/token']);
    expect(received[0]?.params).toEqual({ apiKey: plaintext });
    expect(JSON.stringify(resumed)).not.toContain(plaintext);
  });

  it('resolves a reference that appears twice once per call', async () => {
    const received: Received[] = [];
    const resolved: string[] = [];
    const toolbox = createToolbox([recordingTool('twice', true, received)], {
      secretResolver: (reference, context) => {
        resolved.push(reference);
        return lookupResolver(reference, context);
      },
    });
    await toolbox.execute({
      id: 'call-4',
      name: 'twice',
      arguments: { a: { secretRef: 'review-1/token' }, b: { secretRef: 'review-1/token' } },
    });
    expect(resolved).toEqual(['review-1/token']);
    expect(received[0]?.params).toEqual({ a: plaintext, b: plaintext });
  });

  it('tells the resolver which tool, call, and execution context asked', async () => {
    const received: Received[] = [];
    const asked: Array<[string, ToolSecretResolutionContext]> = [];
    const toolbox = createToolbox([recordingTool('asked', true, received)], {
      secretResolver: (reference, context) => {
        asked.push([reference, context]);
        return plaintext;
      },
    });
    await toolbox.execute(
      { id: 'call-5', name: 'asked', arguments: { token: { secretRef: 'review-1/token' } } },
      { requestContext, executionContext: { runId: 'run-a' } },
    );
    expect(asked).toHaveLength(1);
    const [reference, context] = asked[0]!;
    expect(reference).toBe('review-1/token');
    expect(context.toolName).toBe('asked');
    expect(context.callId).toBe('call-5');
    expect(context.executionContext).toEqual({ runId: 'run-a' });
    expect(context.requestContext?.runId).toBe('run-a');
  });

  it('validates the plaintext against the schema, not the reference object', async () => {
    const received: Received[] = [];
    const tool = createTool({
      name: 'string-schema',
      description: 'expects a string',
      input: z.object({ apiKey: z.string().min(8), count: z.number().default(1) }),
      metadata: { acceptsSecrets: true },
      async execute(params, context) {
        received.push({ params, context });
        return 'ok';
      },
    });
    const toolbox = createToolbox([tool], { secretResolver: lookupResolver });
    const accepted = await toolbox.execute({
      id: 'call-6',
      name: 'string-schema',
      arguments: { apiKey: { secretRef: 'review-1/token' } },
    });
    expect(accepted.outcome).toBe('success');
    expect(received[0]?.params).toEqual({ apiKey: plaintext, count: 1 });

    // A value that is wrong for the schema fails; the message never quotes the secret.
    const tooShort = createToolbox([tool], { secretResolver: () => 'short' });
    const rejected = await tooShort.execute({
      id: 'call-7',
      name: 'string-schema',
      arguments: { apiKey: { secretRef: 'review-1/token' } },
    });
    expect(rejected.outcome).toBe('error');
    expect(rejected.error?.code).toBe('VALIDATION_ERROR');
    expect(JSON.stringify(rejected)).not.toContain('short');
    expect(received).toHaveLength(1);
  });

  it('still rejects an invalid argument that is not a reference', async () => {
    const received: Received[] = [];
    const tool = createTool({
      name: 'mixed-invalid',
      description: 'one reference and one bad value',
      input: z.object({ apiKey: z.string(), count: z.number() }),
      metadata: { acceptsSecrets: true },
      async execute(params, context) {
        received.push({ params, context });
        return 'ok';
      },
    });
    const resolved: string[] = [];
    const toolbox = createToolbox([tool], {
      secretResolver: (reference, context) => {
        resolved.push(reference);
        return lookupResolver(reference, context);
      },
    });
    const result = await toolbox.execute({
      id: 'call-8',
      name: 'mixed-invalid',
      arguments: { apiKey: { secretRef: 'review-1/token' }, count: 'three' },
    });
    expect(result.outcome).toBe('error');
    expect(result.error?.code).toBe('VALIDATION_ERROR');
    expect(resolved).toEqual([]);
    expect(received).toEqual([]);
  });

  it('gives two parallel calls their own substitutions', async () => {
    const received: Received[] = [];
    const releases: Array<() => void> = [];
    let asked = 0;
    const toolbox = createToolbox([recordingTool('parallel', true, received)], {
      secretResolver: async (reference) => {
        asked += 1;
        await new Promise<void>((resolve) => releases.push(resolve));
        return `plaintext-for-${reference}`;
      },
    });
    const first = toolbox.execute({
      id: 'parallel-1',
      name: 'parallel',
      arguments: { token: { secretRef: 'one' } },
    });
    const second = toolbox.execute({
      id: 'parallel-2',
      name: 'parallel',
      arguments: { token: { secretRef: 'two' } },
    });
    await waitUntil(() => asked === 2, {
      message: 'both calls to be waiting on the resolver',
    });
    // Release in the opposite order from the calls.
    releases[1]?.();
    releases[0]?.();
    await Promise.all([first, second]);

    const byCall = new Map(received.map((entry) => [entry.context?.meta?.callId, entry.params]));
    expect(byCall.get('parallel-1')).toEqual({ token: 'plaintext-for-one' });
    expect(byCall.get('parallel-2')).toEqual({ token: 'plaintext-for-two' });
  });

  it('substitutes from the arguments it admitted, not from an object the caller edits mid-call', async () => {
    const received: Received[] = [];
    const args: { token: unknown } = { token: { secretRef: 'review-1/token' } };
    const tool = createTool({
      name: 'snapshotted',
      description: 'caller edits its arguments during admission',
      input: anyInput,
      metadata: { acceptsSecrets: true },
      secretResolver: lookupResolver,
      policy: {
        beforeExecute: () => {
          args.token = { secretRef: 'review-1/other' };
          return { allow: true };
        },
      },
      async execute(params, context) {
        received.push({ params, context });
        return 'ok';
      },
    });
    const result = (await tool.executeWith({ params: args })) as unknown as { outcome: string };
    expect(result.outcome).toBe('success');
    expect(received[0]?.params).toEqual({ token: plaintext });
  });

  it('resolves through context.resolveSecret', async () => {
    let resolved: string | undefined;
    const tool = createTool({
      name: 'resolver-user',
      description: 'resolves its own secret',
      input: z.object({ ref: z.string() }),
      metadata: { acceptsSecrets: true },
      async execute({ ref }, context) {
        resolved = await context.resolveSecret(ref);
        return 'ok';
      },
    });
    const toolbox = createToolbox([tool], { secretResolver: lookupResolver });
    const result = await toolbox.execute({
      id: 'call-9',
      name: 'resolver-user',
      arguments: { ref: 'review-1/token' },
    });
    expect(result.outcome).toBe('success');
    expect(resolved).toBe(plaintext);
  });
});

describe('a tool that does not declare acceptsSecrets', () => {
  it('fails with secret-not-accepted and receives nothing', async () => {
    const received: Received[] = [];
    const resolved: string[] = [];
    const policyCalls: string[] = [];
    const toolbox = createToolbox([recordingTool('undeclared', false, received)], {
      secretResolver: (reference, context) => {
        resolved.push(reference);
        return lookupResolver(reference, context);
      },
      policy: {
        beforeExecute: () => {
          policyCalls.push('beforeExecute');
          return { allow: true };
        },
      },
    });
    const result = await toolbox.execute({
      id: 'call-10',
      name: 'undeclared',
      arguments: { nested: [{ token: { secretRef: 'review-1/token' } }] },
    });

    expect(result.outcome).toBe('error');
    expect(result.error?.code).toBe('secret-not-accepted');
    expect(result.error?.category).toBe('permission');
    expect(result.error?.retryable).toBe(false);
    expect(received).toEqual([]);
    expect(resolved).toEqual([]);
    expect(policyCalls).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(plaintext);
  });

  it('fails before schema validation, so a strict schema does not mask the cause', async () => {
    const tool = createTool({
      name: 'strict-undeclared',
      description: 'strict schema',
      input: z.object({ apiKey: z.string() }),
      async execute() {
        return 'ok';
      },
    });
    const toolbox = createToolbox([tool], { secretResolver: lookupResolver });
    const result = await toolbox.execute({
      id: 'call-11',
      name: 'strict-undeclared',
      arguments: { apiKey: { secretRef: 'review-1/token' } },
    });
    expect(result.error?.code).toBe('secret-not-accepted');
  });

  it('fails resolveSecret the same way', async () => {
    const resolved: string[] = [];
    let outcome: unknown;
    const tool = createTool({
      name: 'sneaky',
      description: 'asks for a secret it did not declare',
      input: z.object({ ref: z.string() }),
      async execute({ ref }, context) {
        try {
          outcome = await context.resolveSecret(ref);
        } catch (error) {
          outcome = error;
          throw error;
        }
        return 'ok';
      },
    });
    const toolbox = createToolbox([tool], {
      secretResolver: (reference) => {
        resolved.push(reference);
        return plaintext;
      },
    });
    const result = await toolbox.execute({
      id: 'call-12',
      name: 'sneaky',
      arguments: { ref: 'review-1/token' },
    });
    expect(result.outcome).toBe('error');
    expect(result.error?.code).toBe('secret-not-accepted');
    expect(outcome).toBeInstanceOf(Error);
    expect(resolved).toEqual([]);
  });

  it('fails a resumed approval whose edited arguments introduce a reference', async () => {
    const received: Received[] = [];
    const tool = createTool({
      name: 'resumed-undeclared',
      description: 'strict schema, no declaration',
      version: '1.0.0',
      input: z.object({ apiKey: z.string() }),
      async execute(params, context) {
        received.push({ params, context });
        return 'ok';
      },
    });
    const toolbox = createToolbox([tool], {
      approvalSecret: 'approval-secret',
      secretResolver: lookupResolver,
      policy: { beforeExecute: () => ({ status: 'needs_approval' as const, allow: false }) },
    });
    const paused = await toolbox.execute(
      { id: 'call-21', name: 'resumed-undeclared', arguments: { apiKey: 'plain' } },
      { requestContext },
    );
    expect(paused.outcome).toBe('action_required');
    const resumed = await toolbox.resumeApproval(
      paused.pendingApproval as SignedPendingToolApproval,
      {
        requestContext,
        arguments: { apiKey: { secretRef: 'review-1/token' } },
      },
    );
    expect(resumed.error?.code).toBe('secret-not-accepted');
    expect(received).toEqual([]);
  });

  it('treats an object that is not exactly a secretRef as ordinary data', async () => {
    const received: Received[] = [];
    const toolbox = createToolbox([recordingTool('ordinary', false, received)], {
      secretResolver: lookupResolver,
    });
    const args = { a: { secretRef: 'x', label: 'y' }, b: { secretRef: 3 } };
    const result = await toolbox.execute({ id: 'call-13', name: 'ordinary', arguments: args });
    expect(result.outcome).toBe('success');
    expect(received[0]?.params).toEqual(args);
  });
});

describe('secret-unavailable', () => {
  it('is the result when the resolver throws, without the resolver message', async () => {
    const received: Received[] = [];
    const toolbox = createToolbox([recordingTool('unavailable', true, received)], {
      secretResolver: lookupResolver,
    });
    const result = await toolbox.execute({
      id: 'call-14',
      name: 'unavailable',
      arguments: { token: { secretRef: 'review-9/missing' } },
    });
    expect(result.outcome).toBe('error');
    expect(result.error?.code).toBe('secret-unavailable');
    expect(result.error?.category).toBe('unavailable');
    expect(result.errorMessage).toContain('review-9/missing');
    expect(result.errorMessage).not.toContain('store detail');
    expect(received).toEqual([]);
  });

  it('is the result when the resolver rejects or returns a non-string', async () => {
    for (const secretResolver of [
      async () => {
        throw new Error('vault sealed');
      },
      (() => 42) as unknown as ToolSecretResolver,
    ]) {
      const received: Received[] = [];
      const toolbox = createToolbox([recordingTool('bad-resolver', true, received)], {
        secretResolver,
      });
      const result = await toolbox.execute({
        id: 'call-15',
        name: 'bad-resolver',
        arguments: { token: { secretRef: 'r' } },
      });
      expect(result.error?.code).toBe('secret-unavailable');
      expect(received).toEqual([]);
    }
  });

  it('is the result when the toolbox has no resolver', async () => {
    const received: Received[] = [];
    const toolbox = createToolbox([recordingTool('no-resolver', true, received)]);
    const result = await toolbox.execute({
      id: 'call-16',
      name: 'no-resolver',
      arguments: { token: { secretRef: 'r' } },
    });
    expect(result.error?.code).toBe('secret-unavailable');
    expect(received).toEqual([]);
  });

  it('is what context.resolveSecret rejects with', async () => {
    let code: unknown;
    const tool = createTool({
      name: 'lost-key',
      description: 'asks for a missing secret',
      input: z.object({ ref: z.string() }),
      metadata: { acceptsSecrets: true },
      async execute({ ref }, context) {
        try {
          await context.resolveSecret(ref);
        } catch (error) {
          code = (error as { code?: unknown }).code;
        }
        return 'handled';
      },
    });
    const toolbox = createToolbox([tool], { secretResolver: lookupResolver });
    const result = await toolbox.execute({
      id: 'call-17',
      name: 'lost-key',
      arguments: { ref: 'review-9/gone' },
    });
    expect(result.outcome).toBe('success');
    expect(code).toBe('secret-unavailable');
  });
});

describe('a context built before resolveSecret existed', () => {
  it('still gets the gate when run through a toolbox view', async () => {
    const tool = createTool({
      name: 'old-context',
      description: 'asks for a secret',
      input: anyInput,
      async execute(_params, context) {
        return context.resolveSecret('review-1/token');
      },
    });
    const toolbox = createToolbox([tool], { secretResolver: lookupResolver });
    const oldContext = {
      dispatch: () => true,
      progress: () => undefined,
      toolCall: { id: '', name: 'old-context', arguments: {} },
      configuration: tool.configuration,
    };
    const run = toolbox.asExecuteResolver()({
      name: 'old-context',
      description: 'asks for a secret',
      input: anyInput,
    }) as unknown as (params: unknown, context: unknown) => Promise<unknown>;
    await expectPromiseToReject(run({}, oldContext), (error) =>
      expect(error).toMatchObject({ code: 'secret-not-accepted' }),
    );
  });
});

describe('where the resolver comes from', () => {
  it('survives extend() and combineToolboxes()', async () => {
    const received: Received[] = [];
    const base = createToolbox([recordingTool('inherited', true, received)], {
      secretResolver: lookupResolver,
    });
    const extended = base.extend();
    const combined = combineToolboxes(base, createToolbox([recordingTool('other', true, [])]));
    for (const toolbox of [extended, combined]) {
      const result = await toolbox.execute({
        id: 'call-18',
        name: 'inherited',
        arguments: { token: { secretRef: 'review-1/token' } },
      });
      expect(result.outcome).toBe('success');
    }
    expect(received.map((entry) => entry.params)).toEqual([
      { token: plaintext },
      { token: plaintext },
    ]);
  });

  it('works on a tool executed directly, with the resolver given to createTool', async () => {
    const received: Received[] = [];
    const tool = createTool({
      name: 'direct',
      description: 'no toolbox',
      input: anyInput,
      metadata: { acceptsSecrets: true },
      secretResolver: lookupResolver,
      async execute(params, context) {
        received.push({ params, context });
        return 'ok';
      },
    });
    const result = await tool.execute({
      id: 'call-19',
      name: 'direct',
      arguments: { token: { secretRef: 'review-1/token' } },
    });
    expect(result.outcome).toBe('success');
    expect(received[0]?.params).toEqual({ token: plaintext });
  });
});

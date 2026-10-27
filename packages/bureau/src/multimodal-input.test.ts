/**
 * COR-716 — media through Bureau: a managed asset in a run's input resolves as the
 * run's owner, the transcript keeps the asset's identity, and an input another
 * principal may not read is refused typed before any provider call.
 */
import {
  createAgent,
  createModelCatalog,
  type GenerateContext,
  type GuardrailsOptions,
  MediaAdmissionError,
  stopWhen,
  withBackendDescriptors,
} from '@lostgradient/operative';
import { MemoryStorage, yieldToPortableEventLoop } from '@lostgradient/weft';
import { createTool, createToolbox } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';
import type { MediaContent } from 'conversationalist';
import { z } from 'zod';

import type { AgentDefinitions } from './agent-catalog';
import { createBureau } from './create-bureau';
import { createMemoryAssetStorageFixture } from './test/asset-storage-fixtures';
import { alice, base64Of, bob, pngBytes } from './testing/asset-fixtures.test-support';
import type { Bureau } from './types';
import { runTask } from './test';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

const anthropicDescriptors = createModelCatalog().descriptors.filter(
  (descriptor) => descriptor.provider === 'anthropic',
);

function deferred<T = void>() {
  let release!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    release = resolve;
  });
  return { promise, resolve: release };
}

/** Records every step's context, and ends the run at its first step unless told to keep going. */
function recordingGenerate(seen: GenerateContext[], hold?: Promise<void>) {
  return withBackendDescriptors(async (context: GenerateContext) => {
    seen.push(context);
    if (hold !== undefined && context.step === 0) await hold;
    return { content: 'ok', toolCalls: [] };
  }, anthropicDescriptors);
}

async function admitImage(bureau: Bureau, owner: { readonly id: string } = alice) {
  const fixtureBytes = pngBytes(4, 3);
  const admission = await bureau.assets!.admit(
    { source: { kind: 'inline', bytes: fixtureBytes }, declaredMediaType: 'image/png' },
    owner,
  );
  await admission.work.result();
  return { source: admission.source, bytes: fixtureBytes };
}

async function openBureau(
  options: Partial<Parameters<typeof createBureau>[0]> & {
    seen: GenerateContext[];
    /** The `echo` agent's own guardrails. */
    guardrails?: GuardrailsOptions;
  },
) {
  const { seen, guardrails, ...rest } = options;
  const fixture = createMemoryAssetStorageFixture({});
  cleanups.push(() => fixture.dispose());
  const bureau = await createBureau({
    agents: {
      echo: createAgent({
        generate: recordingGenerate(seen),
        ...(guardrails === undefined ? {} : { guardrails }),
      }),
    },
    assets: { storage: fixture.storage },
    ...rest,
  });
  cleanups.push(async () => {
    await bureau.dispose();
  });
  return bureau;
}

describe('bureau.run with a managed asset in the input (COR-716)', () => {
  it('resolves the asset as the run principal, hands generate the bytes, and keeps the stored identity', async () => {
    const seen: GenerateContext[] = [];
    const bureau = await openBureau({ seen });
    const { source, bytes } = await admitImage(bureau);
    const parts: MediaContent[] = [{ type: 'image', source }];

    const result = await runTask(bureau, 'echo', parts, { principal: alice.id });

    expect(result.finishReason).not.toBe('error');
    const context = seen[0]!;
    const user = context.conversation.getMessages().find((message) => message.role === 'user');
    // The transcript keeps the asset's identity and revision, not the bytes.
    expect(user?.content).toEqual(parts);
    expect([...(context.resolvedSources ?? [])]).toEqual([
      [
        `${user!.id}:0`,
        expect.objectContaining({
          outcome: 'resolved',
          source: { kind: 'inline', data: base64Of(bytes), encoding: 'base64' },
          mimeType: 'image/png',
        }),
      ],
    ]);
  });

  it('refuses the step typed, before generate, when the principal may not read the asset', async () => {
    const seen: GenerateContext[] = [];
    const bureau = await openBureau({ seen });
    const { source } = await admitImage(bureau);

    const result = await runTask(bureau, 'echo', [{ type: 'image', source }], {
      principal: bob.id,
    });

    expect(result.finishReason).toBe('error');
    expect(result.error).toBeInstanceOf(MediaAdmissionError);
    expect(seen).toHaveLength(0);
  });

  it('applies the bureau’s unverified-asset policy: an asset no safety gate inspected is blocked', async () => {
    const seen: GenerateContext[] = [];
    const bureau = await openBureau({
      seen,
      guardrails: { input: { detectors: [], assetSafety: { unknown: 'block' } } },
    });
    const { source } = await admitImage(bureau);

    const blocked = await runTask(bureau, 'echo', [{ type: 'image', source }], {
      principal: alice.id,
    });

    // Admission applies the policy at the step boundary, before the guardrail
    // runs: the run ends as a typed policy error and generate is never called.
    expect(blocked.finishReason).toBe('error');
    expect(blocked.error).toBeInstanceOf(MediaAdmissionError);
    expect((blocked.error as MediaAdmissionError).outcomes[0]).toMatchObject({
      reason: 'asset-unverified',
    });
    expect(seen).toHaveLength(0);
  });

  it('admits the same asset when the bureau’s policy allows unverified assets', async () => {
    const seen: GenerateContext[] = [];
    const bureau = await openBureau({
      seen,
      guardrails: { input: { detectors: [], assetSafety: { unknown: 'allow' } } },
    });
    const { source } = await admitImage(bureau);

    const result = await runTask(bureau, 'echo', [{ type: 'image', source }], {
      principal: alice.id,
    });

    expect(result.finishReason).not.toBe('error');
    expect(seen).toHaveLength(1);
  });

  it('refuses the step typed when the bureau has no asset service to resolve with', async () => {
    const seen: GenerateContext[] = [];
    const bureau = await createBureau({
      agents: { echo: createAgent({ generate: recordingGenerate(seen) }) },
    });
    cleanups.push(async () => {
      await bureau.dispose();
    });

    const result = await runTask(bureau, 'echo', [
      { type: 'image', source: { kind: 'managed-asset', assetId: 'a' } },
    ]);

    expect(result.error).toBeInstanceOf(MediaAdmissionError);
    expect(seen).toHaveLength(0);
  });
});

describe('bureau.run takes its input as it was when called (COR-716)', () => {
  for (const durable of [false, true]) {
    it(`${durable ? 'durable' : 'direct'}: a caller editing its array after the call does not reach the run`, async () => {
      const seen: GenerateContext[] = [];
      const bureau = await createBureau({
        agents: { echo: createAgent({ generate: recordingGenerate(seen) }) },
        ...(durable ? { storage: { type: 'memory' as const }, durable: true } : {}),
      });
      cleanups.push(async () => {
        await bureau.dispose();
      });
      const parts: Array<{ type: 'text'; text: string }> = [{ type: 'text', text: 'as submitted' }];

      const run = await bureau.tasks.start('echo', parts);
      parts[0]!.text = 'mutated';
      parts.push({ type: 'text', text: 'appended' });
      await run.result();

      const user = seen[0]?.conversation.getMessages().find((message) => message.role === 'user');
      expect(user?.content).toEqual([{ type: 'text', text: 'as submitted' }]);
    });
  }
});

describe('session input carrying a managed asset (COR-716)', () => {
  it('resolves the asset at the step boundary that delivers it, as the run owner', async () => {
    const seen: GenerateContext[] = [];
    const stepZeroStarted = deferred();
    const releaseStepZero = deferred();
    const fixture = createMemoryAssetStorageFixture({});
    cleanups.push(() => fixture.dispose());
    const bureau = await createBureau<AgentDefinitions>({
      agents: {
        default: createAgent({
          generate: withBackendDescriptors(async (context: GenerateContext) => {
            seen.push(context);
            if (context.step === 0) {
              stepZeroStarted.resolve();
              await releaseStepZero.promise;
              return { content: 'working', toolCalls: [{ name: 'next', arguments: {} }] };
            }
            return { content: 'done', toolCalls: [] };
          }, anthropicDescriptors),
          toolbox: createToolbox([nextTool()]),
          stopWhen: stopWhen.noToolCalls(),
        }),
      },
      storage: { type: 'memory' },
      durable: true,
      assets: { storage: fixture.storage },
    });
    cleanups.push(async () => {
      releaseStepZero.resolve();
      await bureau.dispose();
    });

    const run = await bureau.tasks.start('default', 'Start', { principal: alice.id });
    await stepZeroStarted.promise;
    const { source, bytes } = await admitImage(bureau);
    const payload = [
      { type: 'text', text: 'look at this' },
      { type: 'image', source },
    ] as const;
    const admitted = await bureau.contexts.input(run.contextId, {
      id: 'input-a',
      principal: alice.id,
      deliveryMode: 'steer',
      payload,
    });
    expect(admitted.outcome).toBe('admitted');

    releaseStepZero.resolve();
    await bureau.tasks.wait(run.id);
    await yieldToPortableEventLoop();

    const step = seen.find((context) => context.step === 1)!;
    const delivered = step.conversation
      .getMessages()
      .find((message) => Array.isArray(message.content));
    expect(delivered?.content).toEqual(payload);
    expect([...(step.resolvedSources ?? [])]).toEqual([
      [
        `${delivered!.id}:1`,
        expect.objectContaining({
          outcome: 'resolved',
          source: { kind: 'inline', data: base64Of(bytes), encoding: 'base64' },
        }),
      ],
    ]);
  });

  it('does the same on a session run of a named catalog agent, under the bureau’s unverified-asset policy (COR-1577)', async () => {
    const seen: GenerateContext[] = [];
    const stepZeroStarted = deferred();
    const releaseStepZero = deferred();
    const fixture = createMemoryAssetStorageFixture({});
    cleanups.push(() => fixture.dispose());
    const agentGenerate = withBackendDescriptors(async (context: GenerateContext) => {
      seen.push(context);
      if (context.step === 0) {
        stepZeroStarted.resolve();
        await releaseStepZero.promise;
        return { content: 'working', toolCalls: [{ name: 'next', arguments: {} }] };
      }
      return { content: 'done', toolCalls: [] };
    }, anthropicDescriptors);
    const bureau = await createBureau<AgentDefinitions>({
      agents: {
        echo: createAgent({
          generate: agentGenerate,
          toolbox: createToolbox([nextTool()]),
          stopWhen: stopWhen.noToolCalls(),
          guardrails: { input: { detectors: [], assetSafety: { unknown: 'allow' } } },
        }),
      },
      storage: { type: 'memory' },
      durable: true,
      assets: { storage: fixture.storage },
    });
    cleanups.push(async () => {
      releaseStepZero.resolve();
      await bureau.dispose();
    });

    const run = await bureau.tasks.start('echo', 'Start', { principal: alice.id });
    await stepZeroStarted.promise;
    const { source, bytes } = await admitImage(bureau);
    const payload = [{ type: 'image', source }] as const;
    const admitted = await bureau.contexts.input(run.contextId, {
      id: 'input-named',
      principal: alice.id,
      deliveryMode: 'steer',
      payload,
    });
    expect(admitted.outcome).toBe('admitted');
    releaseStepZero.resolve();
    await bureau.tasks.wait(run.id);
    await yieldToPortableEventLoop();

    const step = seen.find((context) => context.step === 1)!;
    // The resolver reached the named agent's run, resolving as the run's owner.
    expect([...(step.resolvedSources ?? [])]).toEqual([
      [
        expect.any(String),
        expect.objectContaining({
          outcome: 'resolved',
          source: { kind: 'inline', data: base64Of(bytes), encoding: 'base64' },
        }),
      ],
    ]);
  });

  it('delivers the payload as it was submitted, not as the caller edits its array afterward', async () => {
    const seen: GenerateContext[] = [];
    const stepZeroStarted = deferred();
    const releaseStepZero = deferred();
    const bureau = await createBureau<AgentDefinitions>({
      agents: {
        default: createAgent({
          generate: withBackendDescriptors(async (context: GenerateContext) => {
            seen.push(context);
            if (context.step === 0) {
              stepZeroStarted.resolve();
              await releaseStepZero.promise;
              return { content: 'working', toolCalls: [{ name: 'next', arguments: {} }] };
            }
            return { content: 'done', toolCalls: [] };
          }, anthropicDescriptors),
          toolbox: createToolbox([nextTool()]),
          stopWhen: stopWhen.noToolCalls(),
        }),
      },
      storage: { type: 'memory' },
      durable: true,
    });
    cleanups.push(async () => {
      releaseStepZero.resolve();
      await bureau.dispose();
    });
    const run = await bureau.tasks.start('default', 'Start', { principal: alice.id });
    await stepZeroStarted.promise;
    const payload: Array<{ type: 'text'; text: string }> = [{ type: 'text', text: 'as submitted' }];

    const pending = bureau.contexts.input(run.contextId, {
      id: 'input-snapshot',
      principal: alice.id,
      deliveryMode: 'steer',
      payload,
    });
    // The caller keeps its array and edits it as soon as the call returns.
    payload[0]!.text = 'mutated';
    payload.push({ type: 'text', text: 'appended' });
    const admitted = await pending;
    expect(admitted.outcome).toBe('admitted');

    releaseStepZero.resolve();
    await bureau.tasks.wait(run.id);

    const step = seen.find((context) => context.step === 1)!;
    const delivered = step.conversation
      .getMessages()
      .find((message) => Array.isArray(message.content));
    expect(delivered?.content).toEqual([{ type: 'text', text: 'as submitted' }]);
  });

  it('refuses a malformed payload at the door instead of storing input no run could read', async () => {
    const seen: GenerateContext[] = [];
    const hold = deferred();
    const bureau = await createBureau<AgentDefinitions>({
      agents: {
        default: createAgent({ generate: recordingGenerate(seen, hold.promise) }),
      },
      storage: { type: 'memory' },
      durable: true,
    });
    cleanups.push(async () => {
      hold.resolve();
      await bureau.dispose();
    });
    const run = await bureau.tasks.start('default', 'Start', { principal: alice.id });
    await yieldToPortableEventLoop();

    for (const payload of [
      [],
      [{ type: 'image' }],
      [{ type: 'thinking', thinking: 'x', signature: 's' }],
    ]) {
      let thrown: unknown;
      try {
        await bureau.contexts.input(run.contextId, {
          id: `input-${JSON.stringify(payload).length}`,
          principal: alice.id,
          deliveryMode: 'steer',
          payload: payload as never,
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toMatchObject({ code: 'BAD_REQUEST' });
    }
  });
});

describe('the asset service is ready before the scheduler can fire (COR-716)', () => {
  it('touches the asset storage before the engine storage, so no fire finds no resolver', async () => {
    const order: Array<'assets' | 'engine'> = [];
    const spy = <T extends object>(name: 'assets' | 'engine', target: T): T =>
      new Proxy(target, {
        get(object, property, receiver) {
          const value: unknown = Reflect.get(object, property, receiver);
          if (typeof value !== 'function' || typeof property !== 'string') return value;
          return (...args: unknown[]) => {
            order.push(name);
            return (value as (...parameters: unknown[]) => unknown).apply(object, args);
          };
        },
      });
    const fixture = createMemoryAssetStorageFixture({});
    cleanups.push(() => fixture.dispose());
    const bureau = await createBureau<AgentDefinitions>({
      agents: {
        default: createAgent({ generate: recordingGenerate([]), toolbox: createToolbox([]) }),
      },
      storage: spy('engine', new MemoryStorage()),
      durable: true,
      assets: { storage: spy('assets', fixture.storage) },
    });
    cleanups.push(async () => {
      await bureau.dispose();
    });

    expect(order.indexOf('assets')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('engine')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('assets')).toBeLessThan(order.indexOf('engine'));
  });
});

const nextTool = () =>
  createTool({
    name: 'next',
    description: 'continue',
    input: z.object({}),
    execute: async () => 'ok',
  });

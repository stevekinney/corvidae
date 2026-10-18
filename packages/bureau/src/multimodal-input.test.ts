/**
 * COR-716 — media through Bureau: a managed asset in a run's input resolves as the
 * run's owner, the transcript keeps the asset's identity, and an input another
 * principal may not read is refused typed before any provider call.
 */
import {
  createAgent,
  createModelCatalog,
  type GenerateContext,
  MediaAdmissionError,
  stopWhen,
  withBackendDescriptors,
} from '@lostgradient/operative';
import { MemoryStorage, yieldToPortableEventLoop } from '@lostgradient/weft';
import { createTool, createToolbox } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';
import type { MediaContent } from 'conversationalist';
import { z } from 'zod';

import { createBureau } from './create-bureau';
import { createMemoryAssetStorageFixture } from './test/asset-storage-fixtures';
import { alice, base64Of, bob, pngBytes } from './testing/asset-fixtures.test-support';
import type { Bureau } from './types';

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
  options: Partial<Parameters<typeof createBureau>[0]> & { seen: GenerateContext[] },
) {
  const { seen, ...rest } = options;
  const fixture = createMemoryAssetStorageFixture({});
  cleanups.push(() => fixture.dispose());
  const bureau = await createBureau({
    agents: { echo: createAgent({ generate: recordingGenerate(seen) }) },
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

    const result = await bureau.run('echo', parts, { principal: alice.id }).result();

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

    const result = await bureau
      .run('echo', [{ type: 'image', source }], { principal: bob.id })
      .result();

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

    const blocked = await bureau
      .run('echo', [{ type: 'image', source }], { principal: alice.id })
      .result();

    expect(blocked.content).toContain('blocked');
    expect(seen).toHaveLength(0);
  });

  it('admits the same asset when the bureau’s policy allows unverified assets', async () => {
    const seen: GenerateContext[] = [];
    const bureau = await openBureau({
      seen,
      guardrails: { input: { detectors: [], assetSafety: { unknown: 'allow' } } },
    });
    const { source } = await admitImage(bureau);

    const result = await bureau
      .run('echo', [{ type: 'image', source }], { principal: alice.id })
      .result();

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

    const result = await bureau
      .run('echo', [{ type: 'image', source: { kind: 'managed-asset', assetId: 'a' } }])
      .result();

    expect(result.error).toBeInstanceOf(MediaAdmissionError);
    expect(seen).toHaveLength(0);
  });
});

describe('session input carrying a managed asset (COR-716)', () => {
  it('resolves the asset at the step boundary that delivers it, as the run owner', async () => {
    const seen: GenerateContext[] = [];
    const stepZeroStarted = deferred();
    const releaseStepZero = deferred();
    const fixture = createMemoryAssetStorageFixture({});
    cleanups.push(() => fixture.dispose());
    const bureau = await createBureau({
      agents: {},
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
      storage: { type: 'memory' },
      durableExecution: true,
      assets: { storage: fixture.storage },
      stopWhen: stopWhen.noToolCalls(),
    });
    cleanups.push(async () => {
      releaseStepZero.resolve();
      await bureau.dispose();
    });

    const run = await bureau.createRun({ message: 'Start', principal: alice.id });
    await stepZeroStarted.promise;
    const { source, bytes } = await admitImage(bureau);
    const payload = [
      { type: 'text', text: 'look at this' },
      { type: 'image', source },
    ] as const;
    const admitted = await bureau.submitSessionInput(run.sessionId, {
      id: 'input-a',
      principal: alice.id,
      deliveryMode: 'steer',
      payload,
    });
    expect(admitted.outcome).toBe('admitted');

    releaseStepZero.resolve();
    await bureau.waitForDurableRun(run.id);
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

  it('refuses a malformed payload at the door instead of storing input no run could read', async () => {
    const seen: GenerateContext[] = [];
    const hold = deferred();
    const bureau = await createBureau({
      agents: {},
      generate: recordingGenerate(seen, hold.promise),
      storage: { type: 'memory' },
      durableExecution: true,
    });
    cleanups.push(async () => {
      hold.resolve();
      await bureau.dispose();
    });
    const run = await bureau.createRun({ message: 'Start', principal: alice.id });
    await yieldToPortableEventLoop();

    for (const payload of [
      [],
      [{ type: 'image' }],
      [{ type: 'thinking', thinking: 'x', signature: 's' }],
    ]) {
      let thrown: unknown;
      try {
        await bureau.submitSessionInput(run.sessionId, {
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
    const bureau = await createBureau({
      agents: {},
      generate: recordingGenerate([]),
      toolbox: createToolbox([]),
      storage: spy('engine', new MemoryStorage()),
      durableExecution: true,
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

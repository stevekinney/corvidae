/**
 * COR-1581 — a run with no session holds the managed assets its own rows reference. The asset
 * policy's retention floor would otherwise expire a supplied input image, or a generated one, while
 * the run (or its stored transcript) still points at it. A catalog dispatch (`bureau.run()`, a child,
 * a goal attempt) never has a session, whether or not the store registers it, so each claims under a
 * holder keyed by its own run id and the row.
 */
import { createManualRuntimeServices, type ManualRuntimeServices } from '@lostgradient/lifecycle';
import {
  createAgent,
  createModelCatalog,
  type GenerateContext,
  stopWhen,
  waitForCondition,
  waitForRunState,
  withBackendDescriptors,
} from '@lostgradient/operative';
import { yieldToPortableEventLoop } from '@lostgradient/weft';
import { afterEach, describe, expect, it } from 'bun:test';
import type { MediaContent } from 'conversationalist';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runRowHolderId } from './assets/row-asset-claims';
import { createBureau } from './create-bureau';
import { createMemoryAssetStorageFixture } from './test/asset-storage-fixtures';
import {
  alice,
  aliceAdministrator,
  base64Of,
  pngBytes,
} from './testing/asset-fixtures.test-support';
import type { Bureau } from './types';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
  await yieldToPortableEventLoop();
});

const FLOOR_MILLISECONDS = 1_000;
const PAST_THE_FLOOR = 5_000;

const anthropicDescriptors = createModelCatalog().descriptors.filter(
  (descriptor) => descriptor.provider === 'anthropic',
);
const imageOutputDescriptors = anthropicDescriptors.slice(0, 1).map((descriptor) => ({
  ...descriptor,
  modalities: {
    ...descriptor.modalities,
    image: { ...descriptor.modalities.image, output: true },
  },
}));

const png = pngBytes(4, 3);

/** An agent that reads its input, holds its first step until released, and answers with text. */
function viewer(seen: GenerateContext[], hold?: Promise<void>) {
  return createAgent({
    generate: withBackendDescriptors(async (context: GenerateContext) => {
      seen.push(context);
      if (hold !== undefined && context.step === 0) await hold;
      return { content: 'seen', toolCalls: [] };
    }, anthropicDescriptors),
    stopWhen: stopWhen.noToolCalls(),
  });
}

/** An agent that answers with a generated image. */
const painter = createAgent({
  generate: withBackendDescriptors(
    async () => ({
      content: '',
      parts: [
        {
          type: 'image' as const,
          mimeType: 'image/png',
          source: { kind: 'inline' as const, data: base64Of(png), encoding: 'base64' as const },
        },
      ],
      toolCalls: [],
    }),
    imageOutputDescriptors,
  ),
  stopWhen: stopWhen.noToolCalls(),
});

function release() {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { gate, open };
}

interface Environment {
  readonly runtime: ManualRuntimeServices;
  readonly fixture: ReturnType<typeof createMemoryAssetStorageFixture>;
}

function createEnvironment(): Environment {
  const fixture = createMemoryAssetStorageFixture({});
  cleanups.push(() => fixture.dispose());
  return {
    runtime: createManualRuntimeServices({ origin: '2026-10-18T00:00:00.000Z' }),
    fixture,
  };
}

async function openBureau(
  environment: Environment,
  agents: Parameters<typeof createBureau>[0]['agents'],
  extra: Partial<Parameters<typeof createBureau>[0]> = {},
): Promise<Bureau> {
  const bureau = await createBureau({
    agents,
    runtime: environment.runtime,
    assets: {
      storage: environment.fixture.storage,
      policy: { defaultRetentionMilliseconds: FLOOR_MILLISECONDS },
    },
    ...extra,
  });
  cleanups.push(async () => {
    await bureau.dispose();
  });
  return bureau;
}

async function suppliedImage(bureau: Bureau): Promise<MediaContent> {
  const admission = await bureau.assets!.admit(
    { source: { kind: 'inline', bytes: png }, declaredMediaType: 'image/png' },
    alice,
  );
  await admission.work.result();
  return { type: 'image', source: admission.source };
}

function assetIdOf(part: MediaContent): string {
  if (part.source.kind !== 'managed-asset') throw new Error('expected a managed asset');
  return part.source.assetId;
}

async function pastTheFloor(environment: Environment, bureau: Bureau) {
  await environment.runtime.advance(PAST_THE_FLOOR);
  const collected = await bureau.assets!.collectGarbage().result();
  if (collected.outcome !== 'completed') throw new Error(`collection ${collected.outcome}`);
  return collected.value;
}

async function resolves(bureau: Bureau, assetId: string): Promise<boolean> {
  try {
    await bureau.assets!.resolve({ kind: 'managed-asset', assetId }, alice);
    return true;
  } catch {
    return false;
  }
}

/** The holders that claim an asset, read through the privileged projection. */
async function holdersOf(bureau: Bureau, assetId: string): Promise<string[]> {
  const descriptor = await bureau.assets!.inspect(assetId, aliceAdministrator, {
    projection: 'privileged',
  });
  if (descriptor.projection !== 'privileged') throw new Error('expected the privileged projection');
  return descriptor.retention.references.map((reference) => reference.holderId);
}

function runRowPrefix(runId: string): string {
  return runRowHolderId(runId, '').slice(0, -1);
}

describe.each([
  ['a durable engine', { storage: { type: 'memory' as const }, durableExecution: true }],
  ['no durable engine (the in-process path)', {}],
] as const)('a sessionless bureau.run() with a supplied image, on %s', (_name, extra) => {
  it('keeps the input asset resolvable while the run is parked past the retention floor', async () => {
    const environment = createEnvironment();
    const seen: GenerateContext[] = [];
    const parked = release();
    const bureau = await openBureau(environment, { viewer: viewer(seen, parked.gate) }, extra);
    const image = await suppliedImage(bureau);
    const assetId = assetIdOf(image);

    const run = bureau.run('viewer', [image], { principal: alice.id });
    await waitForCondition(() => seen.length > 0, 'the run never reached its first step');

    const report = await pastTheFloor(environment, bureau);

    expect(report.expired).not.toContain(assetId);
    expect(await resolves(bureau, assetId)).toBe(true);
    expect(await holdersOf(bureau, assetId)).toEqual([
      expect.stringContaining(runRowPrefix(run.id)),
    ]);

    parked.open();
    const result = await run.result();
    expect(result.finishReason).not.toBe('error');
    expect(await resolves(bureau, assetId)).toBe(true);
  });

  it('still resolves the input asset after the run has finished and the floor has passed', async () => {
    const environment = createEnvironment();
    const bureau = await openBureau(environment, { viewer: viewer([]) }, extra);
    const image = await suppliedImage(bureau);

    await bureau.run('viewer', [image], { principal: alice.id }).result();
    await pastTheFloor(environment, bureau);

    expect(await resolves(bureau, assetIdOf(image))).toBe(true);
  });

  it('is expired by the floor when no run referenced it', async () => {
    const environment = createEnvironment();
    const bureau = await openBureau(environment, { viewer: viewer([]) }, extra);
    const image = await suppliedImage(bureau);

    const report = await pastTheFloor(environment, bureau);

    expect(report.expired).toContain(assetIdOf(image));
  });
});

describe('a sessionless bureau.run() across a restart', () => {
  it('keeps the input asset resolvable after a new Bureau opens the same storage past the floor', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bureau-sessionless-retention-'));
    cleanups.push(async () => {
      await rm(directory, { recursive: true, force: true });
    });
    const environment = createEnvironment();
    const storage = { type: 'sqlite' as const, path: join(directory, 'bureau') };
    const seen: GenerateContext[] = [];

    const first = await openBureau(
      environment,
      { viewer: viewer(seen, new Promise<void>(() => {})) },
      { storage, durableExecution: true },
    );
    const image = await suppliedImage(first);
    first.run('viewer', [image], { principal: alice.id });
    await waitForCondition(() => seen.length > 0, 'the run never reached its first step');
    await first.dispose();

    const second = await openBureau(
      environment,
      { viewer: viewer([]) },
      { storage, durableExecution: true },
    );
    const report = await pastTheFloor(environment, second);

    expect(report.expired).not.toContain(assetIdOf(image));
    expect(await resolves(second, assetIdOf(image))).toBe(true);
  });
});

describe('a child run', () => {
  async function bureauWithParent(
    environment: Environment,
    agents: Parameters<typeof createBureau>[0]['agents'],
  ) {
    const bureau = await openBureau(environment, agents, {
      // The parent never answers, but stops when it is aborted, as a provider call does.
      generate: ({ signal }) =>
        new Promise<never>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
    });
    const parent = await bureau.createRun({ message: 'plan the work', principal: alice.id });
    cleanups.push(async () => {
      bureau.abortRun(parent.id);
      await waitForRunState(bureau, parent.id);
    });
    return { bureau, parent };
  }

  it('claims its supplied input under its own run-row holder', async () => {
    const environment = createEnvironment();
    const { bureau, parent } = await bureauWithParent(environment, { viewer: viewer([]) });
    const image = await suppliedImage(bureau);

    const dispatched = await bureau.children.dispatch({
      parentRunId: parent.id,
      agentName: 'viewer',
      input: [image],
      principal: alice.id,
    });
    if (dispatched.outcome !== 'started') throw new Error('expected a started child');
    const reference = { parentRunId: parent.id, childRunId: dispatched.child.childRunId };
    await bureau.children.wait(reference);

    const report = await pastTheFloor(environment, bureau);

    expect(await holdersOf(bureau, assetIdOf(image))).toEqual([
      expect.stringContaining(runRowPrefix(reference.childRunId)),
    ]);
    expect(report.expired).not.toContain(assetIdOf(image));
    expect(await resolves(bureau, assetIdOf(image))).toBe(true);
  });

  it('claims the image it generates, so the image survives collection past the floor', async () => {
    const environment = createEnvironment();
    const { bureau, parent } = await bureauWithParent(environment, { painter });

    const dispatched = await bureau.children.dispatch({
      parentRunId: parent.id,
      agentName: 'painter',
      input: 'Draw',
      principal: alice.id,
    });
    if (dispatched.outcome !== 'started') throw new Error('expected a started child');
    const settled = await bureau.children.wait({
      parentRunId: parent.id,
      childRunId: dispatched.child.childRunId,
    });
    const part =
      settled.outcome === 'settled'
        ? settled.child.outcome?.parts?.find((candidate) => candidate.type === 'image')
        : undefined;
    if (part === undefined || part.type !== 'image')
      throw new Error('the child generated no image');
    const assetId = assetIdOf(part);

    const report = await pastTheFloor(environment, bureau);

    expect(report.expired).not.toContain(assetId);
    expect(await resolves(bureau, assetId)).toBe(true);
    expect(await holdersOf(bureau, assetId)).toEqual([
      expect.stringContaining(runRowPrefix(dispatched.child.childRunId)),
    ]);
  });
});

describe.each([
  ['a durable engine', { storage: { type: 'memory' as const }, durableExecution: true }],
  ['no durable engine (the in-process path)', {}],
] as const)('a generated image from a sessionless bureau.run(), on %s', (_name, extra) => {
  it('still resolves after collection past the retention floor, because the commit claims it under the run', async () => {
    const environment = createEnvironment();
    const bureau = await openBureau(environment, { painter }, extra);

    const run = bureau.run('painter', 'Draw', { principal: alice.id });
    const result = await run.result();
    await run.closed();
    const image = result.parts.find((part) => part.type === 'image');
    if (image === undefined || image.type !== 'image')
      throw new Error('the run generated no image');
    const assetId = assetIdOf(image);

    const report = await pastTheFloor(environment, bureau);

    expect(report.expired).not.toContain(assetId);
    expect(await resolves(bureau, assetId)).toBe(true);
    expect(await holdersOf(bureau, assetId)).toEqual([
      expect.stringContaining(runRowPrefix(run.id)),
    ]);
  });
});

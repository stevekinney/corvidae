/**
 * COR-1581 — a run with no session holds the managed assets its own rows reference. The asset
 * policy's retention floor would otherwise expire a supplied input image, or a generated one, while
 * the run (or its stored transcript) still points at it. A catalog dispatch (a child, a goal
 * attempt, a workflow step) never has a session, whether or not the store registers it, so each
 * claims under a holder keyed by its own run id and the row. A task always has a context, which
 * holds its rows instead. The claims are released when the run ends (COR-1630;
 * see `catalog-run-asset-claims.test.ts`), so these tests hold the run in flight to show the claim
 * and let it end to show the asset fall back to the retention floor.
 */
import { createManualRuntimeServices, type ManualRuntimeServices } from '@lostgradient/lifecycle';
import {
  createAgent,
  createModelCatalog,
  type GenerateContext,
  stopWhen,
  waitForCondition,
  withBackendDescriptors,
} from '@lostgradient/operative';
import { waitForTaskState } from './test';
import { yieldToPortableEventLoop } from '@lostgradient/weft';
import { afterEach, describe, expect, it } from 'bun:test';
import type { MediaContent } from 'conversationalist';

import { runRowHolderId } from './assets/row-asset-claims';
import { createBureau } from './create-bureau';
import { createMemoryAssetStorageFixture } from './test/asset-storage-fixtures';
import { createSqliteStorageFixture } from './test/storage-fixtures';
import {
  alice,
  aliceAdministrator,
  base64Of,
  pngBytes,
} from './testing/asset-fixtures.test-support';
import type { Bureau } from './types';
import { MemoryStorage } from '@lostgradient/storage';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
  // load-proof: the work this lets finish runs on in-memory storage and doubles and settles through promise continuations only, so a microtask drain completes it (checked by replacing the turn with one); no timer or I/O is pending
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
      if (hold !== undefined && context.step === 0) {
        // Held until released, but stops when the run is aborted, as a provider call does.
        await new Promise<void>((resolve, reject) => {
          context.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
          void hold.then(resolve);
        });
      }
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
  agents: NonNullable<Parameters<typeof createBureau>[0]['agents']>,
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

/** The claims taken and let go under any `run-row` holder, in order, as the asset service reports them. */
function watchRunRowClaims(bureau: Bureau) {
  const events: Array<{
    type: 'asset.retained' | 'asset.released';
    assetId: string;
    holderId: string;
  }> = [];
  const unsubscribe = bureau.assets!.subscribe((event) => {
    const { assetId, holderId } = event;
    if (
      (event.type === 'asset.retained' || event.type === 'asset.released') &&
      assetId !== undefined &&
      holderId?.startsWith('run-row:') === true
    ) {
      events.push({ type: event.type, assetId, holderId });
    }
  });
  cleanups.push(async () => unsubscribe());
  return events;
}

/** Whether nothing holds the asset any more. */
async function isUnheld(bureau: Bureau, assetId: string): Promise<boolean> {
  const holders = await holdersOf(bureau, assetId);
  return holders.length === 0;
}

function runRowPrefix(runId: string): string {
  return runRowHolderId(runId, '').slice(0, -1);
}

describe('a task with a supplied image, on a durable engine', () => {
  const extra = { storage: new MemoryStorage(), durable: true };

  it('keeps the input asset resolvable while the task is parked past the retention floor, held by its context', async () => {
    const environment = createEnvironment();
    const seen: GenerateContext[] = [];
    const parked = release();
    const bureau = await openBureau(environment, { viewer: viewer(seen, parked.gate) }, extra);
    const image = await suppliedImage(bureau);
    const assetId = assetIdOf(image);

    const run = await bureau.tasks.start('viewer', [image], { principal: alice.id });
    await waitForCondition(() => seen.length > 0, 'the task never reached its first step');

    const report = await pastTheFloor(environment, bureau);

    expect(report.expired).not.toContain(assetId);
    expect(await resolves(bureau, assetId)).toBe(true);
    // A task runs in a context, so the context's row holds the image, not a run-row holder.
    expect(await holdersOf(bureau, assetId)).toEqual([
      expect.stringContaining(`session-row:${run.contextId}:`),
    ]);

    parked.open();
    const result = await run.result();
    expect(result.finishReason).not.toBe('error');
    expect(await resolves(bureau, assetId)).toBe(true);
  });
});

describe('a task with a supplied image, on no durable engine (the in-process path)', () => {
  it('keeps the input asset resolvable while the task is parked past the retention floor, and lets it go when the task ends', async () => {
    const environment = createEnvironment();
    const seen: GenerateContext[] = [];
    const parked = release();
    const bureau = await openBureau(environment, { viewer: viewer(seen, parked.gate) });
    const image = await suppliedImage(bureau);
    const assetId = assetIdOf(image);

    const run = await bureau.tasks.start('viewer', [image], { principal: alice.id });
    await waitForCondition(() => seen.length > 0, 'the task never reached its first step');

    const report = await pastTheFloor(environment, bureau);

    expect(report.expired).not.toContain(assetId);
    expect(await resolves(bureau, assetId)).toBe(true);
    // No session store saves the context's rows here, so the task holds its input under its run.
    expect(await holdersOf(bureau, assetId)).toEqual([
      expect.stringContaining(runRowPrefix(run.id)),
    ]);

    parked.open();
    const result = await run.result();
    expect(result.finishReason).not.toBe('error');
    // Held for the task's life only: its end lets the claim go, and the floor then expires it.
    await waitForCondition(
      () => isUnheld(bureau, assetId),
      'the finished task never released its claim',
    );
    const afterEnd = await pastTheFloor(environment, bureau);
    expect(afterEnd.expired).toContain(assetId);
  });
});

describe.each([
  ['a durable engine', { storage: new MemoryStorage(), durable: true }],
  ['no durable engine (the in-process path)', {}],
] as const)('an image no run referenced, on %s', (_name, extra) => {
  it('is expired by the floor when no run referenced it', async () => {
    const environment = createEnvironment();
    const bureau = await openBureau(environment, { viewer: viewer([]) }, extra);
    const image = await suppliedImage(bureau);

    const report = await pastTheFloor(environment, bureau);

    expect(report.expired).toContain(assetIdOf(image));
  });
});

describe('a task across a restart', () => {
  async function sqliteStorage() {
    const database = createSqliteStorageFixture();
    cleanups.push(() => database.dispose());
    return database;
  }

  it('keeps the input asset resolvable past the floor when the process died with the run in flight, because the next boot resumes it', async () => {
    const environment = createEnvironment();
    const database = await sqliteStorage();
    // Nothing owns the dead process's run any more, so the next boot recovers it at once.
    const durable = {
      durable: true,
      durableOwnership: { ownership: 'none' as const },
    };
    const seen: GenerateContext[] = [];

    const first = await openBureau(
      environment,
      { viewer: viewer(seen, new Promise<void>(() => {})) },
      { ...durable, storage: database.storage },
    );
    const image = await suppliedImage(first);
    await first.tasks.start('viewer', [image], { principal: alice.id });
    await waitForCondition(() => seen.length > 0, 'the run never reached its first step');

    // The recovered run is parked too, so it is still in flight when the floor passes.
    const second = await openBureau(
      environment,
      { viewer: viewer([], new Promise<void>(() => {})) },
      { ...durable, storage: database.open() },
    );
    await second.recovery();
    const report = await pastTheFloor(environment, second);

    expect(report.expired).not.toContain(assetIdOf(image));
    expect(await resolves(second, assetIdOf(image))).toBe(true);
  });
});

describe('a child run', () => {
  async function bureauWithParent(
    environment: Environment,
    agents: NonNullable<Parameters<typeof createBureau>[0]['agents']>,
  ) {
    const bureau = await openBureau(environment, {
      ...agents,
      // The parent never answers, but stops when it is aborted, as a provider call does.
      default: createAgent({
        generate: ({ signal }) =>
          new Promise<never>((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          }),
      }),
    });
    const parent = await bureau.tasks.start('default', 'plan the work', { principal: alice.id });
    cleanups.push(async () => {
      await bureau.tasks.cancel(parent.id);
      await waitForTaskState(bureau, parent.id);
    });
    return { bureau, parent };
  }

  it('claims its supplied input under its own run-row holder while it runs, and lets it go when it ends', async () => {
    const environment = createEnvironment();
    const parked = release();
    const seen: GenerateContext[] = [];
    const { bureau, parent } = await bureauWithParent(environment, {
      viewer: viewer(seen, parked.gate),
    });
    const image = await suppliedImage(bureau);

    const dispatched = await bureau.children.dispatch({
      parentRunId: parent.id,
      agentName: 'viewer',
      input: [image],
      principal: alice.id,
    });
    if (dispatched.outcome !== 'started') throw new Error('expected a started child');
    const reference = { parentRunId: parent.id, childRunId: dispatched.child.childRunId };
    await waitForCondition(() => seen.length > 0, 'the child never reached its first step');

    const report = await pastTheFloor(environment, bureau);

    expect(await holdersOf(bureau, assetIdOf(image))).toEqual([
      expect.stringContaining(runRowPrefix(reference.childRunId)),
    ]);
    expect(report.expired).not.toContain(assetIdOf(image));
    expect(await resolves(bureau, assetIdOf(image))).toBe(true);

    parked.open();
    await bureau.children.wait(reference);
    await waitForCondition(
      () => isUnheld(bureau, assetIdOf(image)),
      'the finished child never released its claim',
    );
  });

  it('claims the image it generates when it commits the row, and lets it go when it ends', async () => {
    const environment = createEnvironment();
    const { bureau, parent } = await bureauWithParent(environment, { painter });
    const claims = watchRunRowClaims(bureau);

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
    await waitForCondition(
      () => isUnheld(bureau, assetId),
      'the finished child never released its claim',
    );

    // The commit claimed the image under the child, and the end released that same claim.
    const holder = expect.stringContaining(runRowPrefix(dispatched.child.childRunId));
    expect(claims.filter((event) => event.assetId === assetId)).toEqual([
      { type: 'asset.retained', assetId, holderId: holder },
      { type: 'asset.released', assetId, holderId: holder },
    ]);
  });
});

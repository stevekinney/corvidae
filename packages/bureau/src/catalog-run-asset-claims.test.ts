/**
 * COR-1630 — a catalog run releases the claims its rows hold on managed assets when the run ends.
 *
 * A run with no session holds the assets its rows reference under `run-row:<run id>:<row id>`,
 * with a claim that never lapses (COR-1581), and nothing let those go. The outcome matrix, who
 * releases and what, with the file's tests against each row:
 *
 * | How the run ends or does not                      | Who releases           | Result                        |
 * | ------------------------------------------------- | ---------------------- | ----------------------------- |
 * | `bureau.run()` completes / fails / is aborted     | catalog dispatcher     | release the held pairs        |
 * | `tasks.cancel` on a `bureau.run()` run            | catalog dispatcher     | release the held pairs        |
 * | child canceled by its parent                      | catalog dispatcher     | release the held pairs        |
 * | seeding claim fails partway                       | catalog dispatcher     | release what was claimed      |
 * | non-durable run settles                           | catalog dispatcher     | release the held pairs        |
 * | recovered run ends                                | settlement hook        | release from the checkpoint   |
 * | shutdown cancels a run for good (`abort` policy)  | catalog dispatcher     | release the held pairs        |
 * | run completes while a `drain` shutdown waits      | catalog dispatcher     | release the held pairs        |
 * | shutdown with a run that will resume (recovered)  | nobody until it ends   | release nothing, then at end  |
 * | run lost to another engine                        | nobody (the winner)    | release nothing               |
 * | goal attempt (live or recovered)                  | goal forwarder         | claim the session, release    |
 * | recovered goal attempt, goal already over         | settlement hook        | release from the checkpoint   |
 * | an asset no row ever claimed                      | nobody                 | no `asset.released` event     |
 *
 * The unit-level rows (every forwarder return, an inspect that fails, an unreadable conversation,
 * idempotence, which handles the dispatcher reports) are pinned in
 * `catalog-run-asset-release.test.ts`, `goal-forwarder.test.ts`, `bureau-catalog-dispatch.test.ts`
 * and `assets/row-asset-claims.test.ts`.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createManualRuntimeServices, type ManualRuntimeServices } from '@lostgradient/lifecycle';
import {
  createAgent,
  createModelCatalog,
  type GenerateContext,
  stopWhen,
  type Validator,
  waitForCondition,
  withBackendDescriptors,
} from '@lostgradient/operative';
import { waitForTaskState } from './test';
import { yieldToPortableEventLoop } from '@lostgradient/weft';
import { createTool, createToolbox } from 'armorer';
import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import {
  appendAssistantMessage,
  appendUserMessage,
  createConversationHistory,
  type MediaContent,
} from 'conversationalist';
import { z } from 'zod';

import type { AgentDefinitions } from './agent-catalog';
import { runRowHolderId } from './assets/row-asset-claims';
import { createBureau } from './create-bureau';
import { createMemoryAssetStorageFixture } from './test/asset-storage-fixtures';
import {
  alice,
  aliceAdministrator,
  base64Of,
  pngBytes,
} from './testing/asset-fixtures.test-support';
import {
  CHECK,
  createCheckValidator,
  goalRequest,
  pollUntil,
} from './testing/goal-fixtures.test-support';
import { inspect } from './testing/goal-recovery-fixtures.test-support';
import type { Bureau, BureauDiagnostic } from './types';

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
const generatedPart = {
  type: 'image' as const,
  mimeType: 'image/png',
  source: { kind: 'inline' as const, data: base64Of(png), encoding: 'base64' as const },
};

/** An agent that answers with text, holding its first step until released. */
function viewer(hold?: Promise<void>, seen: GenerateContext[] = []) {
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
    async () => ({ content: '', parts: [generatedPart], toolCalls: [] }),
    imageOutputDescriptors,
  ),
  stopWhen: stopWhen.noToolCalls(),
});

/** An agent whose model fails. */
const failing = createAgent({
  generate: withBackendDescriptors(async () => {
    throw new Error('the provider is down');
  }, anthropicDescriptors),
  stopWhen: stopWhen.noToolCalls(),
});

function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
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
    onDiagnostic: () => undefined,
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

/** The holders that claim an asset, read through the privileged projection. */
async function holdersOf(bureau: Bureau, assetId: string): Promise<string[]> {
  const descriptor = await bureau.assets!.inspect(assetId, aliceAdministrator, {
    projection: 'privileged',
  });
  if (descriptor.projection !== 'privileged') throw new Error('expected the privileged projection');
  return descriptor.retention.references.map((reference) => reference.holderId);
}

/** Every `asset.released` event the bureau's asset service emits from now on. */
function watchReleases(bureau: Bureau): Array<{ assetId: string; holderId: string }> {
  const released: Array<{ assetId: string; holderId: string }> = [];
  const unsubscribe = bureau.assets!.subscribe((event) => {
    const { assetId, holderId } = event;
    if (event.type === 'asset.released' && assetId !== undefined && holderId !== undefined) {
      released.push({ assetId, holderId });
    }
  });
  cleanups.push(async () => unsubscribe());
  return released;
}

/** Every claim taken or let go on any asset, in the order the asset service reports it. */
function watchClaims(bureau: Bureau) {
  const events: Array<{ type: 'retained' | 'released'; assetId: string; holderId: string }> = [];
  const unsubscribe = bureau.assets!.subscribe((event) => {
    const { assetId, holderId } = event;
    if (
      (event.type === 'asset.retained' || event.type === 'asset.released') &&
      assetId !== undefined &&
      holderId !== undefined
    ) {
      events.push({
        type: event.type === 'asset.retained' ? 'retained' : 'released',
        assetId,
        holderId,
      });
    }
  });
  cleanups.push(async () => unsubscribe());
  return events;
}

const heldByRun = (holders: readonly string[], runId: string): string[] =>
  holders.filter((holder) => holder.startsWith(runRowHolderId(runId, '').slice(0, -1)));

async function releasedHolders(bureau: Bureau, assetId: string, runId: string): Promise<void> {
  await waitForCondition(async () => {
    const holders = await holdersOf(bureau, assetId);
    return heldByRun(holders, runId).length === 0;
  }, `run "${runId}" never released its claim on asset "${assetId}"`);
}

/** A conversation whose earlier user row and last user row each carry an image. */
function seededConversation(early: MediaContent, last: MediaContent) {
  let history = createConversationHistory();
  history = appendUserMessage(history, [{ type: 'text', text: 'an earlier question' }, early]);
  history = appendAssistantMessage(history, 'noted');
  history = appendUserMessage(history, [{ type: 'text', text: 'and now this one' }, last]);
  return history;
}

const durableEngine = { storage: { type: 'memory' as const }, durable: true };

async function storageDirectory(): Promise<{
  readonly storage: { type: 'sqlite'; path: string };
}> {
  const directory = await mkdtemp(join(tmpdir(), 'bureau-run-asset-claims-'));
  cleanups.push(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  return { storage: { type: 'sqlite', path: join(directory, 'bureau') } };
}

async function durableStatusOf(bureau: Bureau, runId: string): Promise<string | undefined> {
  const run = await bureau.tasks.workflow(runId);
  return run?.status;
}

async function taskStatusOf(bureau: Bureau, runId: string): Promise<string | undefined> {
  const task = await bureau.internals.taskRegistry.get(runId);
  return task?.status;
}

async function goalStatusOf(bureau: Bureau, goalRunId = 'g1'): Promise<string | undefined> {
  const goal = await bureau.goals.get(goalRunId);
  return goal?.status;
}

/** Collects what a bureau reports, so a test can say that a shutdown reported nothing about assets. */
function collectDiagnostics() {
  const collected: BureauDiagnostic[] = [];
  return {
    onDiagnostic: (diagnostic: BureauDiagnostic): void => void collected.push(diagnostic),
    /** Everything about managed assets, and anything that names a closed asset service. */
    aboutAssets: () =>
      collected.filter(
        (diagnostic) =>
          diagnostic.scope === 'assets' ||
          /AssetServiceClosed|asset service/i.test(diagnostic.message),
      ),
  };
}

describe.each([
  ['a durable engine', durableEngine],
  ['no durable engine (the in-process path)', {}],
] as const)('a bureau.run() that ends, on %s', (_name, extra) => {
  it('releases the claims of the rows it took and no others, once it completes', async () => {
    const environment = createEnvironment();
    const bureau = await openBureau(environment, { painter }, extra);
    const released = watchReleases(bureau);
    const early = await suppliedImage(bureau);
    const last = await suppliedImage(bureau);
    const history = seededConversation(early, last);
    const lastRowId = history.ids.at(-1)!;

    const run = bureau.run('painter', { conversation: history }, { principal: alice.id });
    const result = await run.result();
    const generated = result.parts.find((part) => part.type === 'image');
    if (generated === undefined || generated.type !== 'image')
      throw new Error('the run generated no image');
    const generatedRowId = result.conversation.getMessages().at(-1)!.id;

    await waitForCondition(() => released.length >= 2, 'the run never released its claims');
    await yieldToPortableEventLoop();

    // Both claims the run took go: the last seeded row's, and the row it committed.
    expect(released).toEqual(
      expect.arrayContaining([
        { assetId: assetIdOf(last), holderId: runRowHolderId(run.id, lastRowId) },
        { assetId: assetIdOf(generated), holderId: runRowHolderId(run.id, generatedRowId) },
      ]),
    );
    expect(released).toHaveLength(2);
    // The earlier row's asset was never claimed under the run, so it is not released either.
    expect(released.map((event) => event.assetId)).not.toContain(assetIdOf(early));
    for (const part of [early, last, generated]) {
      expect(await holdersOf(bureau, assetIdOf(part))).toEqual([]);
    }

    // The consequence: nothing keeps them any more, so the retention floor expires them.
    const report = await pastTheFloor(environment, bureau);
    expect(report.expired).toEqual(
      expect.arrayContaining([assetIdOf(early), assetIdOf(last), assetIdOf(generated)]),
    );
  });

  it('releases the claims of a run that failed by finish reason', async () => {
    const environment = createEnvironment();
    const bureau = await openBureau(environment, { failing }, extra);
    const image = await suppliedImage(bureau);

    const run = bureau.run('failing', [image], { principal: alice.id });
    const result = await run.result();
    expect(result.finishReason).toBe('error');

    await releasedHolders(bureau, assetIdOf(image), run.id);
  });

  it('releases the claims of an aborted run', async () => {
    const environment = createEnvironment();
    const parked = gate();
    const seen: GenerateContext[] = [];
    const bureau = await openBureau(environment, { viewer: viewer(parked.promise, seen) }, extra);
    const image = await suppliedImage(bureau);
    const run = bureau.run('viewer', [image], { principal: alice.id });
    await waitForCondition(() => seen.length > 0, 'the run never reached its first step');
    expect(heldByRun(await holdersOf(bureau, assetIdOf(image)), run.id)).toHaveLength(1);

    run.abort('stop');
    const result = await run.result();
    expect(result.finishReason).toBe('aborted');

    await releasedHolders(bureau, assetIdOf(image), run.id);
    parked.open();
  });

  it('releases the claims of a task that is canceled', async () => {
    const environment = createEnvironment();
    const parked = gate();
    const seen: GenerateContext[] = [];
    const bureau = await openBureau(environment, { viewer: viewer(parked.promise, seen) }, extra);
    const image = await suppliedImage(bureau);
    const run = bureau.run('viewer', [image], { principal: alice.id });
    await waitForCondition(() => seen.length > 0, 'the run never reached its first step');

    await bureau.internals.taskRegistry.cancel(run.id, 0);

    await releasedHolders(bureau, assetIdOf(image), run.id);
    parked.open();
  });

  it('releases what its seeding claim took when the claim fails partway, and fails the run', async () => {
    const environment = createEnvironment();
    const bureau = await openBureau(environment, { viewer: viewer() }, extra);
    const first = await suppliedImage(bureau);
    const second = await suppliedImage(bureau);
    const retain = bureau.assets!.retain.bind(bureau.assets!);
    const failure = spyOn(bureau.assets!, 'retain').mockImplementation(
      async (assetId, principal, reference) => {
        if (assetId === assetIdOf(second)) throw new Error('the asset store is down');
        return retain(assetId, principal, reference);
      },
    );

    const run = bureau.run('viewer', [first, second], { principal: alice.id });
    const result = await run.result();
    failure.mockRestore();

    expect(result.finishReason).toBe('error');
    await releasedHolders(bureau, assetIdOf(first), run.id);
    expect(await holdersOf(bureau, assetIdOf(second))).toEqual([]);
  });
});

describe.each([
  ['a durable engine', durableEngine],
  ['no durable engine (the in-process path)', {}],
] as const)('a child run that is canceled by its parent, on %s', (_name, extra) => {
  it('releases its claims', async () => {
    const environment = createEnvironment();
    const parked = gate();
    const seen: GenerateContext[] = [];
    const bureau = await openBureau(
      environment,
      {
        viewer: viewer(parked.promise, seen),
        // The parent never answers, but stops when it is aborted, as a provider call does.
        default: createAgent({
          generate: ({ signal }) =>
            new Promise<never>((_resolve, reject) => {
              signal?.addEventListener('abort', () => reject(new Error('aborted')), {
                once: true,
              });
            }),
        }),
      },
      extra,
    );
    const parent = await bureau.tasks.start('default', 'plan the work', { principal: alice.id });
    cleanups.push(async () => {
      await bureau.tasks.cancel(parent.id);
      await waitForTaskState(bureau, parent.id);
      parked.open();
    });
    const image = await suppliedImage(bureau);
    const dispatched = await bureau.children.dispatch({
      parentRunId: parent.id,
      agentName: 'viewer',
      input: [image],
      principal: alice.id,
    });
    if (dispatched.outcome !== 'started') throw new Error('expected a started child');
    const { childRunId } = dispatched.child;
    await waitForCondition(() => seen.length > 0, 'the child never reached its first step');
    expect(heldByRun(await holdersOf(bureau, assetIdOf(image)), childRunId)).toHaveLength(1);

    await bureau.tasks.cancel(parent.id);
    await bureau.children.wait({ parentRunId: parent.id, childRunId });

    await releasedHolders(bureau, assetIdOf(image), childRunId);
  });
});

describe('a bureau.run() at shutdown', () => {
  const durable = { durable: true };

  it('releases its claims when the default abort policy cancels it for good, without a diagnostic', async () => {
    const environment = createEnvironment();
    const location = await storageDirectory();
    const diagnostics = collectDiagnostics();
    const seen: GenerateContext[] = [];
    const first = await openBureau(
      environment,
      { viewer: viewer(new Promise<void>(() => {}), seen) },
      { ...location, ...durable, onDiagnostic: diagnostics.onDiagnostic },
    );
    const image = await suppliedImage(first);
    const run = first.run('viewer', [image], { principal: alice.id });
    await waitForCondition(() => seen.length > 0, 'the run never reached its first step');
    expect(heldByRun(await holdersOf(first, assetIdOf(image)), run.id)).toHaveLength(1);

    await first.dispose();

    // The shutdown's own abort ended the run for good, so the next boot has nothing to resume.
    const replacement: GenerateContext[] = [];
    const second = await openBureau(
      environment,
      { viewer: viewer(undefined, replacement) },
      { ...location, ...durable },
    );
    await second.waitForRecovery?.();
    expect(await durableStatusOf(second, run.id)).toBe('cancelled');
    expect(await taskStatusOf(second, run.id)).toBe('canceled');
    expect(heldByRun(await holdersOf(second, assetIdOf(image)), run.id)).toEqual([]);
    expect(replacement).toEqual([]);
    expect(diagnostics.aboutAssets()).toEqual([]);
    const report = await pastTheFloor(environment, second);
    expect(report.expired).toContain(assetIdOf(image));
  });

  it('releases its claims when it completes while a drain shutdown waits for it, without a diagnostic', async () => {
    const environment = createEnvironment();
    const location = await storageDirectory();
    const diagnostics = collectDiagnostics();
    const parked = gate();
    const seen: GenerateContext[] = [];
    const first = await openBureau(
      environment,
      { viewer: viewer(parked.promise, seen) },
      { ...location, ...durable, onDiagnostic: diagnostics.onDiagnostic },
    );
    const image = await suppliedImage(first);
    const run = first.run('viewer', [image], { principal: alice.id });
    await waitForCondition(() => seen.length > 0, 'the run never reached its first step');

    const shutdown = first.shutdown({ policy: 'drain' });
    parked.open();
    await shutdown;
    const finished = await run.result();
    expect(finished.finishReason).not.toBe('error');

    const second = await openBureau(environment, { viewer: viewer() }, { ...location, ...durable });
    await second.waitForRecovery?.();
    expect(await durableStatusOf(second, run.id)).toBe('completed');
    expect(heldByRun(await holdersOf(second, assetIdOf(image)), run.id)).toEqual([]);
    expect(diagnostics.aboutAssets()).toEqual([]);
  });

  it('keeps its claims when this process lost the run to another engine', async () => {
    const environment = createEnvironment();
    const parked = gate();
    const seen: GenerateContext[] = [];
    const bureau = await openBureau(
      environment,
      { viewer: viewer(parked.promise, seen) },
      durableEngine,
    );
    const image = await suppliedImage(bureau);
    const run = bureau.run('viewer', [image], { principal: alice.id });
    await waitForCondition(() => seen.length > 0, 'the run never reached its first step');
    const engine = bureau.durableEngine();
    if (engine === undefined) throw new Error('Expected a durable engine.');
    // Another engine over the same store won the run's checkpoint compare-and-swap, and is still
    // running it: this engine's handle settles interrupted, and the stored run is not over.
    const original = engine.get.bind(engine);
    const lost = spyOn(engine, 'lostWorkflowClaim').mockReturnValue(true);
    const winnerRunning = spyOn(engine, 'get').mockImplementation(async (id: string) => {
      const record = await original(id);
      return id === run.id && record !== null && record !== undefined
        ? { ...record, status: 'running' }
        : record;
    });
    const released = watchReleases(bureau);

    parked.open();
    await run.result();
    // Give a release every chance to happen before asserting that it did not.
    for (let turn = 0; turn < 50; turn += 1) await yieldToPortableEventLoop();
    lost.mockRestore();
    winnerRunning.mockRestore();

    expect(released).toEqual([]);
    expect(heldByRun(await holdersOf(bureau, assetIdOf(image)), run.id)).toHaveLength(1);
  });
});

describe('a run recovered after a restart', () => {
  const recovering = {
    durable: true,
    durableOwnership: { ownership: 'none' as const },
  };

  /** The first process starts the run and is the one that died: its model never answers. */
  async function startRunThatDies(
    environment: Environment,
    location: Awaited<ReturnType<typeof storageDirectory>>,
  ) {
    const seen: GenerateContext[] = [];
    const first = await openBureau(
      environment,
      { viewer: viewer(new Promise<void>(() => {}), seen) },
      { ...location, ...recovering },
    );
    const early = await suppliedImage(first);
    const last = await suppliedImage(first);
    const run = first.run(
      'viewer',
      { conversation: seededConversation(early, last) },
      {
        principal: alice.id,
      },
    );
    await waitForCondition(() => seen.length > 0, 'the run never reached its first step');
    return { first, run, early, last };
  }

  it('releases its claims, and only the claimed row’s, in the process that recovers it', async () => {
    const environment = createEnvironment();
    const location = await storageDirectory();
    const { run, early, last } = await startRunThatDies(environment, location);
    const resume = gate();
    const second = await openBureau(
      environment,
      { viewer: viewer(resume.promise) },
      { ...location, ...recovering },
    );
    await second.waitForRecovery?.();
    const released = watchReleases(second);
    expect(heldByRun(await holdersOf(second, assetIdOf(last)), run.id)).toHaveLength(1);

    resume.open();

    await releasedHolders(second, assetIdOf(last), run.id);
    expect(released.map((event) => event.assetId)).toEqual([assetIdOf(last)]);
    expect(released.map((event) => event.assetId)).not.toContain(assetIdOf(early));
  });

  it('keeps its claims through a graceful shutdown, and releases them when the next boot finishes it', async () => {
    const environment = createEnvironment();
    const location = await storageDirectory();
    const { run, last } = await startRunThatDies(environment, location);
    const diagnostics = collectDiagnostics();
    const second = await openBureau(
      environment,
      { viewer: viewer(new Promise<void>(() => {})) },
      { ...location, ...recovering, onDiagnostic: diagnostics.onDiagnostic },
    );
    await second.waitForRecovery?.();
    const releasedBySecond = watchReleases(second);

    await second.dispose();

    // The recovered run is lost, not ended: its durable record still reads in flight.
    expect(releasedBySecond).toEqual([]);
    expect(diagnostics.aboutAssets()).toEqual([]);
    const third = await openBureau(
      environment,
      { viewer: viewer() },
      { ...location, ...recovering },
    );
    // The run is still in flight and still holds its claim when the next boot opens.
    await third.waitForRecovery?.();
    await releasedHolders(third, assetIdOf(last), run.id);
  });
});

/**
 * A goal retries by starting a new attempt, which is a new `run-row` holder run, and seeds it from
 * the goal's session. The rows attempt 0 left must be held by that session before attempt 0's own
 * claims go, or the image it generated could be collected between the two attempts.
 */
describe.each([
  ['continue', { kind: 'continue' as const }],
  ['fork-from-baseline', { kind: 'fork-from-baseline' as const, throughRun: 0 }],
] as const)('a goal retry under %s', (_name, conversationPolicy) => {
  it('hands the generated image to the goal’s session before releasing the attempt’s claim', async () => {
    const generatedAssets: string[] = [];
    const seenByRetry: Array<{ resolved: boolean; assetId: string | undefined }> = [];
    let attempts = 0;
    let bureauForAttempts!: Bureau;
    let collectedBetween: { expired: readonly string[] } | undefined;
    const worker = createAgent({
      name: 'worker',
      generate: withBackendDescriptors(async (context: GenerateContext) => {
        attempts += 1;
        if (attempts === 1) return { content: '', parts: [generatedPart], toolCalls: [] };
        // The retry replays attempt 0's transcript: its image must still resolve.
        const replayed = context.conversation
          .getMessages({ includeHidden: true })
          .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
          .find((part) => part.type === 'image');
        const assetId =
          replayed?.type === 'image' && replayed.source.kind === 'managed-asset'
            ? replayed.source.assetId
            : undefined;
        let resolved = false;
        if (replayed?.type === 'image') {
          resolved = await bureauForAttempts.assets!.resolve(replayed.source as never, alice).then(
            () => true,
            () => false,
          );
        }
        seenByRetry.push({ resolved, assetId });
        // The goal's last attempt generates an image of its own, which it releases too.
        return {
          content: 'done',
          parts: [{ type: 'text' as const, text: 'done' }, generatedPart],
          toolCalls: [],
        };
      }, imageOutputDescriptors),
      stopWhen: stopWhen.noToolCalls(),
    });
    // Fails attempt 0 and, before the retry starts, runs a collection pass with the retention
    // floor at zero: an asset nothing claims is expired by it.
    let unclaimed: string | undefined;
    const validator: Validator = {
      identity: { name: CHECK.name, version: CHECK.version },
      determinism: 'deterministic',
      async validate(input) {
        if (input.result.content.includes('done')) return { kind: 'pass', evidence: [] };
        const admission = await bureauForAttempts.assets!.admit(
          { source: { kind: 'inline', bytes: png }, declaredMediaType: 'image/png' },
          alice,
        );
        await admission.work.result();
        unclaimed = assetIdOf({ type: 'image', source: admission.source });
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
        const collected = await bureauForAttempts.assets!.collectGarbage().result();
        if (collected.outcome === 'completed') collectedBetween = collected.value;
        return { kind: 'fail', feedback: 'say done', evidence: [], retryable: true };
      },
    };
    const fixture = createMemoryAssetStorageFixture({});
    cleanups.push(() => fixture.dispose());
    const options: Parameters<typeof createBureau>[0] = {
      agents: { worker },
      validators: [validator],
      storage: { type: 'memory' },
      durable: true,
      assets: { storage: fixture.storage, policy: { defaultRetentionMilliseconds: 0 } },
      onDiagnostic: () => undefined,
    };
    const bureau = await createBureau(options);
    bureauForAttempts = bureau;
    cleanups.push(async () => {
      await bureau.dispose();
    });
    const claims = watchClaims(bureau);

    expect(
      await bureau.goals.create(
        goalRequest({ principal: alice.id, conversationPolicy, goalRunId: 'g1' }),
      ),
    ).toMatchObject({ outcome: 'created' });
    const finished = await pollUntil(async () => {
      const goal = await bureau.goals.get('g1');
      return goal?.status === 'succeeded';
    });
    expect(finished).toBe(true);

    const [replay] = seenByRetry;
    expect(attempts).toBe(2);
    expect(replay?.assetId).toBeDefined();
    // The collection pass ran between the attempts and really did expire what nothing held.
    expect(collectedBetween?.expired).toContain(unclaimed);
    expect(collectedBetween?.expired).not.toContain(replay?.assetId);
    generatedAssets.push(replay!.assetId!);
    expect(replay?.resolved).toBe(true);

    // The attempt's own claim is let go exactly once, and the goal's session holds the image.
    const generated = generatedAssets[0]!;
    await pollUntil(
      async () => heldByRun(await holdersOf(bureau, generated), 'goal-g1-a0').length === 0,
    );
    const holders = await holdersOf(bureau, generated);
    expect(heldByRun(holders, 'goal-g1-a0')).toEqual([]);
    expect(holders.some((holder) => holder.startsWith('session-row:'))).toBe(true);
    // The session's claim was taken before the attempt's was let go, and the attempt's was let go once.
    const sessionClaimed = claims.findIndex(
      (event) =>
        event.type === 'retained' &&
        event.assetId === generated &&
        event.holderId.startsWith('session-row:'),
    );
    const runReleases = claims
      .map((event, index) => ({ event, index }))
      .filter(
        ({ event }) =>
          event.type === 'released' &&
          event.assetId === generated &&
          event.holderId.startsWith('run-row:goal-g1-a0'),
      );
    expect(runReleases).toHaveLength(1);
    expect(sessionClaimed).toBeGreaterThanOrEqual(0);
    expect(sessionClaimed).toBeLessThan(runReleases[0]!.index);
    // The last attempt's own image goes the same way, through the same forwarder.
    const lastAttemptReleases = claims.filter(
      (event) => event.type === 'released' && event.holderId.startsWith('run-row:goal-g1-a1'),
    );
    expect(lastAttemptReleases.length).toBeGreaterThan(0);
    // Neither the dispatcher nor the settlement hook released an attempt: the forwarder did, so
    // no pair was released twice.
    const pairs = claims
      .filter((event) => event.type === 'released')
      .map((event) => `${event.holderId}\u0000${event.assetId}`);
    expect(new Set(pairs).size).toBe(pairs.length);
  });
});

/**
 * COR-1664 — the goal's session is deleted just before the forwarder's hand-over claims its rows.
 * The forwarder holds the session it committed to, so the claim is made for a session that no
 * longer exists, and must leave nothing behind.
 */
describe('a goal whose session is deleted before the hand-over claims for it', () => {
  it('leaves no session claim on the attempt’s image, and still lets the attempt’s claim go', async () => {
    let attempts = 0;
    const worker = createAgent({
      name: 'worker',
      generate: withBackendDescriptors(async () => {
        attempts += 1;
        return attempts === 1
          ? { content: '', parts: [generatedPart], toolCalls: [] }
          : { content: 'done', parts: [{ type: 'text' as const, text: 'done' }], toolCalls: [] };
      }, imageOutputDescriptors),
      stopWhen: stopWhen.noToolCalls(),
    });
    const validator: Validator = {
      identity: { name: CHECK.name, version: CHECK.version },
      determinism: 'deterministic',
      async validate(input) {
        return input.result.content.includes('done')
          ? { kind: 'pass', evidence: [] }
          : { kind: 'fail', feedback: 'say done', evidence: [], retryable: true };
      },
    };
    const fixture = createMemoryAssetStorageFixture({});
    cleanups.push(() => fixture.dispose());
    const bureau = await createBureau<AgentDefinitions>({
      agents: { worker },
      validators: [validator],
      storage: { type: 'memory' },
      durable: true,
      assets: { storage: fixture.storage, policy: { defaultRetentionMilliseconds: 0 } },
      onDiagnostic: () => undefined,
    });
    cleanups.push(async () => {
      await bureau.dispose();
    });
    // The first session claim of the goal finds its session deleted: the delete lands first.
    const retain = bureau.assets!.retain.bind(bureau.assets!);
    let deletedSession: string | undefined;
    let deletedHolder = '';
    spyOn(bureau.assets!, 'retain').mockImplementation(async (...args) => {
      const [, , reference] = args;
      if (deletedSession === undefined && reference.holderId.startsWith('session-row:')) {
        const sessionId = decodeURIComponent(reference.holderId.split(':')[1]!);
        deletedSession = sessionId;
        deletedHolder = reference.holderId.split(':').slice(0, 3).join(':');
        await bureau.internals.sessionStore!.delete(sessionId);
      }
      return retain(...args);
    });
    const claims = watchClaims(bureau);

    await bureau.goals.create(
      goalRequest({
        principal: alice.id,
        conversationPolicy: { kind: 'continue' },
        goalRunId: 'g1',
      }),
    );
    await pollUntil(async () => deletedSession !== undefined);
    const released = await pollUntil(async () =>
      claims.some(
        (event) => event.type === 'released' && event.holderId.startsWith('run-row:goal-g1-a0'),
      ),
    );
    expect(released).toBe(true);

    const generated = claims.find(
      (event) => event.type === 'retained' && event.holderId.startsWith('run-row:goal-g1-a0'),
    )!.assetId;
    // A retry may recreate the session id as a new incarnation; the deleted one holds nothing.
    const holders = await holdersOf(bureau, generated);
    expect(deletedHolder).toStartWith('session-row:');
    expect(holders.filter((holder) => holder.startsWith(`${deletedHolder}:`))).toEqual([]);
  });
});

/**
 * A goal attempt's run is neither tracked by the shutdown nor released by the dispatcher: the goal
 * forwarder owns its release, and a recovered attempt whose goal is already over has no forwarder,
 * so the settlement hook releases it.
 */
describe('a goal attempt across a restart', () => {
  const noop = createTool({
    name: 'noop',
    description: 'does nothing',
    input: z.object({}),
    execute: async () => ({}),
  });

  /** Step 0 generates an image and calls a tool, so a row holds a claim when step 1 is entered. */
  function generating(
    afterTheTool: (context: GenerateContext) => Promise<{ content: string; toolCalls: [] }>,
  ) {
    return createAgent({
      name: 'worker',
      toolbox: createToolbox([noop]),
      generate: withBackendDescriptors(async (context: GenerateContext) => {
        if (context.step === 0) {
          return {
            content: '',
            parts: [generatedPart],
            toolCalls: [{ id: 'call-1', name: 'noop', arguments: {} }],
          };
        }
        return afterTheTool(context);
      }, imageOutputDescriptors),
      stopWhen: stopWhen.noToolCalls(),
    });
  }

  const hangForever = () => new Promise<never>(() => {});

  /** A bureau over `location` whose goals run on the real clock and recover whatever was left. */
  async function openGoalBureau(
    fixture: ReturnType<typeof createMemoryAssetStorageFixture>,
    location: Awaited<ReturnType<typeof storageDirectory>>,
    worker: ReturnType<typeof generating>,
    onDiagnostic: (diagnostic: BureauDiagnostic) => void,
  ): Promise<Bureau> {
    const bureau = await createBureau({
      agents: { worker },
      validators: [createCheckValidator()],
      ...location,
      durable: true,
      durableOwnership: { ownership: 'none' },
      assets: { storage: fixture.storage, policy: { defaultRetentionMilliseconds: 0 } },
      onDiagnostic,
    });
    cleanups.push(async () => {
      await bureau.dispose();
    });
    return bureau as unknown as Bureau;
  }

  /** The asset the first attempt generated, as the claim its run took on it names it. */
  async function generatedAssetOf(claims: ReturnType<typeof watchClaims>, runId: string) {
    await pollUntil(() =>
      claims.some(
        (event) => event.type === 'retained' && event.holderId.startsWith(`run-row:${runId}`),
      ),
    );
    const retained = claims.find(
      (event) => event.type === 'retained' && event.holderId.startsWith(`run-row:${runId}`),
    );
    if (retained === undefined) throw new Error('the attempt never claimed its generated image');
    return retained.assetId;
  }

  it('keeps its claims through a shutdown, and the forwarder releases them once the next boot finishes the goal', async () => {
    const fixture = createMemoryAssetStorageFixture({});
    cleanups.push(() => fixture.dispose());
    const location = await storageDirectory();
    const diagnostics = collectDiagnostics();

    const first = await openGoalBureau(
      fixture,
      location,
      generating(hangForever),
      diagnostics.onDiagnostic,
    );
    const claims = watchClaims(first);
    await first.goals.create(goalRequest({ principal: alice.id }));
    const assetId = await generatedAssetOf(claims, 'goal-g1-a0');
    // The attempt is mid-flight in its second step: its durable record reads running.
    await first.dispose();

    const resume = gate();
    const second = await openGoalBureau(
      fixture,
      location,
      generating(async () => {
        await resume.promise;
        return { content: 'done', toolCalls: [] };
      }),
      diagnostics.onDiagnostic,
    );
    await second.waitForRecovery?.();
    // The run that will resume released nothing at shutdown, and still holds its claim.
    expect(heldByRun(await holdersOf(second, assetId), 'goal-g1-a0').length).toBeGreaterThan(0);

    resume.open();
    expect(await pollUntil(async () => (await goalStatusOf(second)) === 'succeeded')).toBe(true);
    await releasedHolders(second, assetId, 'goal-g1-a0');
    const finalHolders = await holdersOf(second, assetId);
    expect(finalHolders.some((holder) => holder.startsWith('session-row:'))).toBe(true);
    expect(diagnostics.aboutAssets()).toEqual([]);
  });

  it('is released by the settlement hook when the goal was canceled before the recovered attempt ended', async () => {
    const fixture = createMemoryAssetStorageFixture({});
    cleanups.push(() => fixture.dispose());
    const location = await storageDirectory();
    const diagnostics = collectDiagnostics();

    const dead = await openGoalBureau(
      fixture,
      location,
      generating(hangForever),
      diagnostics.onDiagnostic,
    );
    const claims = watchClaims(dead);
    await dead.goals.create(goalRequest({ principal: alice.id }));
    const assetId = await generatedAssetOf(claims, 'goal-g1-a0');
    expect(heldByRun(await holdersOf(dead, assetId), 'goal-g1-a0').length).toBeGreaterThan(0);
    // The control plane wrote the cancellation marker and the process died before anything else.
    const view = await inspect(location.storage.path);
    await view.store.requestCancellation(
      'g1',
      { requestedAt: '2026-10-02T12:00:00.000Z', reason: 'operator' },
      '2026-10-02T12:00:00.000Z',
    );
    await view.dispose();

    const second = await openGoalBureau(
      fixture,
      location,
      generating(async () => ({ content: 'done', toolCalls: [] })),
      diagnostics.onDiagnostic,
    );
    expect(await pollUntil(async () => (await goalStatusOf(second)) === 'canceled')).toBe(true);

    // Recovery stops the attempt's run without a forwarder watching it, so only the hook can
    // let go of what it holds.
    await releasedHolders(second, assetId, 'goal-g1-a0');
    expect(diagnostics.aboutAssets()).toEqual([]);
  });
});

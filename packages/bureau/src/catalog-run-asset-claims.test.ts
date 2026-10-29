/**
 * COR-1630 — a catalog run (a child, a goal attempt, or a step) releases the claims its rows hold on managed assets when the run ends.
 *
 * A run with no session holds the assets its rows reference under `run-row:<run id>:<row id>`,
 * with a claim that never lapses (COR-1581), and nothing let those go. The outcome matrix, who
 * releases and what, with the file's tests against each row:
 *
 * | How the run ends or does not                      | Who releases           | Result                        |
 * | ------------------------------------------------- | ---------------------- | ----------------------------- |
 * | child canceled by its parent                      | catalog dispatcher     | release the held pairs        |
 * | goal attempt (live or recovered)                  | goal forwarder         | claim the session, release    |
 * | recovered goal attempt, goal already over         | settlement hook        | release from the checkpoint   |
 * | an asset no row ever claimed                      | nobody                 | no `asset.released` event     |
 *
 * A task runs in a context, which holds its rows, so it has no run-row claim to release. The
 * dispatcher's other rows (seeding failure, completion, abort, shutdown, recovery, a run lost to
 * another engine) are pinned at the unit level.
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
import { type MediaContent } from 'conversationalist';
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
import { MemoryStorage } from '@lostgradient/storage';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
  // load-proof: the work this lets finish runs on in-memory storage and doubles and settles through promise continuations only, so a microtask drain completes it (checked by replacing the turn with one); no timer or I/O is pending
  await yieldToPortableEventLoop();
});

const FLOOR_MILLISECONDS = 1_000;

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

/** The holders that claim an asset, read through the privileged projection. */
async function holdersOf(bureau: Bureau, assetId: string): Promise<string[]> {
  const descriptor = await bureau.assets!.inspect(assetId, aliceAdministrator, {
    projection: 'privileged',
  });
  if (descriptor.projection !== 'privileged') throw new Error('expected the privileged projection');
  return descriptor.retention.references.map((reference) => reference.holderId);
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

const durableEngine = { storage: new MemoryStorage(), durable: true };

async function storageDirectory(): Promise<{
  readonly storage: { type: 'sqlite'; path: string };
}> {
  const directory = await mkdtemp(join(tmpdir(), 'bureau-run-asset-claims-'));
  cleanups.push(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  return { storage: { type: 'sqlite', path: join(directory, 'bureau') } };
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
      storage: new MemoryStorage(),
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
      storage: new MemoryStorage(),
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
    await second.recovery();
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

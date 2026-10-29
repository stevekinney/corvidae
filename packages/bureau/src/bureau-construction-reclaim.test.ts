/**
 * COR-1586 — a run the engine reclaims while a Bureau is still being built resumes under its own
 * agent once construction has wired the agent run options resolver, and a construction that fails
 * settles the runs it was holding.
 *
 * `createBureau` awaits the agent file scan before it wires the resolver, and the engine is already
 * running during that scan: it reclaims a run whose claim has lapsed on its own interval. These
 * tests hold the scan open, let the reclaim reach the run, and only then release the scan.
 */
import { join } from 'node:path';

import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import { createAgent, stopWhen } from '@lostgradient/operative';
import { createTool, createToolbox } from 'armorer';
import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { getMessages } from 'conversationalist';
import { z } from 'zod';

import * as agentCatalogModule from './agent-catalog';
import type { AgentDefinitions } from './agent-catalog';
import * as agentFileCatalogModule from './agent-file-catalog';
import * as assetServiceModule from './assets/asset-service';
import { createBureau } from './create-bureau';
import * as runtimeCompositionModule from './runtime-composition';
import type { RuntimeComposition } from './runtime-composition';
import * as workflowToolsModule from './workflow-tools';
import {
  createConstructionWindowFixtures,
  constructionWindowGenerate,
} from './testing/construction-window.test-support';
import { createMemoryAssetStorageFixture } from './test/asset-storage-fixtures';
import { pollUntil } from './testing/goal-fixtures.test-support';
import type { Bureau, BureauDiagnostic } from './types';
import { agentFileDirectory } from './sources/agent-file-directory';
import { workflowFileDirectory } from './sources/workflow-file-directory';
import { createSqliteStorageFixture } from './test/storage-fixtures';

const bureaus: Bureau<AgentDefinitions>[] = [];
const fixtures = createConstructionWindowFixtures();

/**
 * A Bureau under construction, with the hold that is keeping it there. A test that fails before it
 * releases the hold would otherwise leave that Bureau's engine running against a directory
 * `afterEach` deletes, so every one is released and, once built, shut down.
 */
const successors: Array<{
  readonly release: () => void;
  readonly settled: Promise<Bureau<AgentDefinitions> | undefined>;
}> = [];

/** Register `successor`, which is held by `hold`, so that `afterEach` always settles it. */
function track(
  hold: { release: () => void },
  successor: Promise<Bureau<AgentDefinitions>>,
): Promise<Bureau<AgentDefinitions>> {
  successors.push({
    release: hold.release,
    settled: successor.then(
      (built) => built,
      () => undefined,
    ),
  });
  return successor;
}

afterEach(async () => {
  for (const { release, settled } of successors.splice(0)) {
    release();
    const built = await settled;
    if (built !== undefined) bureaus.push(built);
  }
  for (const bureau of bureaus.splice(0)) await bureau.shutdown();
  await fixtures.dispose();
});

const next = createTool({
  name: 'next',
  description: 'continue',
  input: z.object({}),
  execute: async () => 'ok',
});

/** Short lease timings, so a run its owner stopped renewing is reclaimed within a second or two. */
const leaseOptions = {
  ownership: 'workflow-lease',
  workflowClaimTtlMs: 200,
  workflowClaimRenewIntervalMs: 50,
} as const;

/** The diagnostic a reader emits when it parks to wait for the resolver, for `runId`. */
function isParkedDiagnostic(entry: BureauDiagnostic, runId: string): boolean {
  return (
    entry.level === 'warn' &&
    entry.scope === 'recovery' &&
    entry.message.includes(`Run "${runId}"`) &&
    entry.message.includes('agent run options resolver')
  );
}

/**
 * An owner Bureau that starts a catalog run of `writer` and never finishes it. Its background
 * tasks are manual, so its claim is never renewed: it lapses, and a Bureau over the same storage
 * can reclaim the run.
 */
async function startLapsedCatalogRun(
  storagePath: string,
): Promise<{ readonly owner: Bureau<AgentDefinitions>; readonly runId: string }> {
  const started = Promise.withResolvers<void>();
  const owner = await createBureau<AgentDefinitions>({
    agents: {
      writer: createAgent({
        name: 'writer',
        generate: async () => {
          started.resolve();
          return new Promise<never>(() => {});
        },
      }),
    },
    storage: { type: 'sqlite', path: storagePath },
    durable: true,
    maintenance: 'manual',
    durableOwnership: leaseOptions,
  });
  bureaus.push(owner);
  const run = await owner.tasks.start('writer', 'go');
  await started.promise;
  return { owner, runId: run.id };
}

/** A `writer` agent that answers `content`, for a Bureau that resumes the lapsed run. */
function writerAnswering(content: string) {
  return createAgent({ name: 'writer', generate: async () => ({ content, toolCalls: [] }) });
}

describe('a catalog agent run reclaimed while the Bureau scans its agent files (COR-1586)', () => {
  it('resumes under its own agent once the resolver is wired, and records no error', async () => {
    const root = await fixtures.scratchDirectory('bureau-reclaim-catalog-');
    await using storageFixture = createSqliteStorageFixture({ path: join(root, 'bureau.sqlite') });
    const storagePath = storageFixture.path;

    const { owner, runId } = await startLapsedCatalogRun(storagePath);

    // The successor builds with the agent file scan held, so its engine reclaims the run before
    // `createBureau` has wired the resolver.
    const hold = fixtures.holdAgentFileScan();
    const diagnostics: BureauDiagnostic[] = [];
    const successor = track(
      hold,
      createBureau<AgentDefinitions>({
        agents: {
          writer: writerAnswering('recovered'),
        },
        agentSource: agentFileDirectory(await fixtures.directoryWithOneAgentFile()),
        models: { generate: constructionWindowGenerate },
        storage: storageFixture.storage,
        durable: true,
        durableOwnership: leaseOptions,
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      }),
    );
    await hold.entered;

    // Release the scan only once the reclaim has reached the run: either the run is held for the
    // resolver, which is the behaviour under test, or it has already been failed, which is the
    // defect. Releasing on the first makes the test red on code that does the second.
    const reached = await pollUntil(async () => {
      if (diagnostics.some((entry) => isParkedDiagnostic(entry, runId))) return true;
      const durableRun = await owner.tasks.workflow(runId);
      return durableRun?.status === 'failed';
    });
    expect(reached).toBe(true);
    expect(diagnostics.filter((entry) => isParkedDiagnostic(entry, runId))).toHaveLength(1);
    hold.release();
    const built = await successor;

    const state = await built.tasks.wait(runId);
    expect(state?.error).toBeUndefined();
    expect(state?.status).toBe('completed');
    expect(diagnostics.filter((entry) => entry.level === 'error')).toEqual([]);
  });
});

describe('a named-agent session run reclaimed while the Bureau scans its agent files (COR-1586)', () => {
  it('resumes under its own agent, not the Bureau-wide one', async () => {
    const root = await fixtures.scratchDirectory('bureau-reclaim-session-');
    await using storageFixture = createSqliteStorageFixture({ path: join(root, 'bureau.sqlite') });

    const reachedStepOne = Promise.withResolvers<void>();
    const owner = await createBureau<AgentDefinitions>({
      agents: {
        scribe: createAgent({
          generate: async ({ step }) => {
            if (step === 0) {
              return { content: 'scribe step 0', toolCalls: [{ name: 'next', arguments: {} }] };
            }
            reachedStepOne.resolve();
            return new Promise<never>(() => {});
          },
          toolbox: createToolbox([next]),
          stopWhen: stopWhen.noToolCalls(),
        }),
        default: createAgent({
          generate: async () => ({ content: 'wide never answers', toolCalls: [] }),
          toolbox: createToolbox([next]),
          stopWhen: stopWhen.noToolCalls(),
        }),
      },
      storage: storageFixture.storage,
      durable: true,
      maintenance: 'manual',
      durableOwnership: leaseOptions,
    });
    bureaus.push(owner);
    const run = await owner.tasks.start('scribe', 'Recover me');
    await reachedStepOne.promise;

    const hold = fixtures.holdAgentFileScan();
    const diagnostics: BureauDiagnostic[] = [];
    const wideSteps: number[] = [];
    const wideToolbox = createToolbox([next]);
    const wideExtend = spyOn(wideToolbox, 'extend');
    fixtures.restoreOnDispose(() => wideExtend.mockRestore());
    const successor = track(
      hold,
      createBureau<AgentDefinitions>({
        agents: {
          scribe: createAgent({
            generate: async ({ step }) => ({ content: `scribe resumed at ${step}`, toolCalls: [] }),
            toolbox: createToolbox([next]),
            stopWhen: stopWhen.noToolCalls(),
          }),
          default: createAgent({
            generate: async ({ step }) => {
              wideSteps.push(step);
              return { content: 'wide answered', toolCalls: [] };
            },
            toolbox: wideToolbox,
            stopWhen: stopWhen.noToolCalls(),
          }),
        },
        agentSource: agentFileDirectory(await fixtures.directoryWithOneAgentFile()),
        models: { generate: constructionWindowGenerate },
        storage: storageFixture.open(),
        durable: true,
        durableOwnership: leaseOptions,
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      }),
    );
    await hold.entered;
    const baseline = wideExtend.mock.calls.length;

    // Released on the parked diagnostic, or once the session has left `running`, which on code
    // that resumes the run under the wrong agent it does while the scan is still held.
    const reached = await pollUntil(async () => {
      return (
        diagnostics.some((entry) => isParkedDiagnostic(entry, run.id)) ||
        wideExtend.mock.calls.length > baseline
      );
    });
    expect(reached).toBe(true);
    // The run was held for the resolver, with one warning naming it, not resumed under another agent.
    expect(diagnostics.filter((entry) => isParkedDiagnostic(entry, run.id))).toHaveLength(1);
    hold.release();
    const built = await successor;

    const completed = await pollUntil(async () => {
      const session = await built.contexts.get(run.contextId);
      return session?.metadata['lastRunStatus'] === 'completed';
    });
    expect(completed).toBe(true);
    const session = await built.contexts.get(run.contextId);
    const replies = (session === undefined ? [] : getMessages(session.conversationHistory))
      .filter((message) => message.role === 'assistant')
      .map((message) => (typeof message.content === 'string' ? message.content : ''));
    expect(replies).toEqual(['scribe step 0', 'scribe resumed at 1']);
    expect(wideSteps).toEqual([]);
    expect(diagnostics.filter((entry) => entry.level === 'error')).toEqual([]);
  });
});

describe('a construction that fails while a run is parked for the resolver (COR-1586)', () => {
  it('shuts the Bureau down in order, then settles the parked run as unavailable, and rethrows', async () => {
    const root = await fixtures.scratchDirectory('bureau-reclaim-failure-');
    const order: string[] = [];

    // The composition and the file catalog are taken from the exports `createBureau` imports, so
    // the engine, the storage, and the catalog's `close` can be observed without a test seam.
    let captured:
      Awaited<ReturnType<typeof runtimeCompositionModule.createRuntimeComposition>> | undefined;
    const createComposition = runtimeCompositionModule.createRuntimeComposition;
    const compositionSpy = spyOn(
      runtimeCompositionModule,
      'createRuntimeComposition',
    ).mockImplementation(async (...args) => {
      captured = await createComposition(...args);
      return captured;
    });
    fixtures.restoreOnDispose(() => compositionSpy.mockRestore());
    const createFileCatalog = agentFileCatalogModule.createAgentFileCatalog;
    const fileCatalogSpy = spyOn(
      agentFileCatalogModule,
      'createAgentFileCatalog',
    ).mockImplementation((...args) => {
      const catalog = createFileCatalog(...args);
      const close = catalog.close.bind(catalog);
      catalog.close = async () => {
        order.push('agent files closed');
        return close();
      };
      return catalog;
    });
    fixtures.restoreOnDispose(() => fileCatalogSpy.mockRestore());
    const createAssets = assetServiceModule.createAssetService;
    const assetSpy = spyOn(assetServiceModule, 'createAssetService').mockImplementation(
      async (...args) => {
        const service = await createAssets(...args);
        const shutdown = service.shutdown.bind(service);
        service.shutdown = async () => {
          order.push('asset service shut down');
          return shutdown();
        };
        return service;
      },
    );
    fixtures.restoreOnDispose(() => assetSpy.mockRestore());
    const assetStorage = createMemoryAssetStorageFixture({});
    fixtures.restoreOnDispose(() => void assetStorage.dispose());
    const catalogSpy = spyOn(agentCatalogModule, 'createAgentCatalog').mockImplementation(() => {
      throw new Error('catalog exploded');
    });
    fixtures.restoreOnDispose(() => catalogSpy.mockRestore());

    const hold = fixtures.holdAgentFileScan();
    const runtime = createManualRuntimeServices({ origin: '2026-10-19T00:00:00.000Z' });
    const diagnostics: BureauDiagnostic[] = [];
    const building = track(
      hold,
      createBureau<AgentDefinitions>({
        agents: {},
        agentSource: agentFileDirectory(await fixtures.directoryWithOneAgentFile()),
        models: { generate: constructionWindowGenerate },
        storage: { type: 'sqlite', path: join(root, 'bureau.sqlite') },
        durable: true,
        maintenance: 'manual',
        observability: true,
        runtime,
        assets: { storage: assetStorage.storage, garbageCollectionIntervalMilliseconds: 1_000 },
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      }),
    );
    const outcome = building.then(
      () => 'built' as const,
      (error: unknown) => error,
    );
    await hold.entered;

    // A run the engine has handed to the resolver, parked: its recovery record is in storage and
    // no resolver is wired yet.
    if (captured === undefined) throw new Error('Expected the Bureau to have built a composition.');
    const composition = captured;
    const durable = composition.durable;
    if (durable === undefined) throw new Error('Expected a durable engine.');
    // Each step of the shutdown is wrapped so it records when it ran and still does its work.
    const realEngineShutdown = durable.engine.shutdown.bind(durable.engine);
    const engineShutdown = spyOn(durable.engine, 'shutdown').mockImplementation(async () => {
      order.push('engine shut down');
      return realEngineShutdown();
    });
    const observability = durable.observability;
    if (observability === undefined) throw new Error('Expected durable observability.');
    const realDispose = observability.dispose.bind(observability);
    spyOn(observability, 'dispose').mockImplementation(() => {
      order.push('observability disposed');
      realDispose();
    });
    const realAbandon = composition.abandonCatalogAgentRunOptionsResolver.bind(composition);
    spyOn(composition, 'abandonCatalogAgentRunOptionsResolver').mockImplementation((reason) => {
      order.push('waiters settled');
      realAbandon(reason);
    });
    await composition.persistCatalogRunRecoveryRecord('parked-run', {
      agentName: 'writer',
      definitionRevision: 1,
      input: 'go',
    });
    const parked = composition.resolveRunServices({
      workflowId: 'parked-run',
      workflowType: 'agentRun',
      input: { runId: 'parked-run', sessionId: 'parked-run', agentName: 'writer' },
    });
    expect(
      await pollUntil(() => diagnostics.some((entry) => isParkedDiagnostic(entry, 'parked-run'))),
    ).toBe(true);

    // The Bureau under construction has armed timers (the asset collection one, at least); they are
    // what a failed construction must stop.
    expect(runtime.pendingTimers().length).toBeGreaterThan(0);
    hold.release();
    const error = await outcome;

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('catalog exploded');
    const resolution = await parked;
    expect(resolution.status).toBe('unavailable');
    expect(resolution.status === 'unavailable' ? resolution.reason : '').toContain(
      'catalog exploded',
    );
    expect(runtime.pendingTimers()).toHaveLength(0);
    expect(engineShutdown).toHaveBeenCalledTimes(1);
    expect(await engineShutdown.mock.results[0]?.value).toBe(true);
    // The waiting readers settle last: settled earlier, a live engine commits `unavailable`, which
    // Weft treats as a terminal failure of the run (see the survival test below).
    expect(order).toEqual([
      'agent files closed',
      'asset service shut down',
      'observability disposed',
      'engine shut down',
      'waiters settled',
    ]);
  });
});

describe('a Bureau whose construction fails leaves a reclaimed run resumable (COR-1586)', () => {
  it('leaves the run running under workflow-lease, and a correctly configured boot completes it', async () => {
    const root = await fixtures.scratchDirectory('bureau-reclaim-survival-');
    await using storageFixture = createSqliteStorageFixture({ path: join(root, 'bureau.sqlite') });
    const storagePath = storageFixture.path;
    const { owner, runId } = await startLapsedCatalogRun(storagePath);

    // The composition is taken from the export `createBureau` imports, so the observability handle
    // can be wrapped.
    let captured:
      Awaited<ReturnType<typeof runtimeCompositionModule.createRuntimeComposition>> | undefined;
    const createComposition = runtimeCompositionModule.createRuntimeComposition;
    const compositionSpy = spyOn(
      runtimeCompositionModule,
      'createRuntimeComposition',
    ).mockImplementation(async (...args) => {
      captured = await createComposition(...args);
      return captured;
    });
    fixtures.restoreOnDispose(() => compositionSpy.mockRestore());
    const catalogSpy = spyOn(agentCatalogModule, 'createAgentCatalog').mockImplementation(() => {
      throw new Error('catalog exploded');
    });
    fixtures.restoreOnDispose(() => catalogSpy.mockRestore());
    const assetStorage = createMemoryAssetStorageFixture({});
    fixtures.restoreOnDispose(() => void assetStorage.dispose());

    const hold = fixtures.holdAgentFileScan();
    const diagnostics: BureauDiagnostic[] = [];
    const failing = track(
      hold,
      createBureau<AgentDefinitions>({
        agents: {
          writer: writerAnswering('never runs'),
        },
        agentSource: agentFileDirectory(await fixtures.directoryWithOneAgentFile()),
        models: { generate: constructionWindowGenerate },
        storage: storageFixture.storage,
        durable: true,
        durableOwnership: leaseOptions,
        observability: true,
        assets: { storage: assetStorage.storage, garbageCollectionIntervalMilliseconds: 1_000 },
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      }),
    );
    const outcome = failing.then(
      () => 'built' as const,
      (error: unknown) => error,
    );
    await hold.entered;

    // Observability is disposed after the asset service and before the engine. It waits there until
    // the run is durably `failed`, or until `pollUntil` runs out of attempts. Were the waiting
    // readers already settled, the live engine would commit `unavailable` and the wait would end
    // at once; settled last, nothing has happened to the run and the wait falls through.
    const observability = captured?.durable?.observability;
    if (observability === undefined) throw new Error('Expected durable observability.');
    const composition = captured;
    if (composition === undefined) throw new Error('Expected a composition.');
    const realAbandon = composition.abandonCatalogAgentRunOptionsResolver.bind(composition);
    let settled = false;
    spyOn(composition, 'abandonCatalogAgentRunOptionsResolver').mockImplementation((reason) => {
      settled = true;
      realAbandon(reason);
    });
    const realDispose = observability.dispose.bind(observability);
    let failedBeforeDispose: boolean | undefined;
    spyOn(observability, 'dispose').mockImplementation(async () => {
      // Nothing has settled the parked reader yet, so nothing can have failed the run: go on at
      // once. Settled first (the old order), the live engine commits `failed` within milliseconds
      // and the bounded poll sees it.
      failedBeforeDispose = settled
        ? await pollUntil(async () => {
            const durableRun = await owner.tasks.workflow(runId);
            return durableRun?.status === 'failed';
          })
        : false;
      realDispose();
    });

    // The reclaimed run is parked in a reader.
    expect(
      await pollUntil(() => diagnostics.some((entry) => isParkedDiagnostic(entry, runId))),
    ).toBe(true);
    hold.release();
    const error = await outcome;

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('catalog exploded');
    expect(failedBeforeDispose).toBe(false);
    const afterFailure = await owner.tasks.workflow(runId);
    expect(afterFailure?.status).toBe('running');

    // A correctly configured boot over the same storage resumes the run under its own agent.
    catalogSpy.mockRestore();
    const second = await createBureau<AgentDefinitions>({
      agents: {
        writer: writerAnswering('recovered'),
      },
      storage: storageFixture.open(),
      durable: true,
      durableOwnership: leaseOptions,
    });
    try {
      const state = await second.tasks.wait(runId);
      expect(state?.status).toBe('completed');
      expect(state?.error).toBeUndefined();
    } finally {
      await second.shutdown();
    }
  });

  it('settles a parked run when a step between the composition and the agent file scan throws', async () => {
    const root = await fixtures.scratchDirectory('bureau-reclaim-early-failure-');
    const diagnostics: BureauDiagnostic[] = [];
    let parked: ReturnType<RuntimeComposition['resolveRunServices']> | undefined;

    // A run is parked in a reader as soon as the composition exists, which is before any step that
    // can throw: `createWorkflowTools` runs ahead of the agent file scan.
    const createComposition = runtimeCompositionModule.createRuntimeComposition;
    const compositionSpy = spyOn(
      runtimeCompositionModule,
      'createRuntimeComposition',
    ).mockImplementation(async (...args) => {
      const composition = await createComposition(...args);
      await composition.persistCatalogRunRecoveryRecord('parked-run', {
        agentName: 'writer',
        definitionRevision: 1,
        input: 'go',
      });
      parked = composition.resolveRunServices({
        workflowId: 'parked-run',
        workflowType: 'agentRun',
        input: { runId: 'parked-run', sessionId: 'parked-run', agentName: 'writer' },
      });
      await pollUntil(() => diagnostics.some((entry) => isParkedDiagnostic(entry, 'parked-run')));
      return composition;
    });
    fixtures.restoreOnDispose(() => compositionSpy.mockRestore());
    const toolsSpy = spyOn(workflowToolsModule, 'createWorkflowTools').mockImplementation(() => {
      throw new Error('workflow tools exploded');
    });
    fixtures.restoreOnDispose(() => toolsSpy.mockRestore());

    const outcome = await createBureau<AgentDefinitions>({
      agents: {},
      workflowSource: workflowFileDirectory(
        await fixtures.scratchDirectory('bureau-reclaim-workflows-'),
      ),
      storage: { type: 'sqlite', path: join(root, 'bureau.sqlite') },
      durable: true,
      maintenance: 'manual',
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    }).then(
      () => 'built' as const,
      (error: unknown) => error,
    );

    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toBe('workflow tools exploded');
    if (parked === undefined) throw new Error('Expected a parked reader.');
    const resolution = await parked;
    expect(resolution.status).toBe('unavailable');
    expect(resolution.status === 'unavailable' ? resolution.reason : '').toContain(
      'workflow tools exploded',
    );
  });
});

describe('the recovery-skip listener (COR-1586)', () => {
  it('names its event by Weft’s constant, not by a string that could drift from it', async () => {
    const source = await Bun.file(join(import.meta.dir, 'create-bureau.ts')).text();

    expect(source).not.toContain("'workflow:recovery-skipped'");
    expect(source).toContain('WorkflowRecoverySkippedEvent.type');
  });
});

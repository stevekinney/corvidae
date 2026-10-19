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
import {
  createConstructionWindowFixtures,
  resolveAgentGenerate,
} from './testing/construction-window.test-support';
import { createMemoryAssetStorageFixture } from './test/asset-storage-fixtures';
import { pollUntil } from './testing/goal-fixtures.test-support';
import type { Bureau, BureauDiagnostic } from './types';

const bureaus: Bureau<AgentDefinitions>[] = [];
const fixtures = createConstructionWindowFixtures();

afterEach(async () => {
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

describe('a catalog agent run reclaimed while the Bureau scans its agent files (COR-1586)', () => {
  it('resumes under its own agent once the resolver is wired, and records no error', async () => {
    const root = await fixtures.scratchDirectory('bureau-reclaim-catalog-');
    const storagePath = join(root, 'bureau.sqlite');

    // The owner starts the run and never finishes it. Its background tasks are manual, so its
    // claim is never renewed: it lapses, and a Bureau over the same storage can reclaim the run.
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
      toolbox: createToolbox([]),
      storage: { type: 'sqlite', path: storagePath },
      durableExecution: true,
      stopWhen: stopWhen.noToolCalls(),
      durableBackgroundTasks: 'manual',
      durableOwnership: leaseOptions,
    });
    bureaus.push(owner);
    const run = owner.run('writer', 'go');
    await started.promise;
    const runId = run.id;

    // The successor builds with the agent file scan held, so its engine reclaims the run before
    // `createBureau` has wired the resolver.
    const hold = fixtures.holdAgentFileScan();
    const diagnostics: BureauDiagnostic[] = [];
    const successor = createBureau<AgentDefinitions>({
      agents: {
        writer: createAgent({
          name: 'writer',
          generate: async () => ({ content: 'recovered', toolCalls: [] }),
        }),
      },
      agentDirectory: await fixtures.agentDirectoryWithOneFile(),
      resolveAgentGenerate,
      toolbox: createToolbox([]),
      storage: { type: 'sqlite', path: storagePath },
      durableExecution: true,
      stopWhen: stopWhen.noToolCalls(),
      durableOwnership: leaseOptions,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    await hold.entered;

    // Release the scan only once the reclaim has reached the run: either the run is held for the
    // resolver, which is the behaviour under test, or it has already been failed, which is the
    // defect. Releasing on the first makes the test red on code that does the second.
    const reached = await pollUntil(async () => {
      if (diagnostics.some((entry) => isParkedDiagnostic(entry, runId))) return true;
      const durableRun = await owner.getDurableRun(runId);
      return durableRun?.status === 'failed';
    });
    expect(reached).toBe(true);
    expect(diagnostics.filter((entry) => isParkedDiagnostic(entry, runId))).toHaveLength(1);
    hold.release();
    const built = await successor;
    bureaus.push(built);

    const state = await built.waitForDurableRun(runId);
    expect(state?.error).toBeUndefined();
    expect(state?.status).toBe('completed');
    expect(diagnostics.filter((entry) => entry.level === 'error')).toEqual([]);
  }, 20_000);
});

describe('a named-agent session run reclaimed while the Bureau scans its agent files (COR-1586)', () => {
  it('resumes under its own agent, not the Bureau-wide one', async () => {
    const root = await fixtures.scratchDirectory('bureau-reclaim-session-');
    const storagePath = join(root, 'bureau.sqlite');

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
      },
      generate: async () => ({ content: 'wide never answers', toolCalls: [] }),
      toolbox: createToolbox([next]),
      storage: { type: 'sqlite', path: storagePath },
      durableExecution: true,
      stopWhen: stopWhen.noToolCalls(),
      durableBackgroundTasks: 'manual',
      durableOwnership: leaseOptions,
    });
    bureaus.push(owner);
    const run = await owner.createRun({ message: 'Recover me', agentName: 'scribe' });
    await reachedStepOne.promise;

    const hold = fixtures.holdAgentFileScan();
    const diagnostics: BureauDiagnostic[] = [];
    const wideSteps: number[] = [];
    const wideToolbox = createToolbox([next]);
    const wideExtend = spyOn(wideToolbox, 'extend');
    fixtures.restoreOnDispose(() => wideExtend.mockRestore());
    const successor = createBureau<AgentDefinitions>({
      agents: {
        scribe: createAgent({
          generate: async ({ step }) => ({ content: `scribe resumed at ${step}`, toolCalls: [] }),
          toolbox: createToolbox([next]),
          stopWhen: stopWhen.noToolCalls(),
        }),
      },
      generate: async ({ step }) => {
        wideSteps.push(step);
        return { content: 'wide answered', toolCalls: [] };
      },
      toolbox: wideToolbox,
      agentDirectory: await fixtures.agentDirectoryWithOneFile(),
      resolveAgentGenerate,
      storage: { type: 'sqlite', path: storagePath },
      durableExecution: true,
      stopWhen: stopWhen.noToolCalls(),
      durableOwnership: leaseOptions,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
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
    bureaus.push(built);

    const completed = await pollUntil(async () => {
      const session = await built.getSession(run.sessionId);
      return session?.metadata['lastRunStatus'] === 'completed';
    });
    expect(completed).toBe(true);
    const session = await built.getSession(run.sessionId);
    const replies = (session === undefined ? [] : getMessages(session.conversationHistory))
      .filter((message) => message.role === 'assistant')
      .map((message) => (typeof message.content === 'string' ? message.content : ''));
    expect(replies).toEqual(['scribe step 0', 'scribe resumed at 1']);
    expect(wideSteps).toEqual([]);
    expect(diagnostics.filter((entry) => entry.level === 'error')).toEqual([]);
  }, 20_000);
});

describe('a construction that fails while a run is parked for the resolver (COR-1586)', () => {
  it('settles the run as unavailable, then shuts the Bureau down in order, and rethrows', async () => {
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
    const building = createBureau({
      agents: {},
      agentDirectory: await fixtures.agentDirectoryWithOneFile(),
      resolveAgentGenerate,
      toolbox: createToolbox([]),
      storage: { type: 'sqlite', path: join(root, 'bureau.sqlite') },
      durableExecution: true,
      durableBackgroundTasks: 'manual',
      observability: true,
      stopWhen: stopWhen.noToolCalls(),
      runtime,
      assets: { storage: assetStorage.storage, garbageCollectionIntervalMilliseconds: 1_000 },
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
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
    const realDisposeStorage = composition.disposeStorage;
    if (realDisposeStorage === undefined) throw new Error('Expected storage the Bureau owns.');
    spyOn(composition, 'disposeStorage').mockImplementation(() => {
      order.push('storage disposed');
      realDisposeStorage();
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
    expect(order).toEqual([
      'waiters settled',
      'agent files closed',
      'asset service shut down',
      'observability disposed',
      'engine shut down',
      'storage disposed',
    ]);
  }, 20_000);
});

describe('the recovery-skip listener (COR-1586)', () => {
  it('names its event by Weft’s constant, not by a string that could drift from it', async () => {
    const source = await Bun.file(join(import.meta.dir, 'create-bureau.ts')).text();

    expect(source).not.toContain("'workflow:recovery-skipped'");
    expect(source).toContain('WorkflowRecoverySkippedEvent.type');
  });
});

/**
 * COR-1731 — `bureau.internals.diagnostics()`: one test per field of the reading, over a real
 * Bureau. The reading is synchronous, so each test reads it directly after the state it checks.
 */
import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import {
  createAgent,
  createAgentSession,
  createSessionStore,
  stopWhen,
} from '@lostgradient/operative';
import { MemoryStorage, textValueStore } from '@lostgradient/storage';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { createToolbox } from 'armorer';
import { createConversationHistory } from 'conversationalist';
import { afterEach, describe, expect, it, spyOn } from 'bun:test';

import type { AgentDefinitions } from './agent-catalog';
import { createBureau } from './create-bureau';
import { createRuntimeComposition } from './runtime-composition';
import { approvalToolbox, chargesOnce } from './http/management/management-fixtures.test-support';
import { createMemoryDefinitionSource } from './testing/memory-definition-source.test-support';
import type { Bureau } from './types';

const ORIGIN = '2026-10-29T00:00:00.000Z';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const idleGenerate = async () => ({ content: 'Done.', toolCalls: [] });

async function open(
  options: Partial<Parameters<typeof createBureau<AgentDefinitions>>[0]> = {},
): Promise<Bureau<AgentDefinitions>> {
  const bureau = await createBureau<AgentDefinitions>({
    agents: { default: createAgent({ generate: idleGenerate, toolbox: createToolbox([]) }) },
    // The failures these tests provoke are asserted through the reading, not the console.
    onDiagnostic: () => undefined,
    ...options,
  });
  cleanups.push(() => bureau.dispose());
  return bureau;
}

/** A Bureau with the durable engine's prototype `recoverAll` replaced, as the recovery tests do. */
async function engineRecoverAll() {
  const probe = await createRuntimeComposition({
    generate: idleGenerate,
    toolbox: createToolbox([]),
    storage: new MemoryStorage(),
    durable: true,
  });
  const prototype = Object.getPrototypeOf(probe.durable!.engine) as {
    recoverAll: () => Promise<unknown[]>;
  };
  probe.durable!.engine[Symbol.dispose]?.();
  return prototype;
}

describe('bureau.internals.diagnostics()', () => {
  it('reads synchronously', async () => {
    const bureau = await open();

    const reading = bureau.internals.diagnostics();

    expect(reading).not.toBeInstanceOf(Promise);
    expect(Object.keys(reading).toSorted()).toEqual([
      'abortingRunCount',
      'eventFeedSubscriberCount',
      'lifecycle',
      'liveFrameSubscriberCount',
      'modelCatalogRevision',
      'pendingReviewCount',
      'recovery',
      'runningRunCount',
      'watchers',
    ]);
  });

  describe('recovery', () => {
    it('is clean with no failed runs on a clean boot', async () => {
      const bureau = await open({ storage: new MemoryStorage(), durable: true });

      expect(bureau.internals.diagnostics().recovery).toEqual({
        status: 'clean',
        failedRunCount: 0,
      });
    });

    it('is failed when recoverAll itself throws', async () => {
      const prototype = await engineRecoverAll();
      const spy = spyOn(prototype, 'recoverAll').mockRejectedValue(new Error('unavailable'));
      try {
        const bureau = await open({ storage: new MemoryStorage(), durable: true });

        expect(bureau.internals.diagnostics().recovery).toEqual({
          status: 'failed',
          failedRunCount: 0,
        });
      } finally {
        spy.mockRestore();
      }
    });

    it('is partial and counts the runs recovery cancelled', async () => {
      const prototype = await engineRecoverAll();
      const spy = spyOn(prototype, 'recoverAll').mockResolvedValue([
        { id: 'corrupted-one', getLaunchMetadata: async () => undefined },
        { id: 'corrupted-two', getLaunchMetadata: async () => undefined },
      ]);
      try {
        const bureau = await open({ storage: new MemoryStorage(), durable: true });

        expect(bureau.internals.diagnostics().recovery).toEqual({
          status: 'partial',
          failedRunCount: 2,
        });
      } finally {
        spy.mockRestore();
      }
    });

    it('is pending while a deferred recovery waits for the authority validator, then settles', async () => {
      const storage = new MemoryStorage();
      await createSessionStore(textValueStore(storage)).save(
        createAgentSession({
          id: 'deferred-diagnostics',
          agentName: 'default',
          conversationHistory: createConversationHistory({ id: 'deferred-diagnostics' }),
          metadata: {
            lastRunId: 'run-deferred-diagnostics',
            lastRunStatus: 'running',
            lastRequestAuthorities: {
              'run-deferred-diagnostics': {
                principalId: 'api-key:deferred',
                tenantId: 'bureau',
                ownerId: 'bureau',
                capabilities: ['tools:execute'],
                authorizationRevision: 'gateway:api-key:deferred',
              },
            },
          },
        }),
      );
      const prototype = await engineRecoverAll();
      const spy = spyOn(prototype, 'recoverAll').mockRejectedValue(new Error('unavailable'));
      try {
        const bureau = await open({ storage, durable: true });
        expect(bureau.internals.diagnostics().recovery).toEqual({
          status: 'pending',
          failedRunCount: 0,
        });

        bureau.setRequestAuthorityValidator(() => true);
        await bureau.recovery();

        expect(bureau.internals.diagnostics().recovery).toEqual({
          status: 'failed',
          failedRunCount: 0,
        });
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('lifecycle', () => {
    it('is ready while serving and stopped after dispose', async () => {
      const bureau = await open();
      expect(bureau.internals.diagnostics().lifecycle).toBe('ready');

      await bureau.dispose();

      expect(bureau.internals.diagnostics().lifecycle).toBe('stopped');
    });
  });

  describe('liveFrameSubscriberCount', () => {
    it('counts frames listeners until each unsubscribes, once however often it is called', async () => {
      const bureau = await open();
      expect(bureau.internals.diagnostics().liveFrameSubscriberCount).toBe(0);

      const first = bureau.frames(() => undefined);
      const second = bureau.frames(() => undefined);
      expect(bureau.internals.diagnostics().liveFrameSubscriberCount).toBe(2);

      first();
      first();
      expect(bureau.internals.diagnostics().liveFrameSubscriberCount).toBe(1);
      second();
      expect(bureau.internals.diagnostics().liveFrameSubscriberCount).toBe(0);
    });
  });

  describe('eventFeedSubscriberCount', () => {
    it('counts live subscriptions of the event feed until they end', async () => {
      const bureau = await open();
      const { eventFeed } = bureau.internals;
      expect(bureau.internals.diagnostics().eventFeedSubscriberCount).toBe(0);

      const controller = new AbortController();
      const subscription = eventFeed.feed.subscribe({ signal: controller.signal });
      const iterator = subscription[Symbol.asyncIterator]();
      const pending = iterator.next();
      expect(bureau.internals.diagnostics().eventFeedSubscriberCount).toBe(1);

      controller.abort();
      await pending;
      expect(bureau.internals.diagnostics().eventFeedSubscriberCount).toBe(0);
    });
  });

  describe('watchers', () => {
    it('is empty when no definition source is configured', async () => {
      const bureau = await open();

      expect(bureau.internals.diagnostics().watchers).toEqual([]);
    });

    it('reports the last scan time and error message of each source, agents first', async () => {
      const runtime = createManualRuntimeServices({ origin: ORIGIN });
      const agentSource = createMemoryDefinitionSource('agent', { tools: {} });
      const workflowSource = createMemoryDefinitionSource('workflow');
      const bureau = await open({
        runtime,
        storage: new MemoryStorage(),
        durable: true,
        maintenance: 'manual',
        agentSource: agentSource.source,
        workflowSource: workflowSource.source,
        models: { generate: () => idleGenerate },
      });
      await bureau.workflows?.refresh();
      const booted = Date.parse(ORIGIN);

      expect(bureau.internals.diagnostics().watchers).toEqual([
        { source: 'agents', lastScanAt: booted, lastScanError: null },
        { source: 'workflows', lastScanAt: booted, lastScanError: null },
      ]);

      await runtime.advance(2_000);
      agentSource.failNextLoad(new Error('agent directory unreadable'));
      await bureau.agents.refresh();
      expect(bureau.internals.diagnostics().watchers).toEqual([
        {
          source: 'agents',
          lastScanAt: booted + 2_000,
          lastScanError: 'agent directory unreadable',
        },
        { source: 'workflows', lastScanAt: booted, lastScanError: null },
      ]);

      // Less than the repair delay, so the agents' failed scan is not yet rescanned.
      await runtime.advance(300);
      workflowSource.failNextLoad(new Error('workflow directory unreadable'));
      await bureau.workflows?.refresh();
      expect(bureau.internals.diagnostics().watchers).toEqual([
        {
          source: 'agents',
          lastScanAt: booted + 2_000,
          lastScanError: 'agent directory unreadable',
        },
        {
          source: 'workflows',
          lastScanAt: booted + 2_300,
          lastScanError: 'workflow directory unreadable',
        },
      ]);
    });

    it('carries the message of a failure and never its stack', async () => {
      const agentSource = createMemoryDefinitionSource('agent', { tools: {} });
      const bureau = await open({
        agentSource: agentSource.source,
        models: { generate: () => idleGenerate },
      });
      agentSource.failNextLoad(new Error('disk gone'));
      await bureau.agents.refresh();

      const [watcher] = bureau.internals.diagnostics().watchers;

      expect(watcher?.lastScanError).toBe('disk gone');
      expect(JSON.stringify(bureau.internals.diagnostics())).not.toContain('    at ');
    });
  });

  describe('modelCatalogRevision', () => {
    it('is 1 at boot and follows each replace', async () => {
      const bureau = await open();
      expect(bureau.internals.diagnostics().modelCatalogRevision).toBe(1);

      await bureau.models.replace(bureau.models.catalog().descriptors);

      expect(bureau.internals.diagnostics().modelCatalogRevision).toBe(2);
    });
  });

  describe('runningRunCount and abortingRunCount', () => {
    it('counts a run while it executes, and while its cancellation has not settled', async () => {
      const generating = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const bureau = await open({
        agents: {
          default: createAgent({
            // Ignores the abort signal, so the run is aborting until `release` settles.
            generate: async () => {
              generating.resolve();
              await release.promise;
              return { content: 'Done.', toolCalls: [] };
            },
            toolbox: createToolbox([]),
            stopWhen: stopWhen.noToolCalls(),
          }),
        },
      });
      expect(bureau.internals.diagnostics()).toMatchObject({
        runningRunCount: 0,
        abortingRunCount: 0,
      });

      const run = await bureau.tasks.start('default', 'go');
      await generating.promise;
      expect(bureau.internals.diagnostics()).toMatchObject({
        runningRunCount: 1,
        abortingRunCount: 0,
      });

      await bureau.tasks.cancel(run.id);
      expect(bureau.internals.diagnostics().abortingRunCount).toBe(1);

      release.resolve();
      await waitUntil(() => bureau.internals.diagnostics().abortingRunCount === 0);
      await waitUntil(() => bureau.internals.diagnostics().runningRunCount === 0);
    });
  });

  describe('pendingReviewCount', () => {
    it('counts a review awaiting a decision until it is decided', async () => {
      const charges: number[] = [];
      const bureau = await open({
        agents: {
          default: createAgent({
            generate: chargesOnce,
            toolbox: approvalToolbox(charges),
            stopWhen: stopWhen.some(stopWhen.pendingApproval(), stopWhen.noToolCalls()),
          }),
        },
      });
      expect(bureau.internals.diagnostics().pendingReviewCount).toBe(0);

      await bureau.tasks.start('default', 'charge');
      await waitUntil(() => bureau.reviews.list().length === 1);
      expect(bureau.internals.diagnostics().pendingReviewCount).toBe(1);

      const [review] = bureau.reviews.list();
      await bureau.reviews.resolve({
        id: review!.id,
        decision: 'deny',
        principal: 'anonymous:local',
      });
      expect(bureau.internals.diagnostics().pendingReviewCount).toBe(0);
    });
  });

  it('names no run, review, or agent and carries only counts, statuses, and timestamps', async () => {
    const charges: number[] = [];
    const bureau = await open({
      agents: {
        default: createAgent({
          generate: chargesOnce,
          toolbox: approvalToolbox(charges),
          stopWhen: stopWhen.some(stopWhen.pendingApproval(), stopWhen.noToolCalls()),
        }),
      },
    });
    const run = await bureau.tasks.start('default', 'charge');
    await waitUntil(() => bureau.reviews.list().length === 1);

    const serialized = JSON.stringify(bureau.internals.diagnostics());

    expect(serialized).not.toContain(run.id);
    expect(serialized).not.toContain('default');
    expect(serialized).not.toContain('charge');
  });
});

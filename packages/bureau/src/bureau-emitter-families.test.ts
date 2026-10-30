/**
 * COR-1721 — each new event family reaches a real Bureau's emitter, and its event feed, from the
 * point its projection, callback, or write runs.
 */
import {
  createGovernedMemory,
  createInMemoryMemoryRecordStorage,
  createMemoryGovernanceLedger,
  createMemoryGovernancePolicy,
  createMockEmbedder,
  type GovernedMemory,
} from '@lostgradient/memory';
import { createAgent, type GenerateFunction, stopWhen } from '@lostgradient/operative';
import { MemoryStorage } from '@lostgradient/storage';
import { ScheduleMissedFireEvent } from '@lostgradient/weft';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { createToolbox } from 'armorer';
import { afterEach, describe, expect, it, jest, setSystemTime, spyOn } from 'bun:test';

import type { AgentDefinitions } from './agent-catalog';
import { createBureau } from './create-bureau';
import {
  AssetLifecycleEvent,
  DefinitionsChangedEvent,
  DiagnosticEvent,
  GoalLifecycleEvent,
  ScheduleMissedEvent,
  TaskCleanupAcknowledgedEvent,
} from './events';
import { validAgentFile } from './testing/agent-file-fixtures.test-support';
import { startFileBureau } from './testing/agent-file-bureau.test-support';
import {
  answering,
  cancelUntilSettled,
  createCheckValidator,
  createTestDatabase,
  createUnsetTestDatabase,
  goalRequest,
  hangUntilAborted,
  pollUntil,
  TERMINAL_STATUSES,
  type TestDatabase,
  workerAgent,
} from './testing/goal-fixtures.test-support';
import type { BureauDiagnostic } from './types';

const cleanups: Array<() => Promise<void> | void> = [];
let database: TestDatabase = createUnsetTestDatabase();

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
  await database.remove();
});

const parkUntilAborted: GenerateFunction = ({ signal }) => {
  const parked = Promise.withResolvers<never>();
  signal?.addEventListener('abort', () => parked.reject(signal.reason), { once: true });
  return parked.promise;
};

describe('goal events on the bureau emitter', () => {
  it('dispatches each live transition, and nothing for the boot pass that re-projects history', async () => {
    database = createTestDatabase('cor-1721-goals');
    const boot = async (seen: Event[]) =>
      createBureau({
        agents: { worker: workerAgent(answering('done')) },
        validators: [createCheckValidator()],
        storage: database.open(),
        durable: true,
        durableOwnership: { ownership: 'none' },
        onEvent: (event) => {
          if (event.type.startsWith('goal.')) seen.push(event);
        },
      });

    const live: Event[] = [];
    const first = await boot(live);
    try {
      await first.goals.create(goalRequest());
      await pollUntil(async () => {
        const goal = await first.goals.get('g1');
        const status = goal?.status;
        return status !== undefined && (TERMINAL_STATUSES as readonly string[]).includes(status);
      });
    } finally {
      await first.dispose();
    }

    expect(live.every((event) => event instanceof GoalLifecycleEvent)).toBe(true);
    expect(live.map((event) => event.type)).toEqual([
      'goal.started',
      'goal.attempt.started',
      'goal.attempt.evaluating',
      'goal.attempt.validated',
      'goal.succeeded',
    ]);
    expect((live[0] as GoalLifecycleEvent).payload).toEqual({
      goalRunId: 'g1',
      goalIdentity: { name: 'goal', version: '1' },
    });

    const replayed: Event[] = [];
    const second = await boot(replayed);
    try {
      await second.recovery();
      expect(replayed).toEqual([]);
    } finally {
      await second.dispose();
    }
  });
});

describe('a canceled goal on the bureau emitter', () => {
  it('dispatches goal.canceled once, though the host and the controller both commit it', async () => {
    database = createTestDatabase('cor-1721-goal-cancel');
    const canceled: Event[] = [];
    const bureau = await createBureau({
      agents: { worker: workerAgent(hangUntilAborted) },
      validators: [createCheckValidator()],
      storage: database.open(),
      durable: true,
      durableOwnership: { ownership: 'none' },
      onEvent: (event) => {
        if (event.type === 'goal.canceled') canceled.push(event);
      },
    });
    cleanups.push(() => bureau.dispose());
    await bureau.goals.create(goalRequest());
    await pollUntil(async () => {
      const goal = await bureau.goals.get('g1');
      return goal?.status === 'running';
    });

    await cancelUntilSettled(bureau as never);
    await pollUntil(async () => {
      const goal = await bureau.goals.get('g1');
      return goal?.status === 'canceled';
    });
    await bureau.dispose();

    expect(canceled).toHaveLength(1);
  });
});

describe('diagnostic events on the bureau emitter', () => {
  it('dispatches a diagnostic with its level and scope, and a diagnostic raised by its own dispatch reaches the sink only', async () => {
    const sunk: BureauDiagnostic[] = [];
    const seen: Event[] = [];
    const bureau = await createBureau<AgentDefinitions>({
      agents: {},
      onDiagnostic: (diagnostic) => sunk.push(diagnostic),
      // Throws on every event, so the diagnostic its first failure raises fails it again.
      onEvent: (event) => {
        seen.push(event);
        throw new Error(`MESSAGE-listener-failed-on-${event.type}`);
      },
    });
    await bureau.dispose();

    const diagnostics = seen.filter((event) => event instanceof DiagnosticEvent);
    const failures = sunk.filter((diagnostic) => diagnostic.scope === 'events');
    // One failure on `bureau.disposed`, one on the `diagnostic` that failure dispatched.
    expect(failures).toHaveLength(2);
    expect(diagnostics).toHaveLength(1);
    expect({ level: diagnostics[0]?.level, scope: diagnostics[0]?.scope }).toEqual({
      level: 'error',
      scope: 'events',
    });
    expect(JSON.stringify(diagnostics[0])).not.toContain('MESSAGE-');
  });
});

describe('diagnostic events from a listener that rejects', () => {
  it('reports a rejection on a diagnostic event to the sink only, so it cannot loop', async () => {
    const sunk: BureauDiagnostic[] = [];
    const seen: Event[] = [];
    const bureau = await createBureau<AgentDefinitions>({
      agents: {
        default: createAgent({
          generate: async () => ({ content: 'ok', toolCalls: [] }),
          toolbox: createToolbox([]),
          stopWhen: stopWhen.noToolCalls(),
        }),
      },
      onDiagnostic: (diagnostic) => sunk.push(diagnostic),
      // Rejects on every event, so each failure is reported a microtask after its dispatch
      // returned, outside the dispatcher's re-entrancy guard.
      onEvent: async (event) => {
        seen.push(event);
        throw new Error(`MESSAGE-listener-rejected-on-${event.type}`);
      },
    });
    cleanups.push(() => bureau.dispose());
    const onDiagnostics = () =>
      sunk.filter((diagnostic) => diagnostic.message.includes('on a "diagnostic" event'));
    const diagnosticEvents = () => seen.filter((event) => event instanceof DiagnosticEvent);

    await bureau.tasks.start('default', 'go');
    await waitUntil(() => onDiagnostics().length > 0);
    await bureau.dispose();
    await waitUntil(() => onDiagnostics().length === diagnosticEvents().length);

    // Each diagnostic event's own failure was reported once and dispatched as nothing, so every
    // diagnostic event answers the failure on one other event.
    const others = seen.filter((event) => !(event instanceof DiagnosticEvent));
    expect(diagnosticEvents().length).toBeGreaterThan(0);
    expect(diagnosticEvents().length).toBeLessThanOrEqual(others.length);
    expect(onDiagnostics()).toHaveLength(diagnosticEvents().length);
  });
});

describe('task cleanup acknowledgements on the bureau emitter', () => {
  it('dispatches the cleanup state a canceled task’s record now holds', async () => {
    const generating = Promise.withResolvers<void>();
    const bureau = await createBureau<AgentDefinitions>({
      agents: {
        default: createAgent({
          generate: (input) => {
            generating.resolve();
            return parkUntilAborted(input);
          },
          toolbox: createToolbox([]),
          stopWhen: stopWhen.noToolCalls(),
        }),
      },
    });
    cleanups.push(() => bureau.dispose());
    const acknowledged: TaskCleanupAcknowledgedEvent[] = [];
    bureau.addEventListener(TaskCleanupAcknowledgedEvent.type, (event) => acknowledged.push(event));
    const run = await bureau.tasks.start('default', 'go');
    await generating.promise;

    await bureau.tasks.cancel(run.id);
    await waitUntil(() => acknowledged.length > 0);

    expect(acknowledged.map(({ taskId, cleanup }) => ({ taskId, cleanup }))).toEqual([
      { taskId: run.id, cleanup: 'cleaned-up' },
    ]);
    const task = await bureau.tasks.get(run.id);
    expect(task?.cleanup).toBe('cleaned-up');
  });
});

describe('agent definition and asset events on the bureau emitter', () => {
  it('reports agent file changes, with invalid files rejected, and forwards upload events', async () => {
    const harness = await startFileBureau();
    cleanups.push(() => harness.dispose());
    const changes: DefinitionsChangedEvent[] = [];
    const assets: AssetLifecycleEvent[] = [];
    harness.bureau.addEventListener(DefinitionsChangedEvent.type, (event) => changes.push(event));
    harness.bureau.addEventListener('asset.upload.started', (event) => assets.push(event));

    await harness.put('helper.md', validAgentFile());
    await harness.put('broken.md', 'not an agent file');
    await harness.bureau.agents.refresh();
    await waitUntil(() =>
      changes.some((change) => change.added.includes('helper') && change.added.includes('broken')),
    );

    const change = changes.find((candidate) => candidate.added.includes('broken'));
    expect(change?.source).toBe('agents');
    expect(change?.rejected).toEqual(['broken']);

    const assetService = harness.bureau.assets;
    if (assetService === undefined) throw new Error('the harness has an asset service');
    const session = await assetService.beginUpload({ id: 'alice' }, { declaredByteLength: 4 });
    expect(assets).toHaveLength(1);
    expect(assets[0]).toMatchObject({
      type: 'asset.upload.started',
      uploadId: session.uploadId,
      principal: 'alice',
    });
  });
});

describe('missed schedule fires on the bureau emitter', () => {
  it('reports occurrences a schedule was too late for', async () => {
    const bureau = await createBureau<AgentDefinitions>({
      agents: {
        default: createAgent({
          generate: async () => ({ content: 'ok', toolCalls: [] }),
          toolbox: createToolbox([]),
          stopWhen: stopWhen.noToolCalls(),
        }),
      },
      storage: new MemoryStorage(),
      durable: true,
      maintenance: 'manual',
    });
    cleanups.push(() => bureau.dispose());
    const missed: ScheduleMissedEvent[] = [];
    bureau.addEventListener(ScheduleMissedEvent.type, (event) => missed.push(event));
    const summary = await bureau.schedules.create({
      agentName: 'default',
      input: 'tick',
      spec: '1m',
    });
    const scheduleId = summary?.id;

    // Ten minutes late for its first occurrence: the engine reads the system clock, and skips the
    // ten occurrences it missed instead of backfilling them.
    const createdAt = Date.now();
    setSystemTime(new Date(createdAt + 10 * 60_000));
    try {
      await bureau.maintain(Date.now());
    } finally {
      setSystemTime();
    }
    await waitUntil(() => missed.length > 0);

    expect(missed).toHaveLength(1);
    expect(missed[0]?.scheduleId).toBe(scheduleId);
    expect(missed[0]?.missedCount).toBe(10);
    expect(missed[0]?.reason).toBe('late');
    expect(summary?.nextFireAt).toBe(missed[0]?.windowStart);
    expect(missed[0]?.windowEnd).toBeGreaterThanOrEqual(missed[0]?.windowStart ?? Infinity);
    const stored = await bureau.schedules.get(scheduleId ?? '');
    expect(stored?.missedFireCount).toBe(10);
  });
});

describe('a missed fire found while the Bureau is still being built', () => {
  it('is reported once construction finishes, though the first poll ran before the composition returned', async () => {
    database = createTestDatabase('cor-1721-missed-boot');
    const options = {
      id: 'missed-boot-bureau',
      agents: {
        default: createAgent({
          generate: async () => ({ content: 'ok', toolCalls: [] }),
          toolbox: createToolbox([]),
          stopWhen: stopWhen.noToolCalls(),
        }),
      },
      storage: database.open(),
      durable: true,
      durableOwnership: { ownership: 'none' as const },
    };
    const first = await createBureau<AgentDefinitions>(options);
    const created = await first.schedules.create({
      agentName: 'default',
      input: 'tick',
      spec: '1m',
    });
    const scheduleId = created?.id;
    await first.dispose();

    // Memory initialization is awaited after the engine, and its poller, exist. Holding it open
    // keeps the composition unfinished while the poll runs.
    const initializing = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const base = createGovernedMemory({
      storage: createInMemoryMemoryRecordStorage(),
      ledger: createMemoryGovernanceLedger(new MemoryStorage()),
      embedder: createMockEmbedder(64),
      policy: createMemoryGovernancePolicy({ revision: 'governance:cor-1721' }),
    });
    const memory: GovernedMemory = Object.assign(Object.create(base) as GovernedMemory, {
      init: async () => {
        initializing.resolve();
        await release.promise;
        await base.init();
      },
    });
    const engineReported = Promise.withResolvers<void>();
    const dispatchEvent = EventTarget.prototype.dispatchEvent;
    const spy = spyOn(EventTarget.prototype, 'dispatchEvent').mockImplementation(function (
      this: EventTarget,
      event: Event,
    ) {
      if (event instanceof ScheduleMissedFireEvent) engineReported.resolve();
      return dispatchEvent.call(this, event);
    });
    cleanups.push(() => spy.mockRestore());
    const missed: ScheduleMissedEvent[] = [];
    jest.useFakeTimers();
    // Ten minutes late for its first occurrence, as a restart after downtime finds it.
    setSystemTime(new Date(Date.now() + 10 * 60_000));
    try {
      const booting = createBureau<AgentDefinitions>({
        ...options,
        memory,
        onEvent: (event) => {
          if (event instanceof ScheduleMissedEvent) missed.push(event);
        },
      });
      await initializing.promise;
      jest.advanceTimersByTime(1_000);
      await engineReported.promise;
      release.resolve();
      const bureau = await booting;
      cleanups.push(() => bureau.dispose());
      jest.useRealTimers();
      await waitUntil(() => missed.length > 0);
    } finally {
      jest.useRealTimers();
      setSystemTime();
    }

    expect(missed).toHaveLength(1);
    expect(missed[0]?.scheduleId).toBe(scheduleId);
    expect(missed[0]?.missedCount).toBe(10);
  });
});

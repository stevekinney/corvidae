/**
 * COR-1585 — nothing `createBureau` registers may read state that is still uninitialised.
 *
 * `createBureau` awaits at the top level a few times while it builds the Bureau: the agent file
 * scan (`await fileAgents?.files.refresh()`) and the audit sequence seed (inside `if (runtime.kv)`)
 * are the two that run in practice. A listener or timer registered before one of them can fire
 * during it, while every `let` and `const` declared after it is still in its temporal dead zone.
 * These tests hold each of those two awaits open and fire what was registered before it.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createManualRuntimeServices, TypedEventTarget } from '@lostgradient/lifecycle';
import { createStore, type GenerateFunction, stopWhen } from '@lostgradient/operative';
import { MemoryStorage, textValueStore, type ConditionalTextValueStore } from '@lostgradient/weft';
import { createTool, createToolbox } from 'armorer';
import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { z } from 'zod';

import { nodeAgentFileOperations } from './agent-file-operations';
import { createBureau } from './create-bureau';
import { agentFileText, KNOWN_MODEL } from './testing/agent-file-fixtures.test-support';
import { pollUntil } from './testing/goal-fixtures.test-support';
import type { Bureau, BureauDiagnostic } from './types';

const bureaus: Bureau[] = [];
const directories: string[] = [];
const restores: Array<() => void> = [];

afterEach(async () => {
  for (const restore of restores.splice(0)) restore();
  for (const bureau of bureaus.splice(0)) await bureau.shutdown();
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

const nextTool = createTool({
  name: 'next',
  description: 'continue',
  input: z.object({}),
  execute: async () => 'ok',
});

/** A directory holding one valid agent file, so the construction-time scan reads a file. */
async function agentDirectoryWithOneFile(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'bureau-construction-window-'));
  directories.push(directory);
  await writeFile(
    join(directory, 'helper.md'),
    agentFileText({ name: 'Helper', model: KNOWN_MODEL }),
  );
  return directory;
}

/**
 * Hold the agent file scan open: the first file read does not return until `release()`. The scan
 * is the `await fileAgents?.files.refresh()` in `createBureau`, so a Bureau under construction is
 * parked there for as long as the test needs, with no timing involved.
 */
function holdAgentFileScan(): { entered: Promise<void>; release: () => void } {
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  const read = nodeAgentFileOperations.read.bind(nodeAgentFileOperations);
  const spy = spyOn(nodeAgentFileOperations, 'read').mockImplementation(async (path) => {
    entered.resolve();
    await released.promise;
    return read(path);
  });
  restores.push(() => spy.mockRestore());
  return { entered: entered.promise, release: () => released.resolve() };
}

const resolveAgentGenerate = (): GenerateFunction => async () => ({
  content: 'answer',
  toolCalls: [],
});

describe('a session commit while the agent files are being scanned (COR-1585)', () => {
  it('records no diagnostic, and its outbox entry is drained by the time the Bureau is built', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bureau-construction-commit-'));
    directories.push(root);
    const storagePath = join(root, 'bureau.sqlite');
    const leaseOptions = {
      ownership: 'workflow-lease',
      workflowClaimTtlMs: 200,
      workflowClaimRenewIntervalMs: 50,
    } as const;

    // The owner reaches step 1 and then stops: its claim is never renewed, so it lapses, and its
    // session is left `running`.
    const reachedStepOne = Promise.withResolvers<void>();
    const owner = await createBureau({
      agents: {},
      generate: async ({ step }) => {
        if (step === 0) return { content: 'step 0', toolCalls: [{ name: 'next', arguments: {} }] };
        reachedStepOne.resolve();
        return new Promise<never>(() => {});
      },
      toolbox: createToolbox([nextTool]),
      storage: { type: 'sqlite', path: storagePath },
      durableExecution: true,
      stopWhen: stopWhen.noToolCalls(),
      durableBackgroundTasks: 'manual',
      durableOwnership: leaseOptions,
    });
    bureaus.push(owner);
    const run = await owner.createRun({ message: 'go' });
    await reachedStepOne.promise;

    // The successor has no `generate`, so it cannot rebuild the run's session and reconciles the
    // session to `error` when the engine reclaims the run. That is a session commit, made by the
    // engine's reclaim while the Bureau is parked in the agent file scan.
    const hold = holdAgentFileScan();
    const diagnostics: BureauDiagnostic[] = [];
    const successor = createBureau({
      agents: {},
      agentDirectory: await agentDirectoryWithOneFile(),
      resolveAgentGenerate,
      toolbox: createToolbox([nextTool]),
      storage: { type: 'sqlite', path: storagePath },
      durableExecution: true,
      stopWhen: stopWhen.noToolCalls(),
      durableOwnership: leaseOptions,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    await hold.entered;
    const committed = await pollUntil(async () => {
      const session = await owner.getSession(run.sessionId);
      return session?.metadata['lastRunStatus'] === 'error';
    });
    expect(committed).toBe(true);
    const outbox = await owner.kv?.list('agent-session-outbox:v1:entry:');
    expect(outbox?.length).toBeGreaterThan(0);

    hold.release();
    bureaus.push(await successor);

    expect(diagnostics.filter((entry) => entry.scope === 'durable-maintenance')).toEqual([]);
    expect(diagnostics.map((entry) => entry.message).join('\n')).not.toContain(
      'before initialization',
    );
    expect(await owner.kv?.list('agent-session-outbox:v1:entry:')).toEqual([]);
  });
});

/** Every listener a Bureau under construction registers on a composition event target. */
function captureCompositionListeners(): Array<{ type: string; listener: (event: Event) => void }> {
  const interesting = new Set([
    'schedule.completed',
    'schedule.failed',
    'schedule.attempted',
    'schedule.skipped',
    'skill.loaded',
    'skill.activated',
    'skill.deactivated',
    'skill.rejected',
    'skill.failed',
    'session.outbox-appended',
  ]);
  const captured: Array<{ type: string; listener: (event: Event) => void }> = [];
  const add = TypedEventTarget.prototype.addEventListener;
  const spy = spyOn(TypedEventTarget.prototype, 'addEventListener').mockImplementation(function (
    this: TypedEventTarget<never>,
    type: string,
    listener: unknown,
    options?: unknown,
  ) {
    if (interesting.has(type) && typeof listener === 'function') {
      captured.push({ type, listener: listener as (event: Event) => void });
    }
    return (add as (...args: unknown[]) => unknown).call(this, type, listener, options);
  } as never);
  restores.push(() => spy.mockRestore());
  return captured;
}

/** The fields the forwarding listeners read, on an event of the given type. */
function eventOf(type: string): Event {
  return Object.assign(new Event(type), {
    scheduleId: 'schedule-1',
    runId: 'run-1',
    occurrence: 1,
    policy: 'skip',
    blockingRunId: 'run-2',
    skillName: 'skill-1',
    correlation: undefined,
    reason: 'because',
    rule: 'rule-1',
    ordinal: 0,
  });
}

describe('every listener and timer registered before a top-level await (COR-1585)', () => {
  it('can fire during the agent file scan and the audit sequence seed without reading uninitialised state', async () => {
    const captured = captureCompositionListeners();
    const failures: string[] = [];
    const fireCaptured = (): void => {
      for (const { type, listener } of captured) {
        try {
          listener(eventOf(type));
        } catch (error) {
          failures.push(`${type}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    };

    // The agent file scan: held until released.
    const scan = holdAgentFileScan();
    // The audit sequence seed lists `audit:v1:` before anything else reads it: held until released.
    const seedEntered = Promise.withResolvers<void>();
    const seedReleased = Promise.withResolvers<void>();
    const base = textValueStore(new MemoryStorage());
    const persistence: ConditionalTextValueStore = {
      ...base,
      list: async (prefix) => {
        if (prefix === 'audit:v1:') {
          seedEntered.resolve();
          await seedReleased.promise;
        }
        return base.list(prefix);
      },
    };
    const runtime = createManualRuntimeServices({ origin: '2026-10-19T00:00:00.000Z' });
    const store = createStore({ runtime });
    const diagnostics: BureauDiagnostic[] = [];
    const building = createBureau({
      agents: {},
      agentDirectory: await agentDirectoryWithOneFile(),
      resolveAgentGenerate,
      toolbox: createToolbox([nextTool]),
      persistence,
      auditRetention: { olderThan: 86_400_000 },
      store,
      runtime,
      stopWhen: stopWhen.noToolCalls(),
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });

    // During the agent file scan: every listener registered so far, fired.
    await scan.entered;
    fireCaptured();
    scan.release();

    // During the audit sequence seed: the same listeners again, a store event for the store's
    // subscriber, and the maintenance timer, advanced past its interval.
    await seedEntered.promise;
    fireCaptured();
    store.recordAction('run-1', 'step.completed', {});
    // The 5-minute maintenance interval is armed by now; advancing past it fires it.
    expect(runtime.pendingTimers().length).toBeGreaterThan(0);
    await runtime.advance(300_000);
    seedReleased.resolve();
    bureaus.push(await building);
    await runtime.deferred.drain();

    // And once construction is over.
    fireCaptured();
    await runtime.deferred.drain();

    // All ten listeners were registered, and so were fired at least once.
    expect(new Set(captured.map((entry) => entry.type)).size).toBe(10);
    expect(failures).toEqual([]);
    expect(diagnostics.filter((entry) => entry.level === 'error')).toEqual([]);
  });
});
